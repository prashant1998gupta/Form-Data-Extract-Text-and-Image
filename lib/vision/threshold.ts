/**
 * Binarization and illumination correction.
 *
 * A phone photo of a paper form is never evenly lit. There is a bright hotspot
 * where the ceiling light reflects, a gradient toward the shadow of the hand
 * holding the phone, and often the shadow of the phone itself across one
 * corner. A single global threshold picked on such an image does one of two
 * things: it keeps the shadowed half of the page as solid ink, or it drops the
 * handwriting in the bright half entirely. Both are catastrophic downstream —
 * connected-component analysis on "the whole left side of the page is one
 * component" tells you nothing.
 *
 * So the order is always: estimate and divide out the illumination first, then
 * threshold locally. `binarizeDocument()` does both and is what callers should
 * reach for; the pieces are exported for tests and for the rare caller that
 * needs one half.
 *
 * Reminder from types.ts: a `Mask` is 255 where the INK is. All of these invert.
 */

import { createGray, createMask, type Gray, type Mask } from "./types.ts";
import { histogram, percentile, resizeGray } from "./gray.ts";
import { boxMean, boxVariance, integralOf, integralPairOf } from "./integral.ts";

/**
 * Otsu's method: the global threshold that minimises intra-class variance.
 *
 * Kept because it is the right tool for a *crop* that is already evenly lit —
 * a photo region, a signature box extracted from a corrected page — where its
 * global nature is a feature (stable, no window-size parameter) rather than the
 * liability it is on a full page.
 */
export function otsuThreshold(image: Gray): number {
  const bins = histogram(image);
  const total = image.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * bins[i]!;

  let sumBackground = 0;
  let weightBackground = 0;
  let best = 0;
  let bestVariance = -1;

  for (let t = 0; t < 256; t += 1) {
    weightBackground += bins[t]!;
    if (weightBackground === 0) continue;
    const weightForeground = total - weightBackground;
    if (weightForeground === 0) break;
    sumBackground += t * bins[t]!;
    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sum - sumBackground) / weightForeground;
    const delta = meanBackground - meanForeground;
    const between = weightBackground * weightForeground * delta * delta;
    if (between > bestVariance) {
      bestVariance = between;
      best = t;
    }
  }
  return best;
}

/** Threshold at a fixed level. Ink is anything at or below `level`. */
export function binarize(image: Gray, level: number): Mask {
  const out = createMask(image.width, image.height);
  for (let i = 0; i < image.data.length; i += 1) {
    out.data[i] = image.data[i]! <= level ? 255 : 0;
  }
  return out;
}

export function binarizeOtsu(image: Gray): Mask {
  return binarize(image, otsuThreshold(image));
}

/**
 * Sauvola's local threshold:
 *
 *     T(x,y) = m(x,y) · [ 1 + k · ( s(x,y)/R − 1 ) ]
 *
 * where m and s are the local mean and standard deviation over a window, R is
 * the dynamic range of the standard deviation (128 for 8-bit), and k controls
 * how aggressively low-contrast regions are pushed toward background.
 *
 * Why Sauvola rather than plain adaptive-mean: on a *blank* region the local
 * standard deviation is near zero, so the bracket collapses to (1 − k) and the
 * threshold drops well below the local mean — blank paper stays blank. Adaptive
 * mean has no such term and turns every empty region into a field of noise
 * speckle, which then has to be cleaned up by morphology that also eats thin
 * strokes. Sauvola is why the ink masks here are clean enough to run
 * connected-component statistics on directly.
 *
 * @param window Side length in pixels. Should be comfortably larger than the
 *   thickest stroke — roughly 1.5-2x the expected pen width in the working
 *   resolution. `binarizeDocument` derives it from image size.
 * @param k Higher = more conservative (less ink). 0.2 is Sauvola's original;
 *   0.3-0.35 suits photocopies with grey backgrounds.
 */
export function sauvola(image: Gray, window = 25, k = 0.2, range = 128): Mask {
  const table = integralPairOf(image);
  const out = createMask(image.width, image.height);
  const half = Math.max(1, Math.floor(window / 2));
  for (let y = 0; y < image.height; y += 1) {
    const y0 = y - half;
    const y1 = y + half + 1;
    for (let x = 0; x < image.width; x += 1) {
      const mean = boxMean(table, x - half, y0, x + half + 1, y1);
      const std = Math.sqrt(boxVariance(table, x - half, y0, x + half + 1, y1));
      const threshold = mean * (1 + k * (std / range - 1));
      out.data[y * image.width + x] = image.data[y * image.width + x]! <= threshold ? 255 : 0;
    }
  }
  return out;
}

/**
 * Adaptive mean threshold: ink where the pixel is more than `offset` below the
 * local mean. Cruder than Sauvola but it has no variance term, which makes it
 * the better choice on an image that has ALREADY been illumination-corrected
 * and where we want to catch faint strokes Sauvola's low-variance damping would
 * suppress. Used as the second opinion in the ink-mask union.
 */
export function adaptiveMean(image: Gray, window = 25, offset = 10): Mask {
  const table = integralOf(image);
  const out = createMask(image.width, image.height);
  const half = Math.max(1, Math.floor(window / 2));
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const mean = boxMean(table, x - half, y - half, x + half + 1, y + half + 1);
      out.data[y * image.width + x] = image.data[y * image.width + x]! <= mean - offset ? 255 : 0;
    }
  }
  return out;
}

