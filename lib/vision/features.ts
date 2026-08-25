/**
 * Feature maps: the measurements that let a detector say what a region *is*.
 *
 * Everything here reduces an image to a per-pixel or per-block score that
 * separates one kind of content from another. The region detectors are then
 * mostly threshold-and-group logic over these maps, which keeps the hard part
 * (deciding what a passport photo looks like) in one testable place instead of
 * spread through the detectors.
 *
 * The four questions these answer, and which map answers each:
 *
 *   "is this a photograph?"       -> blockStats: high variance, low white
 *                                    fraction, sustained saturation
 *   "is this printed or written?" -> strokeWidth: printed type has a tight
 *                                    stroke-width distribution, handwriting
 *                                    a broad one
 *   "is this a thumbprint?"       -> ridgeEnergy: friction ridges have a
 *                                    narrow spatial-frequency peak nothing
 *                                    else on a form has
 *   "is there a real edge here?"  -> sobel: a pasted photo has four of them
 */

import { createF32, createGray, type F32, type Gray, type Mask, type Rect } from "./types.ts";
import { boxMean, boxVariance, integralOf, integralOfMask, integralPairOf, boxSum, boxArea } from "./integral.ts";

export interface Gradients {
  /** Gradient magnitude, unnormalized. */
  readonly magnitude: F32;
  /** Direction in radians, -PI..PI, pointing along the intensity gradient. */
  readonly direction: F32;
}

/**
 * 3x3 Sobel. Separable, so it runs as two 1-D passes: cost is 6 multiply-adds
 * per pixel instead of 18, which matters at 2400x1700.
 */
export function sobel(image: Gray): Gradients {
  const { width, height, data } = image;
  const magnitude = createF32(width, height);
  const direction = createF32(width, height);

  // Horizontal pass buffers: smooth [1 2 1] and difference [-1 0 1].
  const smoothX = new Float32Array(width * height);
  const diffX = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = data[row + Math.max(0, x - 1)]!;
      const centre = data[row + x]!;
      const right = data[row + Math.min(width - 1, x + 1)]!;
      smoothX[row + x] = left + 2 * centre + right;
      diffX[row + x] = right - left;
    }
  }

  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      // gx: difference horizontally, smoothed vertically.
      const gx = diffX[up + x]! + 2 * diffX[row + x]! + diffX[down + x]!;
      // gy: smoothed horizontally, differenced vertically.
      const gy = smoothX[down + x]! - smoothX[up + x]!;
      magnitude.data[row + x] = Math.hypot(gx, gy);
      direction.data[row + x] = Math.atan2(gy, gx);
    }
  }
  return { magnitude, direction };
}

export interface BlockStats {
  /** Number of blocks across and down. */
  readonly cols: number;
  readonly rows: number;
  readonly blockSize: number;
  /** Standard deviation of luma in each block. Photographs are high, paper is near zero. */
  readonly deviation: Float32Array;
  /** Mean luma. */
  readonly mean: Float32Array;
  /** Fraction of pixels above the paper threshold. Paper ~1.0, photographs ~0. */
  readonly whiteFraction: Float32Array;
  /** Mean HSV saturation. Colour photographs are high; print and ink are low. */
  readonly saturation: Float32Array;
  /** Mean gradient magnitude — texture density, high for both photos and dense text. */
  readonly edgeEnergy: Float32Array;
}

/**
 * Summarises the image on a coarse grid.
 *
 * A block grid rather than per-pixel because "is this a photograph" is a
 * question about a *neighbourhood*, not a pixel — a single mid-grey pixel is
 * equally at home in a face and in a printed logo. 16px blocks at the 2400px
 * working resolution is about 1.5mm on an A4 page: fine enough to trace the
 * outline of a 35x45mm photo to within a millimetre, coarse enough that a line
 * of text lands inside one or two blocks rather than being cut across dozens.
 */
