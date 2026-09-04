/**
 * The person's photograph, cut from the capture where the reader says it is.
 *
 * WHY THE READER LOCATES IT. The previous cropper found the page's four
 * corners, straightened the page and measured the photograph at fixed
 * millimetre coordinates. On a real phone photo — a page on a desk, a little
 * tilted, a print the printer scaled — the page outline was often not found,
 * and the fixed coordinates then addressed the desk beside the form. The
 * text never suffered, because the vision model reads the whole picture
 * wherever things are. So the photograph now works the same way: the same
 * model call names where the pasted print is, and the crop is taken there.
 *
 * WHAT THE HINT IS WORTH. Measured on real replies, the model's box overlaps
 * the print by half or more and is right to about a tenth of the picture,
 * and no better — enough to say where the print is, not where its edges
 * are. So the hint is a region to search, never a crop.
 *
 * HOW THE EDGES ARE FOUND. One analysis region, several prints wide around
 * the hint, is prepared the way the old pipeline prepared a whole page — at
 * page scale, so the illumination flattening sees the print as an object
 * and not as background to divide away. On its tiles the print is a block
 * of continuous tone surrounded by paper, read out to its own extent; on
 * its channels the same edge-fitting detector as before measures the
 * print's four sides, first where the reader pointed and then at those
 * blocks, after the edges that are not the print's — the page's against
 * the desk, the printed rules — have been painted over in paper. A fit is
 * believed only if it is the shape of the form's print, the size of the
 * block it was measured at, and has no blank paper just inside an edge.
 * When nothing measures, the best block is cut as it is, at low confidence
 * and flagged for a person.
 *
 * WHAT THE MODEL DOES NOT DO. It never hands back pixels. The crop is cut
 * from the uploaded capture; nothing is generated.
 */

import type { PhotoDefinition } from "../forms/definitions.ts";
import { prepareChannels, type ScanChannels } from "../ink/normalize.ts";
import { toneSpread } from "../ink/paper-stats.ts";
import { REGION_PARAMS } from "../regions/params.ts";
import { detectPhoto, type PhotoDetection } from "../regions/photo.ts";
import { renderPhotoCrop } from "../regions/postprocess.ts";
import { minAreaRect } from "../vision/geometry.ts";
import { encodeRgbPng } from "../vision/io.ts";
import { iou, quadPoints, type Quad, type Rect, type Rgb } from "../vision/types.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";

// ---------------------------------------------------------------------------
// The reader's box
// ---------------------------------------------------------------------------

/** A box as fractions of the image: 0 is the left/top edge, 1 the right/bottom. */
export interface NormalizedBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Turns the reader's four numbers into fractions of the picture it was shown.
 *
 * The prompt asks for thousandths (0-1000). Models sometimes answer in 0-1
 * fractions instead, or in pixels of the picture; the scale is inferred from
 * the largest value. Reversed corners are put right and everything is
 * clamped to the picture.
 */
export function normalizeBox(
  raw: readonly [number, number, number, number],
  sentWidth: number,
  sentHeight: number,
): NormalizedBox | null {
  if (raw.some((value) => !Number.isFinite(value))) return null;
  const largest = Math.max(...raw);
  let scaleX = 1000;
  let scaleY = 1000;
  if (largest <= 1) {
    scaleX = 1;
    scaleY = 1;
  } else if (largest > 1000) {
    scaleX = Math.max(1, sentWidth);
    scaleY = Math.max(1, sentHeight);
  }
  let x1 = raw[0] / scaleX;
  let y1 = raw[1] / scaleY;
  let x2 = raw[2] / scaleX;
  let y2 = raw[3] / scaleY;
  if (x2 < x1) [x1, x2] = [x2, x1];
  if (y2 < y1) [y1, y2] = [y2, y1];
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const box = { x1: clamp(x1), y1: clamp(y1), x2: clamp(x2), y2: clamp(y2) };
  if (box.x2 - box.x1 <= 0 || box.y2 - box.y1 <= 0) return null;
  return box;
}

/**
 * A box on the square canvas the model was shown, restated as fractions of
 * the capture that sits at the canvas's top-left. Null when the box lies in
 * the padding, where there is nothing to cut.
 */
