/**
 * Paper statistics — the self-normalisation source.
 *
 * Everything the region detectors measure is expressed as a multiple of these
 * numbers. There is no absolute threshold anywhere in the detection path, and
 * that is the single design decision that makes one set of constants work
 * across the range of inputs this product actually receives: a 600 dpi flatbed
 * scan, a 12 MP phone photo under fluorescent light, a photocopy of a
 * photocopy, and a WhatsApp recompression down to 1 MP.
 *
 * Consider what an absolute constant would have to survive. "An edge is a step
 * of at least 20 grey levels" is generous on a clean scan and impossible on a
 * photocopy whose entire dynamic range is 40 levels. "A region is textured if
 * its local variance exceeds 15" fires on every square millimetre of a noisy
 * phone capture and on nothing at all in a denoised one. Both thresholds are
 * really asking the same question — *is this bigger than the noise?* — and the
 * only way to answer it is to measure the noise in the scan in front of you.
 *
 * So: find the blank paper, measure how much it varies, and express everything
 * else in those units.
 *
 * THE SAMPLING PROBLEM. "Blank paper" cannot be assumed to be anywhere in
 * particular. A dense form may be 40 % ink; a photo occupies a large
 * high-variance rectangle that must not be mistaken for textured paper; rubber
 * stamps and registration stickers appear in margins. So paper is found rather
 * than assumed: tile the page, reject any tile containing ink or falling inside
 * a declared image region, and take robust statistics over what remains.
 *
 * MEDIANS THROUGHOUT. One tile containing an unmasked staple or the edge of a
 * sticker would dominate a mean. The median of per-tile deviations is stable
 * until nearly half the tiles are contaminated, and if that ever happens the
 * page is not a form.
 */

import { boxMean, boxVariance, integralOfMask, integralPairOf, boxSum, boxArea } from "../vision/integral.ts";
import type { Gray, Mask, Rect } from "../vision/types.ts";

export interface PaperStatistics {
  /** Median tone of blank paper, 0..255. */
  readonly paperLevel: number;
  /** Noise standard deviation of lightness on paper. The unit for step responses. */
  readonly sigmaLightness: number;
  /** Noise standard deviation of chroma on paper. */
  readonly sigmaChroma: number;
  /** Noise standard deviation of the high-frequency texture channel on paper. */
  readonly sigmaTexture: number;
  /**
   * 85th percentile of per-tile lightness variance on paper. A region has to
   * beat this to count as "textured" — which is what the photograph content
   * test asks, and what an emptiness assertion has to fail.
   */
  readonly varianceP85: number;
  /** Mean texture energy on paper, for the inside/outside texture ratio. */
  readonly textureLevel: number;
  /** How many tiles contributed. Below ~12 the numbers are not trustworthy. */
  readonly tilesSampled: number;
  /** Fraction of candidate tiles that turned out to be usable paper. */
  readonly paperFraction: number;
}

export interface PaperSampleOptions {
  /** Tile side in pixels. Should be ~1.5-2 mm at the working resolution. */
  readonly tileSize?: number;
  /** A tile with more ink than this is not paper. */
  readonly maxInkFraction?: number;
  /** Regions to exclude — declared photo / signature / thumb boxes. */
  readonly exclude?: readonly Rect[];
}

/**
 * Fallback used when too little blank paper exists to measure.
 *
 * The values are deliberately PESSIMISTIC — larger noise than a real scan
 * usually has. Every threshold is a multiple of these, so overestimating the
 * noise raises every bar and makes the detectors refuse more. That is the
 * correct direction to fail: rule 2 says a wrong crop is worse than no crop, so
 * when the scan cannot even be characterised, detection should get harder, not
 * easier.
 */
export const PESSIMISTIC_PAPER: PaperStatistics = Object.freeze({
  paperLevel: 220,
  sigmaLightness: 12,
  sigmaChroma: 8,
  sigmaTexture: 6,
  varianceP85: 260,
  textureLevel: 8,
  tilesSampled: 0,
  paperFraction: 0,
});