export function blockStats(
  gray: Gray,
  saturationMap: Gray,
  options: { blockSize?: number; paperLevel?: number } = {},
): BlockStats {
  const { blockSize = 16, paperLevel = 190 } = options;
  const cols = Math.max(1, Math.ceil(gray.width / blockSize));
  const rows = Math.max(1, Math.ceil(gray.height / blockSize));

  const lumaTable = integralPairOf(gray);
  const saturationTable = integralOf(saturationMap);
  const { magnitude } = sobel(gray);
  // Gradient magnitude runs to ~1020 for a hard edge; compress to 8-bit for the
  // integral table. The absolute scale is never used, only relative comparisons.
  const edgeGray = createGray(gray.width, gray.height);
  for (let i = 0; i < edgeGray.data.length; i += 1) edgeGray.data[i] = magnitude.data[i]! / 4;
  const edgeTable = integralOf(edgeGray);

  const whiteMask = createGray(gray.width, gray.height);
  for (let i = 0; i < whiteMask.data.length; i += 1) whiteMask.data[i] = gray.data[i]! >= paperLevel ? 1 : 0;
  const whiteTable = integralOf(whiteMask);

  const deviation = new Float32Array(cols * rows);
  const mean = new Float32Array(cols * rows);
  const whiteFraction = new Float32Array(cols * rows);
  const saturation = new Float32Array(cols * rows);
  const edgeEnergy = new Float32Array(cols * rows);

  for (let by = 0; by < rows; by += 1) {
    const y0 = by * blockSize;
    const y1 = Math.min(gray.height, y0 + blockSize);
    for (let bx = 0; bx < cols; bx += 1) {
      const x0 = bx * blockSize;
      const x1 = Math.min(gray.width, x0 + blockSize);
      const index = by * cols + bx;
      const area = boxArea(lumaTable, x0, y0, x1, y1);
      if (area === 0) continue;
      deviation[index] = Math.sqrt(boxVariance(lumaTable, x0, y0, x1, y1));
      mean[index] = boxMean(lumaTable, x0, y0, x1, y1);
      whiteFraction[index] = boxSum(whiteTable, x0, y0, x1, y1) / area;
      saturation[index] = boxMean(saturationTable, x0, y0, x1, y1);
      edgeEnergy[index] = boxMean(edgeTable, x0, y0, x1, y1);
    }
  }

  return { cols, rows, blockSize, deviation, mean, whiteFraction, saturation, edgeEnergy };
}

/**
 * Chamfer distance transform: for every set pixel, the approximate distance to
 * the nearest background pixel.
 *
 * Two passes with the 3-4 chamfer weights, which approximate Euclidean distance
 * to within about 2% — far better than the 4-neighbour "city block" transform
 * (which is 41% wrong on diagonals) and enormously cheaper than an exact
 * Euclidean transform. Result is in units of 1/3 pixel; divide by 3.
 *
 * This is the engine behind stroke width. The distance transform of a stroke
 * peaks along its centreline at exactly half the stroke's thickness, which is
 * the cheapest reliable way to measure pen width without skeletonising.
 */
export function distanceTransform(mask: Mask): F32 {
  const { width, height, data } = mask;
  const out = createF32(width, height);
  const big = 1e9;
  for (let i = 0; i < data.length; i += 1) out.data[i] = data[i]! !== 0 ? big : 0;

  // Forward pass: north-west neighbours.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (out.data[i] === 0) continue;
      let best = out.data[i]!;
      if (y > 0) {
        if (x > 0) best = Math.min(best, out.data[i - width - 1]! + 4);
        best = Math.min(best, out.data[i - width]! + 3);
        if (x < width - 1) best = Math.min(best, out.data[i - width + 1]! + 4);
      }
      if (x > 0) best = Math.min(best, out.data[i - 1]! + 3);
      out.data[i] = best;
    }
  }

  // Backward pass: south-east neighbours.
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      if (out.data[i] === 0) continue;
      let best = out.data[i]!;
      if (y < height - 1) {
        if (x < width - 1) best = Math.min(best, out.data[i + width + 1]! + 4);
        best = Math.min(best, out.data[i + width]! + 3);
        if (x > 0) best = Math.min(best, out.data[i + width - 1]! + 4);
      }
      if (x < width - 1) best = Math.min(best, out.data[i + 1]! + 3);
      out.data[i] = best;
    }
  }

  for (let i = 0; i < out.data.length; i += 1) out.data[i] = out.data[i]! / 3;
  return out;
}

export interface StrokeWidthStats {
  /** Median stroke width in pixels. */
  readonly median: number;
  /** Standard deviation of stroke width across the region. */
  readonly deviation: number;
  /** deviation / median. The printed-vs-handwritten discriminator. */
  readonly variation: number;
  /** Number of ridge samples the estimate is based on. Below ~30 the numbers are noise. */
  readonly samples: number;
}

/**
 * Measures pen/type stroke width over a region.
 *
 * Samples the distance transform at its local ridges — pixels that are a local
 * maximum of the distance field are on a stroke's centreline, where the value
 * is half the stroke thickness.
 *
 * WHY THIS DISCRIMINATES: printed type is produced by a machine at one size, so
 * its stroke widths cluster tightly — `variation` typically under 0.30. A pen
 * held in a hand varies with pressure, speed and direction, and a signature
 * varies most of all because it is written fast; `variation` is typically above
 * 0.40. It is not a perfect separator on its own, which is why the detectors
 * combine it with fill ratio and position rather than trusting it alone.
 */
