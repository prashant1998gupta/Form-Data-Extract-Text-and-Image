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
 * WHAT THE HINT IS WORTH. Measured on real replies, the model's box is right
 * to within a tenth or so of the picture and no better — enough to say which
 * corner of the page the print is in, not where its edges are. So the hint
 * is a region to search, never a crop: the print's own edges are measured by
 * the same edge-fitting detector as before, first where the reader pointed,
 * then at the most photograph-like blocks nearby. Only when no edges can be
 * measured anywhere is the best block cut as it is, at low confidence and
 * flagged for a person; a hint with nothing photograph-like near it is
 * refused rather than delivered.
 *
 * WHAT THE MODEL DOES NOT DO. It never hands back pixels. The crop is cut
 * from the uploaded capture; nothing is generated.
 */

import type { PhotoDefinition } from "../forms/definitions.ts";
import { prepareChannels } from "../ink/normalize.ts";
import { REGION_PARAMS } from "../regions/params.ts";
import { detectPhoto } from "../regions/photo.ts";
import { renderPhotoCrop } from "../regions/postprocess.ts";
import { minAreaRect } from "../vision/geometry.ts";
import { encodeRgbPng } from "../vision/io.ts";
import { iou, quadPoints, type Quad, type Rect, type Rgb } from "../vision/types.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";

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
      readonly detail: string;
    }
  | {
      readonly found: false;
      readonly reason: "no_photo" | "implausible_box" | "not_found";
      readonly detail: string;
    };

export interface LocateOptions {
  readonly targetDpi?: number;
}

/** A hint smaller than this on either side is not a photograph in a form photo. */
const MIN_EDGE_PX = 40;
/** A hint covering more of the picture than this is the page, not a print on it. */
const MAX_AREA_FRACTION = 0.4;
const ASPECT = { min: 0.35, max: 2 };
/** Paper around a candidate for the detector to measure against, as a fraction of its size, each side. */
const PATCH_PAD = 0.35;
/** Below this the print is a thumbnail and edge fitting has nothing to work with. */
const MIN_PX_PER_MM = 1.5;
/** How far around the hint the search reaches, in hint widths and heights, each side. */
const SEARCH_REACH = 1.5;
/** The search runs on a copy no bigger than this, whatever the capture's resolution. */
const SEARCH_PIXELS = 700_000;
const SEARCH_SIZES = [0.8, 1, 1.2] as const;
/** How many nearby blocks get a full measurement before the best is cut as it is. */
const MAX_MEASURED_CANDIDATES = 3;
/** A block is worth measuring when at least this much of it is not paper. */
const MIN_CANDIDATE_CONTENT = 0.3;
/** A block is worth cutting unmeasured only when it is plainly not paper... */
const MIN_BLOCK_CONTENT = 0.5;
/** ...and carries the tonal range of a photograph rather than a logo or a code. */
const MIN_BLOCK_TONE_SPREAD = 22;
const MIN_BLOCK_MIDTONES = 0.3;
/** A block is cut a little generous, so a tight box does not shave the print. */
const CUT_PAD = 0.03;
const CUT_MAX_EDGE = 900;
/** What an unmeasured cut is worth. Below the review line by design. */
const LOCATED_CONFIDENCE = 0.5;

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

  // 1. Where the reader pointed.
  const atHint = await measureAt(source, hint, spec, options);
  if (atHint.found) return atHint.photo;

  // 2. The photograph-like blocks near it, most likely first.
  const candidates = searchNear(source, hint);
  for (const candidate of candidates.slice(0, MAX_MEASURED_CANDIDATES)) {
    const attempt = await measureAt(source, candidate.rect, spec, options);
    if (attempt.found) return attempt.photo;
  }

  // 3. The best block, cut as it is — a real photograph is there by every
  // cheap measure; what could not be established is exactly where its edges are.
  const block = candidates.find((candidate) => candidate.content >= MIN_BLOCK_CONTENT && candidate.photoLike);
  const hintBlock = block ? null : describeBlock(source, hint);
  const cutRect = block?.rect ?? (hintBlock && hintBlock.content >= MIN_BLOCK_CONTENT && hintBlock.photoLike ? hint : null);
  if (!cutRect) {
    return { found: false, reason: "not_found", detail: "no photograph was found near where the reader pointed" };
  }
  const cut = extractPatch(source, clip(pad(cutRect, CUT_PAD * cutRect.width, CUT_PAD * cutRect.height), source));
  const delivered = fitWithin(cut, CUT_MAX_EDGE);
  return {
    found: true,
    png: await encodeRgbPng(delivered),
    width: delivered.width,
    height: delivered.height,
    confidence: LOCATED_CONFIDENCE,
    needsReview: true,
    method: "located",
    lowResolution: false,
    detail: `cut near where the reader located it; its edges could not be measured (${atHint.detail}), so check the crop`,
  };
}