export function canvasBoxToImage(box: NormalizedBox, imageWidth: number, imageHeight: number, edge: number): NormalizedBox | null {
  const sx = edge / Math.max(1, imageWidth);
  const sy = edge / Math.max(1, imageHeight);
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const mapped = { x1: clamp(box.x1 * sx), y1: clamp(box.y1 * sy), x2: clamp(box.x2 * sx), y2: clamp(box.y2 * sy) };
  if (mapped.x2 - mapped.x1 <= 0 || mapped.y2 - mapped.y1 <= 0) return null;
  return mapped;
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

export type LocatedPhoto =
  | {
      readonly found: true;
      readonly png: Buffer;
      readonly width: number;
      readonly height: number;
      readonly confidence: number;
      /** Low confidence, low resolution, or an unmeasured cut — a person should look before saving. */
      readonly needsReview: boolean;
      /** `measured`: four edges fitted and the print warped upright. `located`: a block cut as it is. */
      readonly method: "measured" | "located";
      readonly lowResolution: boolean;
      /** Where in the source the crop came from. For overlays and for checking against a known position. */
      readonly sourceRect: Rect;
      readonly detail: string;
    }
  | {
      readonly found: false;
      readonly reason: "no_photo" | "implausible_box" | "not_found";
      readonly detail: string;
    };

export interface LocateOptions {
  readonly targetDpi?: number;
  /** Diagnostic hook: called with what the search saw and what each measurement decided. */
  readonly debug?: (event: string, data: unknown) => void;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** A hint smaller than this on either side is not a photograph in a form photo. */
const MIN_EDGE_PX = 40;
/** A hint covering more of the picture than this is the page, not a print on it. */
const MAX_AREA_FRACTION = 0.4;
const ASPECT = { min: 0.35, max: 2 };
/**
 * The analysis region reaches this far around the hint, in hint widths and
 * heights, each side — six prints across in all. That is the ratio of page
 * to photograph the channel preparation was designed for: its illumination
 * flattening is capped at a quarter of the region, and a region much
 * smaller than this flattens the print's own backdrop away to paper.
 */
const ANALYSIS_REACH = 2.5;
/** The hint is brought to about this many pixels on its long side for analysis — page scale, as the detector expects. */
const ANALYSIS_HINT_EDGE = 320;
/** Below this many analysis pixels per millimetre the print is a thumbnail and edge fitting has nothing to work with. */
const MIN_PX_PER_MM = 1.5;
/** How far outside a box a printed frame is assumed to run, in millimetres. */
const FRAME_ALLOWANCE_MM = 2;
/** How far from a box's edges the detector may look. The reader's box gets the wider band; a block the search read out gets the narrower. */
const HINT_EDGE_PRIOR = { sigmaMM: 4, bandMM: 8 };
const BLOCK_EDGE_PRIOR = { sigmaMM: 2, bandMM: 4 };
/** A measured print may differ from the form's declared print by this much in aspect... */
const MAX_ASPECT_RATIO = 1.2;
/** ...and from the box it was measured at by this much in area. */
const AREA_RATIO = { min: 0.5, max: 1.6 };
/** It must overlap the box it was measured at, and the reader's own box, at least this much. */
const MIN_OVERLAP_WITH_BOX = 0.7;
const MIN_OVERLAP_WITH_HINT = 0.25;
/** Among accepted measurements, agreement with the reader's box counts this much beside the detector's confidence. */
const HINT_AGREEMENT_WEIGHT = 0.3;
/** Just inside each measured edge, a band this deep (as a fraction of the print's short side) is sampled... */
const INNER_BAND_FRACTION = 0.1;
/** ...and if this much of it is blank paper, the quad took in part of the page. */
const MAX_PAPER_INSIDE = 0.6;
/** Candidate blocks come at these multiples of the hint's area, in the form's declared shape. */
const SEARCH_SIZES = [0.8, 1, 1.2] as const;
/** How many nearby blocks get a full measurement before the best is cut as it is. */
const MAX_MEASURED_CANDIDATES = 4;
/** A block is worth measuring when at least this much of it is not paper. */
const MIN_CANDIDATE_CONTENT = 0.4;
/** A block is worth cutting unmeasured only when it is plainly not paper... */
const MIN_BLOCK_CONTENT = 0.55;
/** ...and carries the tonal range of a photograph rather than a logo or a code (`toneSpread`, 0..1). */
const MIN_BLOCK_TONE_SPREAD = 0.2;
/** A block is cut a little generous, so a tight box does not shave the print. */
const CUT_PAD = 0.03;
const CUT_MAX_EDGE = 900;
/** What an unmeasured cut is worth. Below the review line by design. */
const LOCATED_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function locatePhoto(
  source: Rgb,
  box: NormalizedBox | null,
  spec: PhotoDefinition,
  options: LocateOptions = {},
): Promise<LocatedPhoto> {
  if (!box) {
    return { found: false, reason: "no_photo", detail: "the reader saw no pasted photograph on the form" };
  }

  const hint = toRect(box, source);
  const implausible = whyImplausible(hint, source);
  if (implausible) return { found: false, reason: "implausible_box", detail: implausible };

  const analysis = prepareAnalysis(source, hint, spec);
  if (!analysis) return { found: false, reason: "not_found", detail: "the reader's photo location is too small to analyse" };
  options.debug?.("analysis", { roi: analysis.roi, step: analysis.step, cleaned: analysis.cleaned, pxPerMM: analysis.pxPerMM });

  // 1. Where the reader pointed.
  const atHint = await measureAt(analysis, hint, spec, options, "where the reader pointed", HINT_EDGE_PRIOR);
  options.debug?.("hint", { rect: hint, ...(atHint.found ? { measured: atHint.photo.sourceRect } : { refused: atHint.detail }) });
  if (atHint.found) return atHint.photo;

  // 2. The photograph-like blocks near it, most likely first. The ranking is
  // a heuristic and the runner-up is sometimes the print, so the best few
  // are all measured, and the measurement the detector is most sure of —
  // weighted by agreement with the reader — wins.
  const search = searchNear(analysis, spec, options);
  options.debug?.("candidates", { hintBlock: search.hint, candidates: search.candidates });
  let best: { photo: LocatedPhoto & { found: true }; merit: number } | null = null;
  const merit = (photo: LocatedPhoto & { found: true }) => photo.confidence + HINT_AGREEMENT_WEIGHT * iou(photo.sourceRect, hint);
  for (const candidate of search.candidates.slice(0, MAX_MEASURED_CANDIDATES)) {
    const attempt = await measureAt(analysis, candidate.rect, spec, options, "at a block near where the reader pointed", BLOCK_EDGE_PRIOR);
    options.debug?.("candidate", {
      rect: candidate.rect,
      ...(attempt.found ? { measured: attempt.photo.sourceRect, confidence: attempt.photo.confidence } : { refused: attempt.detail }),
    });
    if (attempt.found && (!best || merit(attempt.photo) > best.merit)) best = { photo: attempt.photo, merit: merit(attempt.photo) };
  }
  if (best) return best.photo;

  // 3. The best block, cut as it is — a real photograph is there by every
  // cheap measure; what could not be established is exactly where its edges are.
  const block = search.candidates.find((candidate) => candidate.content >= MIN_BLOCK_CONTENT && candidate.photoLike);
  const cutRect = block?.rect ?? (search.hint.content >= MIN_BLOCK_CONTENT && search.hint.photoLike ? hint : null);
  if (!cutRect) {
    return { found: false, reason: "not_found", detail: "no photograph was found near where the reader pointed" };
  }
  const cutFrom = clip(pad(cutRect, CUT_PAD * cutRect.width, CUT_PAD * cutRect.height), source);
  const delivered = fitWithin(extractPatch(source, cutFrom), CUT_MAX_EDGE);
  return {
    found: true,
    png: await encodeRgbPng(delivered),
    width: delivered.width,
    height: delivered.height,
    confidence: LOCATED_CONFIDENCE,
    needsReview: true,
    method: "located",
    lowResolution: false,
    sourceRect: cutFrom,
    detail: `cut near where the reader located it; its edges could not be measured (${atHint.detail}), so check the crop`,
  };
}

// ---------------------------------------------------------------------------
// The analysis region: one set of channels for the search and every measurement
// ---------------------------------------------------------------------------

interface Analysis {
  readonly source: Rgb;
  readonly hint: Rect;
  /** The region of the source under analysis. May reach past the source; the patch is padded with paper there. */
  readonly roi: Rect;
  /** Source pixels per analysis pixel. */
  readonly step: number;
  /** The region at analysis scale. */
  readonly patch: Rgb;
  readonly pxPerMM: number;
  readonly channels: ScanChannels;
  /** The patch with the edges that are not the print's painted over, and its channels. */
  readonly cleaned: Rgb;
  readonly cleanChannels: ScanChannels;
  readonly toAnalysis: (rect: Rect) => Rect;
  readonly toSourceRect: (rect: Rect) => Rect;
  readonly toSourceQuad: (quad: Quad) => Quad;
}

function prepareAnalysis(source: Rgb, hint: Rect, spec: PhotoDefinition): Analysis | null {
  const roi = pad(hint, ANALYSIS_REACH * hint.width, ANALYSIS_REACH * hint.height);
  const step = Math.max(1, Math.ceil(Math.max(hint.width, hint.height) / ANALYSIS_HINT_EDGE));
  const patch = extractPatchPadded(source, roi, step);
  if (patch.width < 32 || patch.height < 32) return null;

  const toAnalysis = (rect: Rect): Rect => ({
    x: (rect.x - roi.x) / step,
    y: (rect.y - roi.y) / step,
    width: rect.width / step,
    height: rect.height / step,
  });
  const toSourceRect = (rect: Rect): Rect => ({
    x: Math.round(roi.x + rect.x * step),
    y: Math.round(roi.y + rect.y * step),
    width: Math.round(rect.width * step),
    height: Math.round(rect.height * step),
  });
  const toSourceQuad = (quad: Quad): Quad => {
    const at = (p: Quad["tl"]) => ({ x: roi.x + p.x * step, y: roi.y + p.y * step });
    return { tl: at(quad.tl), tr: at(quad.tr), br: at(quad.br), bl: at(quad.bl) };
  };

  // The print's size on the paper is the form's declaration; the hint's size
  // in pixels then says how many pixels a millimetre is, which is what every
  // threshold in the detector is expressed in.
  const hintA = toAnalysis(hint);
  const pxPerMM = (hintA.width / spec.sizeMM.widthMM + hintA.height / spec.sizeMM.heightMM) / 2;
  if (pxPerMM < MIN_PX_PER_MM) return null;

  const channels = prepareChannels(patch, { pxPerMM, imageRegions: [hintA] });
  const cleaned = withoutCompetingEdges(patch, channels, pxPerMM);
  const cleanChannels = cleaned === patch ? channels : prepareChannels(cleaned, { pxPerMM, imageRegions: [hintA] });
  return { source, hint, roi, step, patch, pxPerMM, channels, cleaned, cleanChannels, toAnalysis, toSourceRect, toSourceQuad };
}

// ---------------------------------------------------------------------------
// Measuring: the detector, at one candidate rectangle
// ---------------------------------------------------------------------------

type Measurement = { readonly found: true; readonly photo: LocatedPhoto & { found: true } } | { readonly found: false; readonly detail: string };

async function measureAt(
  analysis: Analysis,
  rect: Rect,
  spec: PhotoDefinition,
  options: LocateOptions,
  stage: string,
  prior: { readonly sigmaMM: number; readonly bandMM: number },
): Promise<Measurement> {
  const { cleaned, cleanChannels, pxPerMM } = analysis;
  const expected = analysis.toAnalysis(rect);
  const hintA = analysis.toAnalysis(analysis.hint);

  try {
    const detect = (printedBorder: Rect) =>
      detectPhoto({
        lab: cleanChannels.lab,
        texture: cleanChannels.texture,
        ink: cleanChannels.ink,
        paper: cleanChannels.paper,
        expected,
        sizeMM: spec.sizeMM,
        // Wide on purpose: the scale was derived from the hint, and a box a
        // little generous or a little tight must not fail the print it
        // contains for being "the wrong size".
        sizeTolerance: { min: 0.6, max: 1.7 },
        pxPerMM,
        printedBorder,
        pageSaturatedFraction: cleanChannels.saturatedFraction,
        prior,
      });

    // Forms print a frame for the photograph, and the print is pasted in or
    // over it. The detector prefers the inner of two parallel edges only
    // where a printed border is declared, within a fraction of a millimetre
    // — and where the frame is, nobody knows in advance. So the box's
    // outline is declared first, a little generous; and a fit that turns out
    // to have blank paper just inside it IS the frame, so it is declared as
    // the frame and the fit is made again, inside it.
    let detection = detect(pad(expected, FRAME_ALLOWANCE_MM * pxPerMM, FRAME_ALLOWANCE_MM * pxPerMM));
    const report = (verdict: string, quad: Quad | null) =>
      options.debug?.("fit", {
        stage,
        rect,
        quad: quad ? analysis.toSourceQuad(quad) : null,
        suggestion: !detection.found && detection.suggestion ? analysis.toSourceQuad(detection.suggestion) : null,
        verdict,
      });
    if (!detection.found) {
      report(detection.detail, null);
      return { found: false, detail: detection.detail };
    }

    // The detector was built for a straightened page whose expected box is
    // right to a millimetre. Here the box is a hint and the neighbourhood is
    // a raw capture, so a fitted quad is checked against what a print pasted
    // where the hint says could possibly look like before it is believed.
    let doubt = whyNotThePrint(cleaned, detection.quad, expected, hintA, spec, cleanChannels.paper);
    if (doubt && doubt.includes("blank paper just inside")) {
      const again = detect(quadBounds(detection.quad));
      if (again.found) {
        const doubtAgain = whyNotThePrint(cleaned, again.quad, expected, hintA, spec, cleanChannels.paper);
        if (!doubtAgain) {
          detection = again;
          doubt = null;
        }
      }
    }
    report(doubt ?? "accepted", detection.quad);
    if (doubt) return { found: false, detail: doubt };

    return { found: true, photo: await renderMeasured(analysis, detection, spec, options, stage) };
  } catch (error) {
    // The detector is measured code, but this is a new kind of input for it;
    // a fault here must cost the measurement, never the photograph.
    console.warn("photo measurement failed", error);
    return { found: false, detail: "the measurement failed" };
  }
}

/**
 * The delivered crop, cut from the capture at its own resolution.
 *
 * At the print's own measured SHAPE, but at the form's declared WIDTH: the
 * hint's size set the millimetre scale for analysis and is only roughly
 * right, and a scale taken from it would deliver a 35 mm print as a 40 mm
 * one — more pixels than the capture has, and a needless low-resolution
 * flag. The print's fitted width is the declared width, and its height
 * follows its measured aspect, so a face is never stretched to fit a frame.
 */
async function renderMeasured(
  analysis: Analysis,
  detection: PhotoDetection & { found: true },
  spec: PhotoDefinition,
  options: LocateOptions,
  stage: string,
): Promise<LocatedPhoto & { found: true }> {
  const quadSource = analysis.toSourceQuad(detection.quad);
  const bounds = quadBounds(quadSource);
  const region = clip(pad(bounds, 0.15 * bounds.width, 0.15 * bounds.height), analysis.source);
  const patch = extractPatch(analysis.source, region);
  const shift = (p: Quad["tl"]) => ({ x: p.x - region.x, y: p.y - region.y });
  const quad: Quad = { tl: shift(quadSource.tl), tr: shift(quadSource.tr), br: shift(quadSource.br), bl: shift(quadSource.bl) };

  const fitted = minAreaRect(quadPoints(quad));
  const printPxPerMM = fitted.width / spec.sizeMM.widthMM;
  const sizeMM = { widthMM: spec.sizeMM.widthMM, heightMM: fitted.height / printPxPerMM };
  const crop = renderPhotoCrop(patch, quad, sizeMM, printPxPerMM, options.targetDpi ?? 300);
  const confidence = crop.lowResolution
    ? Math.min(detection.confidence, REGION_PARAMS.photo.lowResolutionConfidenceCap)
    : detection.confidence;
  return {
    found: true,
    png: await encodeRgbPng(crop.image),
    width: crop.width,
    height: crop.height,
    confidence,
    needsReview: confidence < 0.8 || crop.lowResolution,
    method: "measured",
    lowResolution: crop.lowResolution,
    sourceRect: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) },
    detail: crop.lowResolution
      ? `measured ${stage}, but the capture only carries ${crop.effectiveDpi} dpi of it — photograph the form closer for a sharper print`
      : `measured ${stage} at ${Math.round(confidence * 100)} % confidence`,
  };
}

