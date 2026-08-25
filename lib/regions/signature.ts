/**
 * Signature detection.
 *
 * Operates on the INK mask, from which the printed ruled line and the printed
 * "Signature" label have already been removed. That subtraction is what makes
 * this tractable, and it is only possible because registration tells us exactly
 * where the printed layer was. Without it the problem is "find handwriting
 * among printed text"; with it the problem is "measure the only ink present",
 * which is a different and much easier question.
 *
 * The hard confusions, and what resolves each:
 *
 *   a printed line          removed upstream; anything left with near-zero
 *                           curvature and one very long branch is a survivor
 *                           of that removal and is rejected here
 *   a hand-PRINTED name     the dangerous one. Block capitals in the signature
 *                           box are genuinely wide, short and inky, and pass
 *                           every shape test. Character-pitch regularity is
 *                           what catches them.
 *   a thumb impression      solid rather than open — separated by solidity and
 *                           by the largest distance-transform value, since
 *                           signature strokes are thin by construction
 *   the adjacent date       excluded by complete-link clustering plus a hard
 *                           bound on how far a cluster may extend
 */

import { clusterStrokes, splitAtWidestGap, type Cluster } from "../vision/cluster.ts";
import { componentsWithin, connectedComponents, type LabelledImage } from "../vision/components.ts";
import { printedCaptionLabels } from "../ink/text-lines.ts";
import { distanceTransform, strokeWidthStats } from "../vision/features.ts";
import { pitchRegularity, skeletonShape, solidity, zhangSuenThin } from "../vision/thinning.ts";
import { createMask, type Mask, type Point, type Rect } from "../vision/types.ts";
import { REGION_PARAMS, type AbsenceReason, type GateClause } from "./params.ts";

export interface SignatureDetectionInput {
  /** Ink mask with printed rules already removed. */
  readonly ink: Mask;
  /** Search region in working pixels — the template box, already expanded. */
  readonly roi: Rect;
  /** Working-image pixels per millimetre of paper. */
  readonly pxPerMM: number;
  /**
   * Y of the printed signature rule in working pixels, when the template knows
   * it. Signatures sit on their line; proximity to it is real evidence.
   */
  readonly baselineY?: number;
  /** Mean ink area of accepted signatures on this template, for the area cap. */
  readonly priorInkArea?: number;
  /**
   * An independent detector's opinion, when one has run. Not required, and
   * never a veto — purpose-built signature detectors miss light pencil and
   * non-Latin scrawl.
   */
  readonly external?: { readonly present: boolean; readonly box?: Rect; readonly confidence: number };
}

export interface SignatureFeatures {
  readonly aspect: number;
  readonly solidity: number;
  readonly strokeWidthCv: number;
  readonly meanCurvature: number;
  readonly reversals: number;
  readonly longestBranchMM: number;
  readonly printedTextLikelihood: number;
  readonly baselineProximity: number;
  readonly inkAreaMM2: number;
  readonly maxStrokeHalfWidthMM: number;
  readonly total: number;
}

export type SignatureDetection =
  | {
      readonly found: true;
      readonly bounds: Rect;
      readonly mask: Mask;
      readonly features: SignatureFeatures;
      readonly confidence: number;
      /** Set when the cluster breached its area cap and part was dropped. */
      readonly excludedAdjacentContent: boolean;
      readonly needsReview: boolean;
    }
  | {
      readonly found: false;
      readonly reason: AbsenceReason;
      readonly failedClause: GateClause;
      readonly detail: string;
      readonly suggestion?: Rect;
      readonly features?: SignatureFeatures;
    };

const S = REGION_PARAMS.signature;