// ---------------------------------------------------------------------------
// Measuring: the detector, on a patch around one candidate rectangle
// ---------------------------------------------------------------------------

type Measurement = { readonly found: true; readonly photo: LocatedPhoto & { found: true } } | { readonly found: false; readonly detail: string };

async function measureAt(source: Rgb, rect: Rect, spec: PhotoDefinition, options: LocateOptions): Promise<Measurement> {
  // The print's size on the paper is the form's declaration; the rectangle's
  // size in pixels then says how many pixels a millimetre is, which is what
  // every threshold in the detector is expressed in.
  const pxPerMM = (rect.width / spec.sizeMM.widthMM + rect.height / spec.sizeMM.heightMM) / 2;
  if (pxPerMM < MIN_PX_PER_MM) return { found: false, detail: "the print is too small in this capture to measure" };

  const patchRect = clip(pad(rect, PATCH_PAD * rect.width, PATCH_PAD * rect.height), source);
  const patch = extractPatch(source, patchRect);
  const expected: Rect = { x: rect.x - patchRect.x, y: rect.y - patchRect.y, width: rect.width, height: rect.height };

  try {
    const channels = prepareChannels(patch, { pxPerMM, imageRegions: [expected] });
    const detection = detectPhoto({
      lab: channels.lab,
      texture: channels.texture,
      ink: channels.ink,
      paper: channels.paper,
      expected,
      sizeMM: spec.sizeMM,
      // Wide on purpose: the scale was derived from the rectangle, and a box
      // drawn a little generous or a little tight must not fail the print it
      // contains for being "the wrong size".
      sizeTolerance: { min: 0.6, max: 1.7 },
      pxPerMM,
      pageSaturatedFraction: channels.saturatedFraction,
      prior: { sigmaMM: 6, bandMM: 12 },
    });
    if (!detection.found) return { found: false, detail: detection.detail };

    // Delivered at the photograph's own measured shape: the print is whatever
    // the person pasted, and stretching it to a declared size would distort
    // the face.
    const crop = renderPhotoCrop(patch, detection.quad, measuredSizeMM(detection.quad, pxPerMM), pxPerMM, options.targetDpi ?? 300);
    const confidence = crop.lowResolution
      ? Math.min(detection.confidence, REGION_PARAMS.photo.lowResolutionConfidenceCap)
      : detection.confidence;
    return {
      found: true,
      photo: {
        found: true,
        png: await encodeRgbPng(crop.image),
        width: crop.width,
        height: crop.height,
        confidence,
        needsReview: confidence < 0.8 || crop.lowResolution,
        method: "measured",
        lowResolution: crop.lowResolution,
        detail: crop.lowResolution
          ? `located by the reader and measured, but the capture only carries ${crop.effectiveDpi} dpi of it — photograph the form closer for a sharper print`
          : `located by the reader and measured at ${Math.round(confidence * 100)} % confidence`,
      },
    };
  } catch (error) {
    // The detector is measured code, but a patch is a new kind of input for
    // it; a fault here must cost the measurement, never the photograph.
    console.warn("photo measurement failed", error);
    return { found: false, detail: "the measurement failed" };
  }
}

// ---------------------------------------------------------------------------
// Searching: photograph-like blocks near the hint
// ---------------------------------------------------------------------------

interface Candidate {
  readonly rect: Rect;
  /** Fraction of the block that is not paper. */
  readonly content: number;
  /** Whether its tones look like a photograph's rather than a logo's or a code's. */
  readonly photoLike: boolean;
  readonly score: number;
}

/**
 * Blocks of not-paper about the hint's size, surrounded by paper, within
 * reach of the hint — ranked by how block-like they are and, mildly, by how
 * close they are to where the reader pointed. Runs on a copy small enough to
 * be cheap on a 12 MP capture.
 */