// ---------------------------------------------------------------------------
// Believing a measurement
// ---------------------------------------------------------------------------

/**
 * Why a fitted quad is not the print the hint points at — or null when it may
 * be. Each test is a cheap contradiction: a print cannot be a different shape
 * from the form's declared print by much, nor a different size from the box
 * it was measured at, cannot lie somewhere else, and cannot have blank paper
 * just inside one of its edges.
 */
function whyNotThePrint(
  patch: Rgb,
  quad: Quad,
  expected: Rect,
  hint: Rect,
  spec: PhotoDefinition,
  paper: { readonly paperLevel: number; readonly sigmaLightness: number },
): string | null {
  const bounds = quadBounds(quad);
  const fitted = minAreaRect(quadPoints(quad));
  const aspect = fitted.width / Math.max(1, fitted.height);
  // The form says what shape the print is. The reader's box is too rough a
  // guide for shape — its aspect wanders by a fifth — so a fitted quad is
  // held to the declared print, not to the hint.
  const declaredAspect = spec.sizeMM.widthMM / spec.sizeMM.heightMM;
  const aspectRatio = Math.max(aspect / declaredAspect, declaredAspect / aspect);
  if (aspectRatio > MAX_ASPECT_RATIO) {
    return `the fitted shape is ${aspect.toFixed(2)}:1 where the form's print is ${declaredAspect.toFixed(2)}:1`;
  }
  const areaRatio = (fitted.width * fitted.height) / Math.max(1, expected.width * expected.height);
  if (areaRatio < AREA_RATIO.min || areaRatio > AREA_RATIO.max) {
    return `the fitted print is ${Math.round(areaRatio * 100)} % of the box it was measured at in area`;
  }
  const overlapBox = iou(bounds, expected);
  if (overlapBox < MIN_OVERLAP_WITH_BOX) {
    return `the fitted print overlaps the box it was measured at by only ${Math.round(overlapBox * 100)} %`;
  }
  const overlapHint = iou(bounds, hint);
  if (overlapHint < MIN_OVERLAP_WITH_HINT) {
    return `the fitted print overlaps the reader's box by only ${Math.round(overlapHint * 100)} %`;
  }
  return paperInside(patch, quad, paper);
}