/**
 * Measures blank paper in this scan.
 *
 * @param lightness Lightness channel (L* rescaled to 0..255, or plain luma).
 * @param chroma    Chroma channel. Pass a zero image on a greyscale page.
 * @param texture   High-frequency energy channel.
 * @param ink       Ink mask — 255 where writing or print is.
 */
export function paperStatistics(
  lightness: Gray,
  chroma: Gray,
  texture: Gray,
  ink: Mask,
  options: PaperSampleOptions = {},
): PaperStatistics {
  const { tileSize = 14, maxInkFraction = 0.02, exclude = [] } = options;

  const lightnessTable = integralPairOf(lightness);
  const chromaTable = integralPairOf(chroma);
  const textureTable = integralPairOf(texture);
  const inkTable = integralOfMask(ink);

  const paperLevels: number[] = [];
  const lightnessDeviations: number[] = [];
  const chromaDeviations: number[] = [];
  const textureDeviations: number[] = [];
  const variances: number[] = [];
  const textureLevels: number[] = [];

  let candidates = 0;

  for (let y = 0; y + tileSize <= lightness.height; y += tileSize) {
    for (let x = 0; x + tileSize <= lightness.width; x += tileSize) {
      candidates += 1;

      // Declared image regions are not paper. A pasted photograph is a large
      // high-variance rectangle; letting it into the sample would inflate the
      // noise estimate to the point where the photograph no longer stands out
      // from it — the detector would measure itself into blindness.
      if (exclude.some((rect) => overlaps(rect, x, y, tileSize))) continue;

      const inkArea = boxArea(inkTable, x, y, x + tileSize, y + tileSize);
      if (inkArea === 0) continue;
      const inkFraction = boxSum(inkTable, x, y, x + tileSize, y + tileSize) / inkArea;
      if (inkFraction > maxInkFraction) continue;

      const variance = boxVariance(lightnessTable, x, y, x + tileSize, y + tileSize);
      paperLevels.push(boxMean(lightnessTable, x, y, x + tileSize, y + tileSize));
      lightnessDeviations.push(Math.sqrt(variance));
      chromaDeviations.push(Math.sqrt(boxVariance(chromaTable, x, y, x + tileSize, y + tileSize)));
      textureDeviations.push(Math.sqrt(boxVariance(textureTable, x, y, x + tileSize, y + tileSize)));
      textureLevels.push(boxMean(textureTable, x, y, x + tileSize, y + tileSize));
      variances.push(variance);
    }
  }

  if (paperLevels.length < 12) return PESSIMISTIC_PAPER;

  return {
    paperLevel: median(paperLevels),
    // A floor of 0.5 on every sigma. A synthetic or heavily-denoised image can
    // have literally zero variance on paper, and these are all divisors —
    // without the floor a perfectly clean scan produces infinite step responses
    // and every candidate passes every test.
    sigmaLightness: Math.max(0.5, median(lightnessDeviations)),
    sigmaChroma: Math.max(0.5, median(chromaDeviations)),
    sigmaTexture: Math.max(0.5, median(textureDeviations)),
    varianceP85: Math.max(1, percentileOf(variances, 0.85)),
    textureLevel: Math.max(0.25, median(textureLevels)),
    tilesSampled: paperLevels.length,
    paperFraction: candidates === 0 ? 0 : paperLevels.length / candidates,
  };
}

/**
 * Local-variance coverage: the fraction of windows inside a region whose
 * variance exceeds the paper's own 85th percentile.
 *
 * This is the photograph's strongest content signal and the emptiness test's
 * strongest counter-signal, and it is the same measurement read in two
 * directions. A photograph is textured essentially everywhere — even its plain
 * studio backdrop carries grain that paper does not. Blank paper is, by
 * construction, below its own 85th percentile 85 % of the time.
 *
 * Comparing against a statistic from THIS scan is what makes the emptiness
 * assertion able to fire at all. Comparing a phone JPEG against a clean
 * template's noise floor is a test that essentially never passes, which
 * silently turns "Not Detected, asserted" back into "Not Detected, gave up".
 */