export function detectSignature(input: SignatureDetectionInput): SignatureDetection {
  const { ink, roi, pxPerMM } = input;

  const labelled = connectedComponents(cropMask(ink, roi), 2);

  // Drop small printed captions before clustering. On the cold-start path there
  // is no blank template to subtract, so the printed "Signature" label is still
  // present directly beneath the rule — and a signature's flourish crosses that
  // rule and lands among the caption's letters. Complete linkage then attaches
  // the tail to whichever neighbour is nearer, which is usually the caption,
  // and the crop loses its last third with no sign that anything went wrong.
  const captions = printedCaptionLabels(labelled.components, { pxPerMM });
  const usable = labelled.components.filter((c) => !captions.has(c.label));

  if (usable.length === 0) {
    return {
      found: false,
      reason: "box_empty",
      failedClause: "still_blank",
      detail: "the signature area contains no ink",
    };
  }

  // Cluster the strokes back into whole marks. The cap is expressed relative to
  // the ROI so a cluster cannot creep along a rule into the neighbouring field
  // even when complete linkage would technically permit it.
  const capPx = S.clusterCapMM * pxPerMM;
  const cap: Rect = {
    x: -capPx,
    y: -capPx,
    width: roi.width + capPx * 2,
    height: roi.height + capPx * 2,
  };
  const clusters = clusterStrokes(
    usable,
    S.clusterGapXMM * pxPerMM,
    S.clusterGapYMM * pxPerMM,
    cap,
  );

  const minInkPx = S.minInkAreaMM2 * pxPerMM * pxPerMM;
  const minWidthPx = S.minWidthMM * pxPerMM;
  const sized = clusters.filter((c) => c.inkArea >= minInkPx && c.bounds.width >= minWidthPx);

  if (sized.length === 0) {
    const biggest = clusters[0];
    return {
      found: false,
      reason: biggest ? "below_threshold" : "box_empty",
      failedClause: biggest ? "boundary" : "still_blank",
      detail: biggest
        ? `the largest mark is ${(biggest.inkArea / (pxPerMM * pxPerMM)).toFixed(0)} mm2, below the ${S.minInkAreaMM2} mm2 floor`
        : "the signature area contains no mark large enough to be a signature",
    };
  }

  // Score every candidate and take the best. Scoring all of them rather than
  // assuming the largest is right matters when a date or an initial sits in the
  // same box — the largest mark is not always the signature.
  let best: { cluster: Cluster; features: SignatureFeatures; excluded: boolean } | null = null;

  for (const candidate of sized) {
    const evaluated = evaluate(candidate, labelled, input);
    if (!best || evaluated.features.total > best.features.total) best = evaluated;
  }

  if (!best) {
    return { found: false, reason: "below_threshold", failedClause: "content", detail: "no candidate could be scored" };
  }

  const { features } = best;
  const bounds = offsetRect(best.cluster.bounds, roi.x, roi.y);

  // Cross-class rejection. These are not "low scores" — they are positive
  // identifications of something else, and treating them as weak signatures
  // would put a thumbprint in the signature field.
  if (features.solidity >= REGION_PARAMS.thumb.minSolidity && features.aspect <= 1.8 && features.aspect >= 0.55) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: `this mark is solid (${features.solidity.toFixed(2)}) and compact — it is a thumb impression, not a signature`,
      suggestion: bounds,
      features,
    };
  }
  if (features.maxStrokeHalfWidthMM > S.maxStrokeHalfWidthMM) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: `strokes are ${features.maxStrokeHalfWidthMM.toFixed(1)} mm thick — signature strokes are thin, this is a filled region`,
      suggestion: bounds,
      features,
    };
  }
  if (features.printedTextLikelihood > S.printedTextAlarm) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "content",
      detail: `this mark has regular character pitch (${features.printedTextLikelihood.toFixed(2)}) — it is printed or hand-printed text`,
      suggestion: bounds,
      features,
    };
  }

  // External agreement. An independent detector raises confidence when it
  // fires, and lowers it when it is silent, but never vetoes: purpose-built
  // signature detectors are trained on Latin script and miss light pencil.
  const external = input.external;
  const threshold = external?.present ? S.scoreThreshold : S.scoreThresholdUnsupported;

  if (!(features.total >= threshold)) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: external && !external.present ? "external" : "content",
      detail: `signature score ${features.total.toFixed(2)} is below the ${threshold} threshold`,
      suggestion: bounds,
      features,
    };
  }

  let confidence = Math.min(1, features.total);
  if (external?.present) confidence = Math.min(1, confidence * 0.75 + external.confidence * 0.25);
  else if (external) confidence = Math.max(0, confidence - 0.08);

  return {
    found: true,
    bounds,
    mask: clusterMask(best.cluster, labelled, roi),
    features,
    confidence,
    excludedAdjacentContent: best.excluded,
    needsReview: best.excluded || confidence < 0.75,
  };
}

// ---------------------------------------------------------------------------