/**
 * A print is continuous tone right up to its edges. A quad that took in a
 * strip of the page — the frame's margin, the rule under it, a line of
 * handwriting — has a band of paper just inside one of its edges, which no
 * photograph has.
 */
function paperInside(patch: Rgb, quad: Quad, paper: { readonly paperLevel: number; readonly sigmaLightness: number }): string | null {
  const paperAbove = paper.paperLevel - Math.max(12, 3 * paper.sigmaLightness);
  const bands: { name: string; a: Quad["tl"]; b: Quad["tl"]; inward: { x: number; y: number } }[] = [
    { name: "top", a: quad.tl, b: quad.tr, inward: { x: 0, y: 1 } },
    { name: "right", a: quad.tr, b: quad.br, inward: { x: -1, y: 0 } },
    { name: "bottom", a: quad.br, b: quad.bl, inward: { x: 0, y: -1 } },
    { name: "left", a: quad.bl, b: quad.tl, inward: { x: 1, y: 0 } },
  ];
  const across = Math.min(Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y), Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y));
  const depth = Math.max(4, INNER_BAND_FRACTION * across);
  for (const band of bands) {
    let blank = 0;
    let total = 0;
    for (let t = 0.1; t <= 0.9; t += 0.05) {
      const px = band.a.x + (band.b.x - band.a.x) * t;
      const py = band.a.y + (band.b.y - band.a.y) * t;
      for (let d = depth * 0.25; d <= depth; d += Math.max(1, depth / 6)) {
        const x = Math.round(px + band.inward.x * d);
        const y = Math.round(py + band.inward.y * d);
        if (x < 0 || y < 0 || x >= patch.width || y >= patch.height) continue;
        const p = (y * patch.width + x) * patch.channels;
        const r = patch.data[p]!;
        const g = patch.data[p + 1]!;
        const b = patch.data[p + 2]!;
        const l = 0.299 * r + 0.587 * g + 0.114 * b;
        total += 1;
        if (l >= paperAbove && Math.max(r, g, b) - Math.min(r, g, b) <= 40) blank += 1;
      }
    }
    if (total >= 12 && blank / total > MAX_PAPER_INSIDE) {
      return `the ${band.name} edge has blank paper just inside it — the quad took in part of the page`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Painting out the edges that are not the print's
// ---------------------------------------------------------------------------

/**
 * The patch with the edges that are NOT the print's painted over in paper.
 *
 * Two kinds compete with a pasted print on a raw capture, and both beat it
 * on step strength: the page's own edge against the desk, and the form's
 * printed rules — the section line under the photo frame, a heading's
 * underline. The first is a dark region that reaches the patch's border;
 * the second is what `prepareChannels` already isolates as `rules`. Both are
 * filled with the paper's own colour, so the detector that fits the print's
 * edges never sees them.
 *
 * Dark regions that reach the border are kept only if they run along a
 * whole side or wrap a corner — a print's dark clothing, cut through by a
 * region that missed part of the print, touches one side for part of its
 * length and must stay. And a dark region's blurred fringe, the ramp from
 * dark to paper, is a step of its own, so the paint reaches a millimetre
 * past what the fill found.
 */
function withoutCompetingEdges(patch: Rgb, channels: ScanChannels, pxPerMM: number): Rgb {
  const { width, height } = patch;
  const paperLevel = channels.paper.paperLevel;
  const inkBelow = 0.35 * paperLevel;

  const lum = new Float32Array(width * height);
  let paperR = 0;
  let paperG = 0;
  let paperB = 0;
  let paperCount = 0;
  for (let i = 0; i < lum.length; i += 1) {
    const p = i * patch.channels;
    const r = patch.data[p]!;
    const g = patch.data[p + 1]!;
    const b = patch.data[p + 2]!;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    lum[i] = l;
    if (l >= paperLevel - 8 && Math.max(r, g, b) - Math.min(r, g, b) <= 30) {
      paperR += r;
      paperG += g;
      paperB += b;
      paperCount += 1;
    }
  }
  const paint = paperCount > 0 ? [paperR / paperCount, paperG / paperCount, paperB / paperCount] : [paperLevel, paperLevel, paperLevel];

  const mask = new Uint8Array(width * height);
  const label = new Int32Array(width * height);
  const sides: { top: number; bottom: number; left: number; right: number }[] = [];
  const stack: number[] = [];
  const isDark = (i: number) => lum[i]! < inkBelow;
  const seedsAlong = (x: number, y: number, side: keyof (typeof sides)[number]) => {
    const i = y * width + x;
    if (label[i] || !isDark(i)) {
      if (label[i]) sides[label[i]! - 1]![side] += 1;
      return;
    }
    const id = sides.push({ top: 0, bottom: 0, left: 0, right: 0 });
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const jx = j % width;
      const jy = (j - jx) / width;
      const visit = (k: number) => {
        if (label[k] || !isDark(k)) return;
        label[k] = id;
        stack.push(k);
      };
      if (jx > 0) visit(j - 1);
      if (jx < width - 1) visit(j + 1);
      if (jy > 0) visit(j - width);
      if (jy < height - 1) visit(j + width);
    }
    sides[id - 1]![side] += 1;
  };
  for (let x = 0; x < width; x += 1) {
    seedsAlong(x, 0, "top");
    seedsAlong(x, height - 1, "bottom");
  }
  for (let y = 0; y < height; y += 1) {
    seedsAlong(0, y, "left");
    seedsAlong(width - 1, y, "right");
  }
  const keep = sides.map((touch) => {
    const touched = [touch.top > 0, touch.bottom > 0, touch.left > 0, touch.right > 0].filter(Boolean).length;
    const longest = Math.max(touch.top / width, touch.bottom / width, touch.left / height, touch.right / height);
    return touched >= 2 || longest >= 0.85;
  });
  for (let i = 0; i < label.length; i += 1) {
    if (label[i] && keep[label[i]! - 1]) mask[i] = 1;
  }
  const filled = mask.slice();
  dilateInto(filled, mask, width, height, Math.max(2, Math.round(0.9 * pxPerMM)));
  dilateInto(channels.rules.data, mask, width, height, Math.max(2, Math.round(0.4 * pxPerMM)));
  if (!mask.some((value) => value)) return patch;

  const data = new Uint8ClampedArray(patch.data);
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    const p = i * patch.channels;
    data[p] = paint[0]!;
    data[p + 1] = paint[1]!;
    data[p + 2] = paint[2]!;
  }
  return { data, width, height, channels: patch.channels };
}

