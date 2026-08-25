/**
 * Thumb-impression detection — blob, geometry and ink colour only.
 *
 * NO RIDGE ANALYSIS, AND THAT IS A DECISION RATHER THAN AN OMISSION.
 *
 * The tempting design measures friction-ridge frequency. Human ridge spacing is
 * a physical constant, roughly 0.4-0.6 mm, so a Gabor bank or a radial FFT
 * tuned to that band ought to identify a thumbprint definitively and reject
 * everything else. It is elegant, it is well-founded, and on the captures this
 * product actually receives it does not work:
 *
 *   1. Real Indian stamp-pad impressions are usually OVER-INKED into a solid
 *      smudge. There are no resolvable ridges at any resolution, because the
 *      ink filled the valleys.
 *   2. Mid-range Android image pipelines apply aggressive denoise and
 *      sharpening, which destroy precisely that spatial-frequency band before
 *      the image ever reaches us.
 *   3. JPEG's 8x8 block quantisation deposits energy at an 8-pixel period,
 *      immediately adjacent to the diagnostic band. So the fallback that was
 *      supposed to rescue cases 1 and 2 fires on compression artefacts instead.
 *
 * Machinery that works on flatbed scans and almost never in the field is worse
 * than no machinery, because it produces confident wrong answers where honest
 * uncertainty was available. So this detector is deliberately modest, its
 * confidence is hard-capped, and every thumb crop is confirmed by a human.
 *
 * Ridge confirmation is a later, gated addition: only above 350 dpi, only with
 * an explicit notch rejecting the JPEG period, and only ever able to RAISE
 * confidence — never to reject a candidate.
 *
 * CROSS-BOX ERRORS ARE SURFACED, NOT ABSORBED. Because the template declares
 * which box is which, a long open mark in the thumb box means somebody signed
 * in the wrong place. That is reported to the operator rather than silently
 * cropped into the wrong field.
 */

import { clusterStrokes } from "../vision/cluster.ts";
import { connectedComponents } from "../vision/components.ts";
import { solidity } from "../vision/thinning.ts";
import { createMask, type Mask, type Point, type Rect, type Rgb } from "../vision/types.ts";
import { REGION_PARAMS, type AbsenceReason, type GateClause } from "./params.ts";

export interface ThumbDetectionInput {
  readonly ink: Mask;
  /** Colour image, for the single-ink test. */
  readonly rgb: Rgb;
  readonly roi: Rect;
  readonly pxPerMM: number;
}

export interface ThumbFeatures {
  readonly areaMM2: number;
  readonly aspect: number;
  readonly solidity: number;
  readonly fillRatio: number;
  readonly colourConsistency: number;
  readonly total: number;
}

export type ThumbDetection =
  | {
      readonly found: true;
      readonly bounds: Rect;
      /** Origin-aligned with `bounds`, as in the signature detector. */
      readonly mask: Mask;
      readonly features: ThumbFeatures;
      /** Hard-capped. A thumb crop is always confirmed by a human in this version. */
      readonly confidence: number;
      /** Always true. Stated as a field so no caller has to remember the rule. */
      readonly needsReview: true;
    }
  | {
      readonly found: false;
      readonly reason: AbsenceReason;
      readonly failedClause: GateClause;
      readonly detail: string;
      readonly features?: ThumbFeatures;
      /** Set when the mark in the thumb box looks like a signature. */
      readonly wrongBoxWarning?: string;
    };

const T = REGION_PARAMS.thumb;