/**
 * Estimates the page illumination — the "what colour is the paper here" field —
 * by heavily downsampling, which averages away every stroke, then resampling
 * back up.
 *
 * This is a box-blur with an enormous kernel, done in O(n) by changing
 * resolution instead of convolving. At a 32px working grid a line of
 * handwriting occupies a fraction of one cell, so it perturbs that cell's mean
 * by a few levels while a real shadow moves it by fifty. The alternative,
 * morphological opening with a large structuring element, costs far more and
 * gains nothing on documents.
 *
 * A large `grid` follows the illumination more closely, which removes shadows
 * better but also starts eating large dark objects — including the pasted
 * photograph. 24-40 is the usable band.
 */
export function estimateIllumination(image: Gray, grid = 32): Gray {
  const w = Math.max(1, Math.round(image.width / grid));
  const h = Math.max(1, Math.round(image.height / grid));
  const small = resizeGray(image, w, h);
  return resizeGray(small, image.width, image.height);
}

/**
 * Divides out the illumination field, flattening the page to a uniform paper
 * tone while preserving the *relative* darkness of ink.
 *
 * The result is scaled so paper lands at `target` (default 220 rather than 255,
 * leaving headroom so a slightly-brighter-than-background speck does not clip
 * and vanish). Division, not subtraction: illumination is multiplicative — a
 * shadow halves both paper and ink — so subtracting it leaves ink in shadowed
 * regions systematically darker than ink in lit regions, and any later
 * intensity comparison across the page is then wrong.
 */
export function flattenIllumination(image: Gray, grid = 32, target = 220): Gray {
  const field = estimateIllumination(image, grid);
  const out = createGray(image.width, image.height);
  for (let i = 0; i < image.data.length; i += 1) {
    const base = field.data[i]!;
    // A near-black illumination estimate means the region is genuinely dark
    // (a photograph, a heavy stamp), not shadowed paper. Dividing by it would
    // amplify sensor noise into a blizzard, so those pixels pass through.
    out.data[i] = base < 16 ? image.data[i]! : (image.data[i]! * target) / base;
  }
  return out;
}

export interface DocumentBinarization {
  /** Ink mask, 255 where writing or print is. */
  readonly ink: Mask;
  /** The illumination-corrected grayscale the mask came from. Reused by later stages. */
  readonly flattened: Gray;
  /** Estimated paper level after flattening — a sanity signal, not a tuning knob. */
  readonly paperLevel: number;
}

/**
 * The standard document path: flatten, then threshold with Sauvola, then union
 * in an adaptive-mean pass to recover faint strokes.
 *
 * The union is deliberate. Sauvola under-segments faint pencil and photocopied
 * ballpoint because their local variance is low; adaptive-mean catches those
 * but speckles blank regions. Sauvola's clean background dominates the union
 * everywhere the page is empty (adaptive-mean's speckle is isolated single
 * pixels, removed by the caller's opening step), while adaptive-mean
 * contributes exactly the faint strokes Sauvola dropped. Neither alone is good
 * enough on the photocopied forms this product will actually see.
 *
 * Window size scales with the image so behaviour is resolution-independent:
 * the same form at 1200px and 2400px produces the same mask, which is what
 * makes the downstream shape statistics comparable across devices.
 */
export function binarizeDocument(
  image: Gray,
  options: { windowFraction?: number; k?: number; meanOffset?: number; grid?: number } = {},
): DocumentBinarization {
  const { windowFraction = 1 / 40, k = 0.25, meanOffset = 12, grid = 32 } = options;
  const flattened = flattenIllumination(image, grid);
  // Odd window, floor 15px: below that the window is smaller than a stroke is
  // thick and Sauvola starts thresholding the *inside* of a stroke as paper,
  // hollowing every letter into an outline.
  const window = Math.max(15, Math.round(Math.min(image.width, image.height) * windowFraction) | 1);
  const strict = sauvola(flattened, window, k);
  const loose = adaptiveMean(flattened, window, meanOffset);
  const ink = createMask(image.width, image.height);
  for (let i = 0; i < ink.data.length; i += 1) {
    ink.data[i] = strict.data[i]! !== 0 || loose.data[i]! !== 0 ? 255 : 0;
  }
  return { ink, flattened, paperLevel: percentile(flattened, 0.9) };
}

/** Pixel count where the mask is set. */
export function maskCount(mask: Mask): number {
  let count = 0;
  for (let i = 0; i < mask.data.length; i += 1) if (mask.data[i]! !== 0) count += 1;
  return count;
}

export function maskUnion(a: Mask, b: Mask): Mask {
  assertSameSize(a, b, "maskUnion");
  const out = createMask(a.width, a.height);
  for (let i = 0; i < a.data.length; i += 1) out.data[i] = a.data[i]! !== 0 || b.data[i]! !== 0 ? 255 : 0;
  return out;
}

export function maskIntersection(a: Mask, b: Mask): Mask {
  assertSameSize(a, b, "maskIntersection");
  const out = createMask(a.width, a.height);
  for (let i = 0; i < a.data.length; i += 1) out.data[i] = a.data[i]! !== 0 && b.data[i]! !== 0 ? 255 : 0;
  return out;
}

/** Pixels in `a` that are not in `b`. This is the operation template differencing is built on. */
export function maskSubtract(a: Mask, b: Mask): Mask {
  assertSameSize(a, b, "maskSubtract");
  const out = createMask(a.width, a.height);
  for (let i = 0; i < a.data.length; i += 1) out.data[i] = a.data[i]! !== 0 && b.data[i]! === 0 ? 255 : 0;
  return out;
}

export function maskInvert(mask: Mask): Mask {
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) out.data[i] = mask.data[i]! !== 0 ? 0 : 255;
  return out;
}

function assertSameSize(a: Mask, b: Mask, who: string) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`${who}: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
}