/** Marks in `into` every pixel within `radius` of a set pixel of `from`. */
function dilateInto(from: ArrayLike<number>, into: Uint8Array, width: number, height: number, radius: number): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!from[y * width + x]) continue;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -radius; dx <= radius; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= width) continue;
          into[yy * width + xx] = 1;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Searching: photograph-like blocks near the hint
// ---------------------------------------------------------------------------

interface Candidate {
  /** In source pixels. */
  readonly rect: Rect;
  /** Fraction of the block that is not paper: darker, coloured, or textured. */
  readonly content: number;
  /** Whether its tones look like a photograph's rather than a logo's or a code's. */
  readonly photoLike: boolean;
  readonly score: number;
}

interface Search {
  readonly candidates: readonly Candidate[];
  /** The hint itself, described the same way. */
  readonly hint: { readonly content: number; readonly photoLike: boolean };
}

/**
 * Blocks of not-paper about the hint's size, surrounded by paper, within
 * reach of the hint — ranked by how block-like they are and, mildly, by how
 * close they are to where the reader pointed, then each read out to its
 * own extent.
 *
 * "Not paper" is judged from the analysis channels, tile by tile. A
 * photograph is CONTINUOUS TONE: most of its pixels are neither paper white
 * nor ink black. Printed text is the opposite — paper with thin dark strokes
 * and almost nothing between — and by darkness or variance alone a title
 * block outscores a portrait. So a tile is content when mid-tones dominate
 * it, or it is coloured, or filled dark (clothing, or the desk), or plainly
 * more textured than paper while carrying no ink strokes — the last is what
 * sees a pale, grainy backdrop that by lightness alone is paper.
 */