export function detectThumb(input: ThumbDetectionInput): ThumbDetection {
  const { ink, rgb, roi, pxPerMM } = input;

  const local = cropMask(ink, roi);
  const labelled = connectedComponents(local, 4);
  if (labelled.components.length === 0) {
    return {
      found: false,
      reason: "box_empty",
      failedClause: "still_blank",
      detail: "the thumb box contains no ink",
    };
  }

  // A smudged impression breaks into a core plus satellites. Close them back
  // together — generously and symmetrically, because a thumbprint is compact in
  // both directions, unlike a signature.
  const closeGap = T.closeMM * pxPerMM;
  const clusters = clusterStrokes(labelled.components, closeGap, closeGap);
  if (clusters.length === 0) {
    return { found: false, reason: "box_empty", failedClause: "still_blank", detail: "no mark in the thumb box" };
  }

  const minArea = T.areaRangeMM2.min * pxPerMM * pxPerMM;
  const maxArea = T.areaRangeMM2.max * pxPerMM * pxPerMM;

  let best: { bounds: Rect; mask: Mask; features: ThumbFeatures } | null = null;

  for (const cluster of clusters) {
    // The gate is on physical EXTENT, not ink area: a ridged impression inks
    // only about half its own footprint, and gating ink area against a pad-size
    // range rejects the cleanest prints while admitting smudges.
    const extent = cluster.bounds.width * cluster.bounds.height;
    if (extent < minArea || extent > maxArea) continue;

    const wanted = new Set(cluster.components.map((c) => c.label));
    const full = createMask(local.width, local.height);
    for (let i = 0; i < labelled.labels.length; i += 1) {
      const label = labelled.labels[i]!;
      if (label !== 0 && wanted.has(label)) full.data[i] = 255;
    }
    const patch = cropMask(full, cluster.bounds);

    const aspect = cluster.bounds.width / Math.max(1, cluster.bounds.height);
    const fillRatio = cluster.inkArea / Math.max(1, cluster.bounds.width * cluster.bounds.height);
    const solid = solidity(maskPoints(patch), cluster.inkArea);

    // NO SKELETON MEASURE IS USED HERE, and that is worth explaining because
    // two obvious ones were tried and both failed on real thumb geometry.
    //
    // Curvature fails outright: friction ridges are arcs, so "how much does this
    // turn?" scores a clean thumbprint as maximally cursive — backwards, and
    // hardest on the best input. Direction reversals looked like the fix, since
    // a ridge curves consistently while cursive oscillates. But a ridge network
    // is dense and full of junctions, and any greedy skeleton walk hops between
    // adjacent ridges at those junctions, manufacturing reversals that are
    // artefacts of the traversal rather than properties of the mark. Measured on
    // the reference fixture, the thumbprint scored 1.00 "cursive" and an actual
    // signature scored 0.00. Exactly inverted.
    //
    // A measure that inverts on the one object it exists to identify is not a
    // weak signal to be down-weighted; it is worse than no signal, because it
    // contributes confident nonsense. Shape does the whole job instead, and does
    // it cleanly — measured on the same fixtures:
    //
    //     thumb      solidity 0.47   fill 0.36   aspect 0.71
    //     signature  solidity 0.14   fill 0.10   aspect 5.75
    //
    // Ridge structure will matter again in the deferred ridge-verification pass,
    // where it can only raise confidence and runs solely above 350 dpi.
    const diagonal = Math.hypot(cluster.bounds.width, cluster.bounds.height);
    void diagonal;

    const bounds = { ...cluster.bounds, x: cluster.bounds.x + roi.x, y: cluster.bounds.y + roi.y };
    const colourConsistency = singleInkScore(rgb, patch, bounds);

    // Every shape feature is a PLATEAU, not a ramp.
    //
    // A ramp says "more is better", which is wrong for all three. Thumb
    // impressions occupy a BAND: a clean ridged print has solidity near 0.47 and
    // fill near 0.36 because the valleys between ridges are genuinely empty,
    // while an over-inked smudge reaches 0.9 on both. Both are thumb
    // impressions and both should score full marks. Ramping upward from the
    // acceptance floor gave the cleanest print in the corpus almost no credit
    // for solidity or fill and scored it 0.52 against a 0.55 threshold —
    // refusing a textbook impression for being too well taken.
    //
    // Beyond the band the plateau falls away, which is what rejects a signature
    // (0.14 solidity, 0.10 fill, 5.75 aspect) on all three at once.
    const total =
      0.3 * plateau(solid, T.minSolidity, 0.95) +
      0.28 * plateau(aspect, T.aspectRange.min, T.aspectRange.max) +
      0.24 * plateau(fillRatio, T.fillRange.min, T.fillRange.max) +
      0.18 * colourConsistency;

    const features: ThumbFeatures = {
      areaMM2: cluster.inkArea / (pxPerMM * pxPerMM),
      aspect,
      solidity: solid,
      fillRatio,
      colourConsistency,
      total,
    };

    if (!best || total > best.features.total) best = { bounds, mask: patch, features };
  }

  if (!best) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail: `no mark in the thumb box is between ${T.areaRangeMM2.min} and ${T.areaRangeMM2.max} mm2`,
    };
  }

  // Somebody signed in the thumb box. Say so — do not crop a signature into a
  // biometric field, and do not silently report nothing either.
  //
  // Tested on shape, not on a skeleton measure: a signature in a thumb box is
  // long and open (aspect 5.75, solidity 0.14 on the reference fixture) where an
  // impression is compact and filled (0.71, 0.47). That separation is wide and
  // it holds; the skeleton measures did not.
  if (best.features.aspect > T.wrongBoxAspect && best.features.solidity < T.wrongBoxSolidity) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: "the mark in the thumb box is long and open — the shape of a signature, not an impression",
      features: best.features,
      wrongBoxWarning: "This looks like a signature written in the thumb-impression box.",
    };
  }

  if (!(best.features.solidity >= T.minSolidity)) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: `the mark is too open (solidity ${best.features.solidity.toFixed(2)}) to be an inked impression`,
      features: best.features,
    };
  }

  if (!(best.features.total >= T.scoreThreshold)) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: `thumb score ${best.features.total.toFixed(2)} is below the ${T.scoreThreshold} threshold`,
      features: best.features,
    };
  }

  return {
    found: true,
    bounds: best.bounds,
    mask: best.mask,
    features: best.features,
    // The cap is the honest statement of what this detector can support without
    // ridge verification. It is applied here rather than left to the caller so
    // no future call site can forget it.
    confidence: Math.min(best.features.total, T.confidenceCap),
    needsReview: true,
  };
}