function evaluate(
  cluster: Cluster,
  labelled: LabelledImage,
  input: SignatureDetectionInput,
): { cluster: Cluster; features: SignatureFeatures; excluded: boolean } {
  const { pxPerMM, roi } = input;
  let working = cluster;
  let excluded = false;

  // Area cap, with DEFINED behaviour on breach.
  //
  // A cap with no stated response is the worst of both worlds: implementations
  // either truncate silently — losing part of a real signature with no record —
  // or reject outright, discarding a signature that is genuinely present. Here
  // the cluster is split at its widest internal gap, the half nearest the
  // baseline is kept, and the exclusion is reported so the operator can see
  // that something was dropped.
  const priorArea = input.priorInkArea;
  const capArea = priorArea
    ? priorArea * S.areaCapMultiple
    : roi.width * roi.height * S.areaCapMultipleNoPrior;

  if (cluster.inkArea > capArea) {
    const halves = splitAtWidestGap(cluster);
    if (halves) {
      const anchorY = (input.baselineY ?? roi.y + roi.height / 2) - roi.y;
      const distance = (c: Cluster) => Math.abs(c.bounds.y + c.bounds.height / 2 - anchorY);
      working = distance(halves[0]) <= distance(halves[1]) ? halves[0] : halves[1];
      excluded = true;
    }
  }

  const patch = clusterMask(working, labelled, roi);
  const local = cropMask(patch, working.bounds);

  const aspect = working.bounds.width / Math.max(1, working.bounds.height);
  const points = maskPoints(local);
  const solid = solidity(points, working.inkArea);

  const stroke = strokeWidthStats(local);
  const strokeWidthCv = stroke.variation;

  const skeleton = zhangSuenThin(local);
  const shape = skeletonShape(skeleton);
  const longestBranchMM = shape.longestBranch / pxPerMM;

  const distance = distanceTransform(local);
  let maxHalfWidth = 0;
  for (let i = 0; i < distance.data.length; i += 1) if (distance.data[i]! > maxHalfWidth) maxHalfWidth = distance.data[i]!;

  const printedTextLikelihood = printedLikelihood(local, shape, strokeWidthCv, pxPerMM);

  const baselineProximity = input.baselineY
    ? 1 -
      Math.min(
        1,
        Math.abs(working.bounds.y + roi.y + working.bounds.height / 2 - input.baselineY) /
          (S.baselineFalloffMM * pxPerMM),
      )
    : 0.5;

  // Aspect is a PLATEAU, not a ramp: a signature is wide and short, but a very
  // long thin mark is a rule that survived removal, and both ends must be
  // penalised.
  const aspectBand =
    ramp(aspect, S.aspectRange.low, S.aspectRange.lowFull) * (1 - ramp(aspect, S.aspectRange.highFull, S.aspectRange.high));

  // Cursive is the only common mark with BOTH sustained curvature and frequent
  // direction reversals. A smooth arc has the first without the second; a
  // printed 'm' has the second over too short a length to matter.
  const curvatureScore = ramp(shape.meanCurvature, 0.06, 0.2) * ramp(shape.reversalsPer100px, 1.5, 6);

  const total =
    0.21 * aspectBand +
    0.18 * (1 - ramp(solid, S.solidityRange.min, S.solidityRange.max + 0.05)) +
    0.15 * ramp(strokeWidthCv, S.strokeWidthCvRange.min, S.strokeWidthCvRange.max) +
    0.15 * curvatureScore +
    0.12 * (1 - printedTextLikelihood) +
    0.11 * ramp(longestBranchMM, S.longestBranchMM.min, S.longestBranchMM.max) +
    0.08 * baselineProximity;

  return {
    cluster: working,
    excluded,
    features: {
      aspect,
      solidity: solid,
      strokeWidthCv,
      meanCurvature: shape.meanCurvature,
      reversals: shape.reversalsPer100px,
      longestBranchMM,
      printedTextLikelihood,
      baselineProximity,
      inkAreaMM2: working.inkArea / (pxPerMM * pxPerMM),
      maxStrokeHalfWidthMM: maxHalfWidth / pxPerMM,
      total,
    },
  };
}

/**
 * How much this mark looks like printed or hand-printed text.
 *
 * Three independent signs, multiplied so all must agree: regular character
 * pitch, uniform stroke width, and short skeleton branches. Block capitals in a
 * signature box hit all three; cursive hits none. Multiplying rather than
 * averaging keeps a single coincidence from raising the score — a signature
 * with even stroke width is still a signature.
 */
function printedLikelihood(mask: Mask, shape: ReturnType<typeof skeletonShape>, strokeWidthCv: number, pxPerMM: number): number {
  const pitch = pitchRegularity(mask, Math.max(3, Math.round(1.5 * pxPerMM)), Math.round(9 * pxPerMM));
  const uniformStroke = 1 - ramp(strokeWidthCv, 0.2, 0.45);
  // Printed characters are separate glyphs, so branches are short whatever the
  // word length; cursive runs a single branch across the whole word.
  const shortBranches = 1 - ramp(shape.longestBranch / pxPerMM, 8, 22);
  return pitch * uniformStroke * shortBranches;
}

function ramp(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return Math.max(0, Math.min(1, (value - low) / (high - low)));
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

/** Mask of just this cluster's components, in ROI-local coordinates. */
function clusterMask(cluster: Cluster, labelled: LabelledImage, roi: Rect): Mask {
  const wanted = new Set(cluster.components.map((c) => c.label));
  const out = createMask(labelled.width, labelled.height);
  for (let i = 0; i < labelled.labels.length; i += 1) {
    const label = labelled.labels[i]!;
    if (label !== 0 && wanted.has(label)) out.data[i] = 255;
  }
  void roi;
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

function offsetRect(rect: Rect, dx: number, dy: number): Rect {
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width, height: rect.height };
}

/** Components of a labelled image whose bounds sit inside a region. Re-exported for the fusion stage. */
export { componentsWithin };