function searchNear(analysis: Analysis, spec: PhotoDefinition, options: LocateOptions): Search {
  const { patch, pxPerMM, channels } = analysis;
  const { lab, texture, paper } = channels;
  const nothing: Search = { candidates: [], hint: { content: 0, photoLike: false } };

  const tile = Math.max(3, Math.round(1.8 * pxPerMM));
  const columns = Math.floor(patch.width / tile);
  const rows = Math.floor(patch.height / tile);
  if (columns < 4 || rows < 4) return nothing;
  const paperBelow = paper.paperLevel - Math.max(12, 3 * paper.sigmaLightness);
  const inkBelow = 0.35 * paper.paperLevel;
  const strokeBelow = 0.6 * paper.paperLevel;
  const chromaAbove = 6 + 3 * paper.sigmaChroma;
  const textureAbove = 2.2 * Math.max(0.25, paper.textureLevel);
  const content = new Uint8Array(columns * rows);
  const veryDark = new Uint8Array(columns * rows);
  for (let ty = 0; ty < rows; ty += 1) {
    for (let tx = 0; tx < columns; tx += 1) {
      let n = 0;
      let paperLike = 0;
      let dark = 0;
      let strokes = 0;
      let coloured = 0;
      let sumTexture = 0;
      for (let y = ty * tile; y < (ty + 1) * tile; y += 1) {
        const row = y * patch.width;
        for (let x = tx * tile; x < (tx + 1) * tile; x += 1) {
          const l = lab.L.data[row + x]!;
          const c = lab.chroma.data[row + x]!;
          n += 1;
          if (c > chromaAbove) coloured += 1;
          if (l < inkBelow) dark += 1;
          else if (l >= paperBelow && c <= chromaAbove) paperLike += 1;
          if (l < strokeBelow) strokes += 1;
          sumTexture += texture.data[row + x]!;
        }
      }
      const mid = (n - paperLike - dark) / n;
      const isDark = dark / n >= 0.6;
      const grainy = strokes / n < 0.02 && sumTexture / n > textureAbove;
      content[ty * columns + tx] = mid >= 0.45 || coloured / n >= 0.4 || isDark || grainy ? 1 : 0;
      veryDark[ty * columns + tx] = isDark ? 1 : 0;
    }
  }
  options.debug?.("tiles", { roi: analysis.roi, step: analysis.step, tile, columns, rows, content, veryDark, paper });

  const integral = integralImage(content, columns, rows);
  const integralDark = integralImage(veryDark, columns, rows);
  const sum = (table: Float64Array, x: number, y: number, w: number, h: number) => {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(columns, x + w);
    const y1 = Math.min(rows, y + h);
    if (x1 <= x0 || y1 <= y0) return { count: 0, area: 0 };
    const stride = columns + 1;
    const count = table[y1 * stride + x1]! - table[y0 * stride + x1]! - table[y1 * stride + x0]! + table[y0 * stride + x0]!;
    return { count, area: (x1 - x0) * (y1 - y0) };
  };
  const fraction = (x: number, y: number, w: number, h: number) => {
    const inner = sum(integral, x, y, w, h);
    return inner.count / Math.max(1, inner.area);
  };

  const hintA = analysis.toAnalysis(analysis.hint);
  const hintTiles = { x: hintA.x / tile, y: hintA.y / tile, w: hintA.width / tile, h: hintA.height / tile };
  const hintCx = hintTiles.x + hintTiles.w / 2;
  const hintCy = hintTiles.y + hintTiles.h / 2;
  const hintSize = Math.max(1, Math.min(hintTiles.w, hintTiles.h));

  // The reader's box says roughly how BIG the print is, not what shape: its
  // aspect wanders by a fifth. The form says the shape. Candidates take the
  // hint's area and the declared aspect, at a few scales.
  const declaredAspect = spec.sizeMM.widthMM / spec.sizeMM.heightMM;
  const baseWidth = Math.sqrt(hintTiles.w * hintTiles.h * declaredAspect);
  const raw: { x: number; y: number; w: number; h: number; content: number; score: number }[] = [];
  for (const size of SEARCH_SIZES) {
    const w = Math.max(2, Math.round(baseWidth * size));
    const h = Math.max(2, Math.round((baseWidth / declaredAspect) * size));
    if (w > columns || h > rows) continue;
    const ring = Math.max(1, Math.round(Math.min(w, h) * 0.12));
    for (let y = 0; y + h <= rows; y += 1) {
      for (let x = 0; x + w <= columns; x += 1) {
        const inner = sum(integral, x, y, w, h);
        const inside = inner.count / Math.max(1, inner.area);
        if (inside < MIN_CANDIDATE_CONTENT) continue;
        const outer = sum(integral, x - ring, y - ring, w + ring * 2, h + ring * 2);
        const outerDark = sum(integralDark, x - ring, y - ring, w + ring * 2, h + ring * 2);
        const innerDark = sum(integralDark, x, y, w, h);
        // Content in the ring, the desk excepted: it must not count against
        // a print pasted near the page's edge.
        const ringContent = outer.count - inner.count - (outerDark.count - innerDark.count);
        const around = ringContent / Math.max(1, outer.area - inner.area);
        const distance = Math.hypot(x + w / 2 - hintCx, y + h / 2 - hintCy) / hintSize;
        raw.push({ x, y, w, h, content: inside, score: inside - around - 0.05 * distance });
      }
    }
  }
  raw.sort((a, b) => b.score - a.score);

  const toSource = (b: { x: number; y: number; w: number; h: number }): Rect =>
    analysis.toSourceRect({ x: b.x * tile, y: b.y * tile, width: b.w * tile, height: b.h * tile });
  const looksLikeAPhotograph = (b: { x: number; y: number; w: number; h: number }) =>
    toneSpread(lab.L, { x: b.x * tile, y: b.y * tile, width: b.w * tile, height: b.h * tile }) >= MIN_BLOCK_TONE_SPREAD;

  // Each block is read out to its own extent: from its centre, content
  // continues in every direction until it stops, and that is the print's
  // edge to within a tile. It is indifferent to the things that mislead an
  // edge fitter — the boundary between a pale backdrop and dark clothing is
  // content on both sides. Near-duplicates are then dropped, and a block
  // that does not overlap the reader's box is not the print.
  const hintInTiles: Rect = { x: hintTiles.x, y: hintTiles.y, width: hintTiles.w, height: hintTiles.h };
  const kept: Candidate[] = [];
  for (const entry of raw) {
    const grown = extentOf(entry, fraction, columns, rows);
    if (iou({ x: grown.x, y: grown.y, width: grown.w, height: grown.h }, hintInTiles) < MIN_OVERLAP_WITH_HINT) continue;
    const rect = toSource(grown);
    if (kept.some((other) => iou(other.rect, rect) > 0.75)) continue;
    kept.push({ rect, content: fraction(grown.x, grown.y, grown.w, grown.h), photoLike: looksLikeAPhotograph(grown), score: entry.score });
    if (kept.length >= 6) break;
  }

  const hintBlock = { x: Math.round(hintTiles.x), y: Math.round(hintTiles.y), w: Math.max(1, Math.round(hintTiles.w)), h: Math.max(1, Math.round(hintTiles.h)) };
  return {
    candidates: kept,
    hint: { content: fraction(hintBlock.x, hintBlock.y, hintBlock.w, hintBlock.h), photoLike: looksLikeAPhotograph(hintBlock) },
  };
}