export function strokeWidthStats(mask: Mask, region?: Rect): StrokeWidthStats {
  const distance = distanceTransform(mask);
  const x0 = region ? Math.max(0, region.x) : 0;
  const y0 = region ? Math.max(0, region.y) : 0;
  const x1 = region ? Math.min(mask.width, region.x + region.width) : mask.width;
  const y1 = region ? Math.min(mask.height, region.y + region.height) : mask.height;

  const widths: number[] = [];
  for (let y = y0 + 1; y < y1 - 1; y += 1) {
    for (let x = x0 + 1; x < x1 - 1; x += 1) {
      const i = y * mask.width + x;
      const value = distance.data[i]!;
      if (value < 0.8) continue;
      // Ridge test: not exceeded by either neighbour on at least one axis.
      const horizontalRidge = value >= distance.data[i - 1]! && value >= distance.data[i + 1]!;
      const verticalRidge = value >= distance.data[i - mask.width]! && value >= distance.data[i + mask.width]!;
      if (horizontalRidge || verticalRidge) widths.push(value * 2);
    }
  }

  if (widths.length === 0) return { median: 0, deviation: 0, variation: 0, samples: 0 };
  widths.sort((a, b) => a - b);
  const median = widths[Math.floor(widths.length / 2)]!;
  let sum = 0;
  for (const w of widths) sum += (w - median) * (w - median);
  const deviation = Math.sqrt(sum / widths.length);
  return { median, deviation, variation: median > 0 ? deviation / median : 0, samples: widths.length };
}

/**
 * Energy in the friction-ridge spatial-frequency band.
 *
 * Human fingerprint ridges are spaced remarkably consistently — about 0.45mm
 * between ridge centres across adults. At a known page resolution that is a
 * specific pixel period, and no other mark on a hospital form has a strong,
 * *narrow* frequency peak there: handwriting is broadband, printed text peaks
 * at the character pitch, blank paper has nothing, and a photograph's texture
 * is broadband too.
 *
 * Measured without an FFT, by comparing the response of two box filters (a
 * difference-of-means band-pass) tuned to the ridge period. Crude compared to a
 * Gabor bank, and sufficient: we only need to rank candidates, not to match
 * fingerprints.
 *
 * @param ridgePeriodPx Expected ridge spacing in pixels at this resolution.
 */
export function ridgeEnergy(gray: Gray, region: Rect, ridgePeriodPx: number): number {
  const inner = Math.max(1, Math.round(ridgePeriodPx / 2));
  const outer = Math.max(inner + 1, Math.round(ridgePeriodPx * 1.5));
  const table = integralPairOf(gray);

  const x0 = Math.max(0, region.x);
  const y0 = Math.max(0, region.y);
  const x1 = Math.min(gray.width, region.x + region.width);
  const y1 = Math.min(gray.height, region.y + region.height);
  if (x1 - x0 < outer * 2 || y1 - y0 < outer * 2) return 0;

  let energy = 0;
  let count = 0;
  // Sample on a lattice — every pixel would be 20x the work for the same answer.
  const step = Math.max(1, Math.floor(inner));
  for (let y = y0 + outer; y < y1 - outer; y += step) {
    for (let x = x0 + outer; x < x1 - outer; x += step) {
      const near = boxMean(table, x - inner, y - inner, x + inner + 1, y + inner + 1);
      const far = boxMean(table, x - outer, y - outer, x + outer + 1, y + outer + 1);
      energy += Math.abs(near - far);
      count += 1;
    }
  }
  return count === 0 ? 0 : energy / count;
}

/**
 * Fraction of a rectangle's PERIMETER that sits on a strong intensity edge.
 *
 * This is the sanity check that stops a "photograph" detection from being a
 * dense paragraph of text. A pasted photo is a physical object with a cut edge;
 * all four of its sides show a sharp, sustained intensity step. A block of text
 * has no such boundary — its bounding box is an abstraction, and the pixels
 * along that box are mostly blank paper.
 *
 * Returns 0..1. A genuine pasted photo scores above 0.6; a text block scores
 * below 0.2.
 */
export function edgeSupport(gradients: Gradients, rect: Rect, threshold = 60): number {
  const { magnitude } = gradients;
  const width = magnitude.width;
  const height = magnitude.height;
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(width - 1, Math.round(rect.x + rect.width));
  const y1 = Math.min(height - 1, Math.round(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return 0;

  let strong = 0;
  let total = 0;
  // Accept an edge within a couple of pixels of the nominal border — a real cut
  // edge is never exactly where a bounding box says it is.
  const tolerance = 2;
  const bestNear = (px: number, py: number, horizontal: boolean): number => {
    let best = 0;
    for (let d = -tolerance; d <= tolerance; d += 1) {
      const sx = horizontal ? px : px + d;
      const sy = horizontal ? py + d : py;
      if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
      const value = magnitude.data[sy * width + sx]!;
      if (value > best) best = value;
    }
    return best;
  };

  for (let x = x0; x <= x1; x += 1) {
    if (bestNear(x, y0, true) >= threshold) strong += 1;
    if (bestNear(x, y1, true) >= threshold) strong += 1;
    total += 2;
  }
  for (let y = y0; y <= y1; y += 1) {
    if (bestNear(x0, y, false) >= threshold) strong += 1;
    if (bestNear(x1, y, false) >= threshold) strong += 1;
    total += 2;
  }
  return total === 0 ? 0 : strong / total;
}

/**
 * Ink coverage of a rectangle, from a binarized mask. Cheap wrapper kept here
 * so detectors read as a list of feature queries rather than integral-table
 * plumbing.
 */
export function inkDensity(mask: Mask, rect: Rect): number {
  const table = integralOfMask(mask);
  const area = boxArea(table, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  return area === 0 ? 0 : boxSum(table, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height) / area;
}