export function localVarianceCoverage(
  lightness: Gray,
  region: Rect,
  paper: PaperStatistics,
  windowSize = 9,
): number {
  const table = integralPairOf(lightness);
  const half = Math.max(1, Math.floor(windowSize / 2));
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(lightness.width, Math.ceil(region.x + region.width));
  const y1 = Math.min(lightness.height, Math.ceil(region.y + region.height));
  if (x1 - x0 < windowSize || y1 - y0 < windowSize) return 0;

  let above = 0;
  let total = 0;
  // Step by half a window: adjacent windows overlap heavily and sampling every
  // pixel measures the same thing many times over.
  const step = Math.max(1, half);
  for (let y = y0 + half; y < y1 - half; y += step) {
    for (let x = x0 + half; x < x1 - half; x += step) {
      const variance = boxVariance(table, x - half, y - half, x + half + 1, y + half + 1);
      if (variance > paper.varianceP85) above += 1;
      total += 1;
    }
  }
  return total === 0 ? 0 : above / total;
}

/**
 * Ratio of mean texture energy inside a region to the paper around it.
 *
 * The channel that sees a white photograph on white paper. Photographic
 * emulsion and paper fibre do not share a grain, so this rises above 1 even
 * when lightness and chroma are identical on both sides of the boundary.
 */
export function textureContrastRatio(texture: Gray, region: Rect, paper: PaperStatistics): number {
  const table = integralPairOf(texture);
  const inside = boxMean(table, region.x, region.y, region.x + region.width, region.y + region.height);
  return inside / Math.max(0.25, paper.textureLevel);
}

/**
 * Spread of the tone histogram: the fraction of bins between the 2nd and 98th
 * percentiles that carry meaningful mass.
 *
 * A photograph is a continuous-tone image and fills its range. Handwriting on
 * paper is two-valued — ink and paper — with almost nothing between, so it
 * occupies few bins however dark the ink is. Trimming to p2..p98 first stops a
 * single dust speck or specular pixel from stretching the range.
 */
export function toneSpread(lightness: Gray, region: Rect): number {
  const bins = new Uint32Array(256);
  let count = 0;
  const x1 = Math.min(lightness.width, Math.ceil(region.x + region.width));
  const y1 = Math.min(lightness.height, Math.ceil(region.y + region.height));
  for (let y = Math.max(0, Math.floor(region.y)); y < y1; y += 1) {
    const row = y * lightness.width;
    for (let x = Math.max(0, Math.floor(region.x)); x < x1; x += 1) {
      bins[lightness.data[row + x]!] += 1;
      count += 1;
    }
  }
  if (count === 0) return 0;

  const low = percentileFromHistogram(bins, count, 0.02);
  const high = percentileFromHistogram(bins, count, 0.98);
  if (high <= low) return 0;

  const floor = count * 0.002;
  let occupied = 0;
  for (let i = low; i <= high; i += 1) if (bins[i]! > floor) occupied += 1;
  const density = occupied / (high - low + 1);

  // Scale by how wide the range actually is.
  //
  // Density alone is degenerate on flat regions and reports the OPPOSITE of the
  // truth there. Blank paper spans perhaps six grey levels, and all six are
  // occupied, so density is 1.0 — the maximum, from a region with no tonal
  // content whatsoever. Measured on the reference fixture, genuinely blank
  // paper scored a perfect 1.000, which would classify it as more
  // photograph-like than an actual photograph.
  //
  // Continuous tone requires both conditions: a wide range, AND that range
  // being filled. `fullRange` is set at a quarter of the 8-bit scale, which any
  // real photograph clears comfortably and no expanse of paper ever does.
  const fullRange = 64;
  return density * Math.min(1, (high - low) / fullRange);
}

// ---------------------------------------------------------------------------

function overlaps(rect: Rect, x: number, y: number, size: number): boolean {
  return !(rect.x >= x + size || rect.x + rect.width <= x || rect.y >= y + size || rect.y + rect.height <= y);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentileOf(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

function percentileFromHistogram(bins: Uint32Array, count: number, fraction: number): number {
  const target = count * fraction;
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += bins[i]!;
    if (seen >= target) return i;
  }
  return 255;
}