/**
 * The content around a block's centre, read out to where it stops: a strip
 * one tile wide is content while at least a third of it is, and the scan
 * runs from the centre outward on each side, twice, so the second pass uses
 * the first's width for its height and vice versa. Bounded to 1.8x the
 * block in each direction so a print merging into a dark band cannot grow
 * without limit. A strip that is content across the WHOLE region is a
 * printed rule or a band, never the print — the region is several prints
 * wide — and the tile grid can swallow the paper gap between such a band
 * and the print, so the scan stops at one rather than reading through it.
 */
function extentOf(
  block: { x: number; y: number; w: number; h: number },
  fraction: (x: number, y: number, w: number, h: number) => number,
  columns: number,
  rows: number,
): { x: number; y: number; w: number; h: number } {
  const STILL_CONTENT = 0.35;
  const PAGE_WIDE = 0.85;
  const rowIsBand = (row: number) => fraction(0, row, columns, 1) >= PAGE_WIDE;
  const columnIsBand = (column: number) => fraction(column, 0, 1, rows) >= PAGE_WIDE;
  const maxW = Math.round(block.w * 1.8);
  const maxH = Math.round(block.h * 1.8);
  let { x, y, w, h } = block;
  for (let pass = 0; pass < 2; pass += 1) {
    const cx = Math.floor(x + w / 2);
    let left = cx;
    while (left > 0 && cx - (left - 1) < maxW && !columnIsBand(left - 1) && fraction(left - 1, y, 1, h) >= STILL_CONTENT) left -= 1;
    let right = cx;
    while (right < columns - 1 && right + 1 - left < maxW && !columnIsBand(right + 1) && fraction(right + 1, y, 1, h) >= STILL_CONTENT) right += 1;
    x = left;
    w = right - left + 1;
    const cy = Math.floor(y + h / 2);
    let top = cy;
    while (top > 0 && cy - (top - 1) < maxH && !rowIsBand(top - 1) && fraction(x, top - 1, w, 1) >= STILL_CONTENT) top -= 1;
    let bottom = cy;
    while (bottom < rows - 1 && bottom + 1 - top < maxH && !rowIsBand(bottom + 1) && fraction(x, bottom + 1, w, 1) >= STILL_CONTENT) bottom += 1;
    y = top;
    h = bottom - top + 1;
  }
  return { x, y, w, h };
}