/**
 * How consistently single-coloured the ink is, 0..1.
 *
 * A stamp pad is one ink — near-neutral black or a blue-violet. A photograph
 * never is, and neither is a region that has caught part of a printed logo. This
 * is a cheap, robust separator that needs no shape information at all.
 */
function singleInkScore(rgb: Rgb, mask: Mask, bounds: Rect): number {
  const hues: number[] = [];
  let neutral = 0;
  let counted = 0;

  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      const sx = Math.round(bounds.x) + x;
      const sy = Math.round(bounds.y) + y;
      if (sx < 0 || sy < 0 || sx >= rgb.width || sy >= rgb.height) continue;
      const p = (sy * rgb.width + sx) * rgb.channels;
      const r = rgb.data[p]!;
      const g = rgb.data[p + 1]!;
      const b = rgb.data[p + 2]!;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      counted += 1;
      if (max - min < 20) {
        neutral += 1;
        continue;
      }
      let hue: number;
      const delta = max - min;
      if (max === r) hue = ((g - b) / delta) % 6;
      else if (max === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hues.push(((hue * 60) + 360) % 360);
    }
  }

  if (counted === 0) return 0;
  // A near-neutral impression is a black stamp pad — maximally consistent.
  const neutralFraction = neutral / counted;
  if (neutralFraction > 0.7) return 1;
  if (hues.length < 8) return neutralFraction;

  // Circular spread of the hues that are left. Tight spread = one ink.
  let sumSin = 0;
  let sumCos = 0;
  for (const hue of hues) {
    const radians = (hue * Math.PI) / 180;
    sumSin += Math.sin(radians);
    sumCos += Math.cos(radians);
  }
  const resultant = Math.hypot(sumSin, sumCos) / hues.length;
  // Blend: neutral pixels always count as consistent.
  return Math.min(1, neutralFraction + (1 - neutralFraction) * resultant);
}

function ramp(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
}

/** 1 inside the band, falling to 0 within 40 % of the band width outside it. */
function plateau(value: number, low: number, high: number): number {
  if (value >= low && value <= high) return 1;
  const margin = (high - low) * 0.4;
  if (value < low) return Math.max(0, 1 - (low - value) / margin);
  return Math.max(0, 1 - (value - high) / margin);
}

function cropMask(mask: Mask, rect: Rect): Mask {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(mask.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(mask.height, Math.ceil(rect.y + rect.height));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const out = createMask(width, height);
  for (let y = 0; y < height; y += 1) {
    const src = (y0 + y) * mask.width + x0;
    out.data.set(mask.data.subarray(src, src + width), y * width);
  }
  return out;
}

function maskPoints(mask: Mask): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < mask.height; y += 1) {
    const row = y * mask.width;
    for (let x = 0; x < mask.width; x += 1) if (mask.data[row + x] !== 0) points.push({ x, y });
  }
  return points;
}