function searchNear(source: Rgb, hint: Rect): Candidate[] {
  const roi = clip(pad(hint, SEARCH_REACH * hint.width, SEARCH_REACH * hint.height), source);
  const step = Math.max(1, Math.ceil(Math.sqrt((roi.width * roi.height) / SEARCH_PIXELS)));
  const width = Math.floor(roi.width / step);
  const height = Math.floor(roi.height / step);
  if (width < 8 || height < 8) return [];

  const lum = new Float32Array(width * height);
  const spread = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = ((roi.y + y * step) * source.width + roi.x + x * step) * source.channels;
      const r = source.data[p]!;
      const g = source.data[p + 1]!;
      const b = source.data[p + 2]!;
      lum[y * width + x] = 0.299 * r + 0.587 * g + 0.114 * b;
      spread[y * width + x] = Math.max(r, g, b) - Math.min(r, g, b);
    }
  }
  // Paper is whatever is light and colourless here — measured on this patch,
  // so a dim desk photo keeps its paper and a bright scan keeps its print.
  const paperWhite = percentile(lum, 0.85);
  const content = new Uint8Array(width * height);
  for (let i = 0; i < content.length; i += 1) {
    content[i] = lum[i]! >= 0.82 * paperWhite && spread[i]! <= 40 ? 0 : 1;
  }
  const integral = integralImage(content, width, height);
  const sum = (x: number, y: number, w: number, h: number) => {
    const x0 = Math.max(0, x);
    const y0 = Math.max(0, y);
    const x1 = Math.min(width, x + w);
    const y1 = Math.min(height, y + h);
    if (x1 <= x0 || y1 <= y0) return { count: 0, area: 0 };
    const stride = width + 1;
    const count = integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!;
    return { count, area: (x1 - x0) * (y1 - y0) };
  };

  const hintCx = (hint.x + hint.width / 2 - roi.x) / step;
  const hintCy = (hint.y + hint.height / 2 - roi.y) / step;
  const hintSize = Math.max(1, Math.min(hint.width, hint.height) / step);

  const raw: { x: number; y: number; w: number; h: number; content: number; score: number }[] = [];
  for (const size of SEARCH_SIZES) {
    const w = Math.max(4, Math.round((hint.width / step) * size));
    const h = Math.max(4, Math.round((hint.height / step) * size));
    if (w > width || h > height) continue;
    const stride = Math.max(2, Math.round(Math.min(w, h) / 10));
    const ring = Math.max(2, Math.round(Math.min(w, h) * 0.12));
    for (let y = 0; y + h <= height; y += stride) {
      for (let x = 0; x + w <= width; x += stride) {
        const inner = sum(x, y, w, h);
        const inside = inner.count / Math.max(1, inner.area);
        if (inside < MIN_CANDIDATE_CONTENT) continue;
        const outer = sum(x - ring, y - ring, w + ring * 2, h + ring * 2);
        const ringArea = Math.max(1, outer.area - inner.area);
        const around = (outer.count - inner.count) / ringArea;
        const distance = Math.hypot(x + w / 2 - hintCx, y + h / 2 - hintCy) / hintSize;
        raw.push({ x, y, w, h, content: inside, score: inside - around - 0.05 * distance });
      }
    }
  }
  raw.sort((a, b) => b.score - a.score);

  const kept: Candidate[] = [];
  for (const entry of raw) {
    const rect: Rect = { x: roi.x + entry.x * step, y: roi.y + entry.y * step, width: entry.w * step, height: entry.h * step };
    if (kept.some((other) => iou(other.rect, rect) > 0.5)) continue;
    kept.push({ rect, content: entry.content, photoLike: tonesLikeAPhotograph(lum, width, entry), score: entry.score });
    if (kept.length >= 8) break;
  }
  return kept;
}

/** The hint itself, described the way a search candidate is. */
function describeBlock(source: Rgb, rect: Rect): { content: number; photoLike: boolean } {
  const clipped = clip(rect, source);
  const patch = extractPatch(source, clipped);
  const lum = new Float32Array(patch.width * patch.height);
  let paper = 0;
  for (let i = 0; i < lum.length; i += 1) {
    const r = patch.data[i * 3]!;
    const g = patch.data[i * 3 + 1]!;
    const b = patch.data[i * 3 + 2]!;
    lum[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (Math.min(r, g, b) >= 190 && Math.max(r, g, b) - Math.min(r, g, b) <= 40) paper += 1;
  }
  return {
    content: 1 - paper / Math.max(1, lum.length),
    photoLike: tonesLikeAPhotograph(lum, patch.width, { x: 0, y: 0, w: patch.width, h: patch.height }),
  };
}

/**
 * Whether a block's tones are a photograph's: a wide spread with plenty of
 * mid-tones. A flat logo has few tones; a QR code has two and no middle.
 */
function tonesLikeAPhotograph(lum: Float32Array, width: number, block: { x: number; y: number; w: number; h: number }): boolean {
  let n = 0;
  let mean = 0;
  let m2 = 0;
  let mid = 0;
  for (let y = block.y; y < block.y + block.h; y += 1) {
    for (let x = block.x; x < block.x + block.w; x += 1) {
      const value = lum[y * width + x]!;
      n += 1;
      const delta = value - mean;
      mean += delta / n;
      m2 += delta * (value - mean);
      if (value >= 60 && value <= 200) mid += 1;
    }
  }
  if (n < 16) return false;
  const deviation = Math.sqrt(m2 / n);
  return deviation >= MIN_BLOCK_TONE_SPREAD && mid / n >= MIN_BLOCK_MIDTONES;
}

function percentile(values: Float32Array, fraction: number): number {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
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

/** Copies a rectangle of pixels out of the source, as RGB. */
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

/** The fitted rectangle's own dimensions, in millimetres of paper. */
function measuredSizeMM(quad: Quad, pxPerMM: number): { widthMM: number; heightMM: number } {
  const rect = minAreaRect(quadPoints(quad));
  return { widthMM: rect.width / pxPerMM, heightMM: rect.height / pxPerMM };
}