function integralImage(mask: Uint8Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const out = new Float64Array(stride * (height + 1));
  for (let y = 1; y <= height; y += 1) {
    let row = 0;
    for (let x = 1; x <= width; x += 1) {
      row += mask[(y - 1) * width + (x - 1)]!;
      out[y * stride + x] = out[(y - 1) * stride + x]! + row;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Geometry and pixels
// ---------------------------------------------------------------------------

function toRect(box: NormalizedBox, image: Rgb): Rect {
  const x = Math.round(box.x1 * image.width);
  const y = Math.round(box.y1 * image.height);
  return {
    x,
    y,
    width: Math.max(1, Math.round(box.x2 * image.width) - x),
    height: Math.max(1, Math.round(box.y2 * image.height) - y),
  };
}

function whyImplausible(rect: Rect, image: Rgb): string | null {
  if (rect.width < MIN_EDGE_PX || rect.height < MIN_EDGE_PX) {
    return `the reader's photo location is only ${rect.width}x${rect.height} px — too small to be a photograph`;
  }
  const areaFraction = (rect.width * rect.height) / (image.width * image.height);
  if (areaFraction > MAX_AREA_FRACTION) {
    return `the reader's photo location covers ${Math.round(areaFraction * 100)} % of the picture — that is the page, not a print`;
  }
  const aspect = rect.width / rect.height;
  if (aspect < ASPECT.min || aspect > ASPECT.max) {
    return `the reader's photo location is ${aspect.toFixed(2)}:1 — not the shape of a photograph`;
  }
  return null;
}

function pad(rect: Rect, padX: number, padY: number): Rect {
  return {
    x: Math.round(rect.x - padX),
    y: Math.round(rect.y - padY),
    width: Math.round(rect.width + padX * 2),
    height: Math.round(rect.height + padY * 2),
  };
}

function clip(rect: Rect, image: Rgb): Rect {
  const x = Math.max(0, Math.min(image.width - 1, rect.x));
  const y = Math.max(0, Math.min(image.height - 1, rect.y));
  const right = Math.max(x + 1, Math.min(image.width, rect.x + rect.width));
  const bottom = Math.max(y + 1, Math.min(image.height, rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function quadBounds(quad: Quad): Rect {
  const xs = [quad.tl.x, quad.tr.x, quad.br.x, quad.bl.x];
  const ys = [quad.tl.y, quad.tr.y, quad.br.y, quad.bl.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** Copies a rectangle of pixels out of the source, as RGB. The rectangle must lie inside the source. */
function extractPatch(source: Rgb, rect: Rect): Rgb {
  const channels = source.channels;
  const data = new Uint8ClampedArray(rect.width * rect.height * 3);
  for (let row = 0; row < rect.height; row += 1) {
    const sourceRow = (rect.y + row) * source.width;
    const targetRow = row * rect.width;
    for (let column = 0; column < rect.width; column += 1) {
      const s = (sourceRow + rect.x + column) * channels;
      const t = (targetRow + column) * 3;
      data[t] = source.data[s]!;
      data[t + 1] = source.data[s + 1]!;
      data[t + 2] = source.data[s + 2]!;
    }
  }
  return { data, width: rect.width, height: rect.height, channels: 3 };
}

/**
 * Copies a rectangle out of the source at every `step`-th pixel, with the
 * part that lies beyond the source filled in white — a print near the
 * page's corner still gets a region of the size the analysis needs.
 */
function extractPatchPadded(source: Rgb, rect: Rect, step: number): Rgb {
  const channels = source.channels;
  const width = Math.max(1, Math.floor(rect.width / step));
  const height = Math.max(1, Math.floor(rect.height / step));
  const data = new Uint8ClampedArray(width * height * 3).fill(255);
  for (let row = 0; row < height; row += 1) {
    const sy = rect.y + row * step;
    if (sy < 0 || sy >= source.height) continue;
    const sourceRow = sy * source.width;
    const targetRow = row * width;
    for (let column = 0; column < width; column += 1) {
      const sx = rect.x + column * step;
      if (sx < 0 || sx >= source.width) continue;
      const s = (sourceRow + sx) * channels;
      const t = (targetRow + column) * 3;
      data[t] = source.data[s]!;
      data[t + 1] = source.data[s + 1]!;
      data[t + 2] = source.data[s + 2]!;
    }
  }
  return { data, width, height, channels: 3 };
}

/** Downscales in one resample when the long edge is over `maxEdge`; otherwise the image itself. */
function fitWithin(image: Rgb, maxEdge: number): Rgb {
  const longest = Math.max(image.width, image.height);
  if (longest <= maxEdge) return image;
  const scale = maxEdge / longest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const whole: Quad = {
    tl: { x: 0, y: 0 },
    tr: { x: image.width - 1, y: 0 },
    br: { x: image.width - 1, y: image.height - 1 },
    bl: { x: 0, y: image.height - 1 },
  };
  return warpQuadRgb(image, whole, width, height);
}
