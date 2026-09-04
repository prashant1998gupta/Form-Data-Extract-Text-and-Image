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
 * model call names where the pasted print is, as a box in fractions of the
 * picture, and the crop is taken there.
 *
 * WHAT THE MODEL DOES NOT DO. It never hands back pixels. The crop is cut from
 * the uploaded capture; nothing is generated. And its box is a hint, not a
 * measurement: inside a patch around it, the same edge-fitting detector as
 * before measures the print's four sides and delivers it upright at print
 * resolution. Only when that measurement fails is the hint itself cut, at
 * lower confidence and flagged for a person to look at — and a hint that
 * lands on blank paper is refused rather than delivered as a photograph.
 */

import type { PhotoDefinition } from "../forms/definitions.ts";
import { prepareChannels } from "../ink/normalize.ts";
import { REGION_PARAMS } from "../regions/params.ts";
import { detectPhoto, type PhotoDetection } from "../regions/photo.ts";
import { renderPhotoCrop } from "../regions/postprocess.ts";
import { minAreaRect } from "../vision/geometry.ts";
import { encodeRgbPng } from "../vision/io.ts";
import { quadPoints, type Quad, type Rect, type Rgb } from "../vision/types.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";

/** A box as fractions of the image: 0 is the left/top edge, 1 the right/bottom. */
export interface NormalizedBox {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * Turns the reader's four numbers into fractions of the image.
 *
 * The prompt asks for thousandths (0-1000). Models sometimes answer in 0-1
 * fractions instead, or in pixels of the image they were shown; the scale is
 * inferred from the largest value, which is unambiguous for anything but a
 * photograph in the top-left corner of a picture under 1000 px — a case the
 * forms this app reads do not produce. Reversed corners are put right and
 * everything is clamped to the picture.
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

export type LocatedPhoto =
  | {
      readonly found: true;
      readonly png: Buffer;
      readonly width: number;
      readonly height: number;
      readonly confidence: number;
      /** Low confidence, low resolution, or an unmeasured cut — a person should look before saving. */
      readonly needsReview: boolean;
      /** `measured`: four edges fitted and the print warped upright. `located`: the reader's box, cut as is. */
      readonly method: "measured" | "located";
      readonly lowResolution: boolean;
      readonly detail: string;
    }
  | {
      readonly found: false;
      readonly reason: "no_photo" | "implausible_box" | "empty_box";
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
/** Paper around the hint for the detector to measure against, as a fraction of the hint's own size, each side. */
const PATCH_PAD = 0.35;
/** Below this the print is a thumbnail and edge fitting has nothing to work with. */
const MIN_PX_PER_MM = 1.5;
/** The hint is cut a little generous, so a tight box does not shave the print. */
const FALLBACK_PAD = 0.03;
const FALLBACK_MAX_EDGE = 900;
/** Above this fraction of paper-coloured pixels the hint is blank, whatever the reader said. */
const PAPER_FRACTION_EMPTY = 0.75;
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

  // The print's size on the paper is the form's declaration; the hint's size
  // in pixels then says how many pixels a millimetre is, which is what every
  // threshold in the detector is expressed in.
  const pxPerMM = (hint.width / spec.sizeMM.widthMM + hint.height / spec.sizeMM.heightMM) / 2;

  let detection: PhotoDetection | null = null;
  let patch: Rgb | null = null;
  if (pxPerMM >= MIN_PX_PER_MM) {
    const patchRect = clip(pad(hint, PATCH_PAD * hint.width, PATCH_PAD * hint.height), source);
    patch = extractPatch(source, patchRect);
    const expected: Rect = { x: hint.x - patchRect.x, y: hint.y - patchRect.y, width: hint.width, height: hint.height };
    try {
      const channels = prepareChannels(patch, { pxPerMM, imageRegions: [expected] });
      detection = detectPhoto({
        lab: channels.lab,
        texture: channels.texture,
        ink: channels.ink,
        paper: channels.paper,
        expected,
        sizeMM: spec.sizeMM,
        // Wide on purpose: the scale was derived from the hint, and a hint
        // drawn a little generous or a little tight must not fail the print
        // it contains for being "the wrong size".
        sizeTolerance: { min: 0.6, max: 1.7 },
        pxPerMM,
        pageSaturatedFraction: channels.saturatedFraction,
        prior: { sigmaMM: 6, bandMM: 12 },
      });
    } catch (error) {
      // The detector is measured code, but a patch is a new kind of input for
      // it; a fault here must cost the measurement, never the photograph.
      console.warn("photo measurement failed; cutting the reader's box instead", error);
      detection = null;
    }
  }

  if (detection?.found && patch) {
    const crop = renderPhotoCrop(patch, detection.quad, measuredSizeMM(detection.quad, pxPerMM), pxPerMM, options.targetDpi ?? 300);
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
      detail: crop.lowResolution
        ? `located by the reader and measured, but the capture only carries ${crop.effectiveDpi} dpi of it — photograph the form closer for a sharper print`
        : `located by the reader and measured at ${Math.round(confidence * 100)} % confidence`,
    };
  }

  if (detection && !detection.found && detection.reason === "box_empty") {
    return { found: false, reason: "empty_box", detail: "the reader pointed at the photo frame, but it is empty" };
  }

  // The hint itself. A real photograph is there according to the reader; what
  // could not be established is exactly where its edges are.
  const cutRect = clip(pad(hint, FALLBACK_PAD * hint.width, FALLBACK_PAD * hint.height), source);
  const cut = extractPatch(source, cutRect);
  if (paperFraction(cut) > PAPER_FRACTION_EMPTY) {
    return { found: false, reason: "empty_box", detail: "the reader pointed at a mostly blank area, not a photograph" };
  }
  const delivered = fitWithin(cut, FALLBACK_MAX_EDGE);
  const why = detection && !detection.found ? detection.detail : "the print is too small in this capture to measure";
  return {
    found: true,
    png: await encodeRgbPng(delivered),
    width: delivered.width,
    height: delivered.height,
    confidence: LOCATED_CONFIDENCE,
    needsReview: true,
    method: "located",
    lowResolution: false,
    detail: `cut where the reader located it; its edges could not be measured (${why}), so check the crop`,
  };
}

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

/** The fraction of pixels that are paper: light and colourless. */
function paperFraction(image: Rgb): number {
  const step = image.channels;
  let paper = 0;
  let total = 0;
  for (let p = 0; p < image.data.length; p += step) {
    const r = image.data[p]!;
    const g = image.data[p + 1]!;
    const b = image.data[p + 2]!;
    const low = Math.min(r, g, b);
    const high = Math.max(r, g, b);
    if (low >= 190 && high - low <= 40) paper += 1;
    total += 1;
  }
  return total === 0 ? 1 : paper / total;
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
