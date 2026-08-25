/**
 * Colour channels and the paper-texture channel.
 *
 * The photograph detector needs three INDEPENDENT ways to see the edge of a
 * pasted photo, because any one of them can vanish on a real form:
 *
 *   L*   Lightness. Fails when a white-backdrop photo is pasted on white paper —
 *        the modal Indian passport photo on the modal Indian form.
 *   C*   Chroma. Fails on photocopies and on greyscale photos, where there is
 *        no colour anywhere on the page.
 *   HF   High-frequency texture energy. Photo emulsion and paper fibre never
 *        have the same grain, so this fires precisely where the other two are
 *        blind. It is the channel that makes white-on-white recoverable.
 *
 * Lab rather than HSV for the first two. HSV's "saturation" is a cheap ratio
 * that swings wildly at low lightness — a dark grey shadow and a dark blue ink
 * stroke can report similar saturation — and its hue is undefined on neutrals.
 * Lab is perceptually uniform enough that a fixed chroma threshold means
 * roughly the same thing in a bright region and a shadowed one, which is what
 * lets the detector use one constant across a page with a hand shadow on it.
 */

import { createF32, createGray, type F32, type Gray, type Mask, type Rgb } from "./types.ts";
import { boxMean, integralOf } from "./integral.ts";

export interface LabImages {
  /** Lightness, 0..100 rescaled to 0..255 for cheap integral-image reuse. */
  readonly L: Gray;
  /** a* and b*, stored with a +128 offset so they fit an unsigned byte. */
  readonly a: Gray;
  readonly b: Gray;
  /** Chroma = hypot(a*, b*), 0..~180 clamped to 255. */
  readonly chroma: Gray;
}

// sRGB D65 -> XYZ, then XYZ -> Lab. Precomputed reference white.
const XN = 0.95047;
const YN = 1.0;
const ZN = 1.08883;

/** sRGB gamma expansion. The 0.04045 / 12.92 knee is the actual sRGB curve, not a 2.2 power. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  // 6/29 cubed, and the linear segment below it — using the cube root alone
  // makes the transform non-invertible near black and amplifies sensor noise.
  return t > 0.008856451679 ? Math.cbrt(t) : t * 7.787037037 + 0.13793103448;
}

/**
 * Converts to CIE Lab.
 *
 * A 256-entry lookup table for the gamma expansion turns three `Math.pow` calls
 * per pixel into three array reads. At 2400x1700 that is 12 million pow calls
 * saved, which is the difference between this stage costing 90 ms and costing
 * 900 ms.
 */
export function labToImages(image: Rgb): LabImages {
  const { data, width, height, channels } = image;
  const size = width * height;

  const gamma = new Float64Array(256);
  for (let i = 0; i < 256; i += 1) gamma[i] = linearise(i);

  const L = createGray(width, height);
  const a = createGray(width, height);
  const b = createGray(width, height);
  const chroma = createGray(width, height);

  for (let i = 0, p = 0; i < size; i += 1, p += channels) {
    const r = gamma[data[p]!]!;
    const g = gamma[data[p + 1]!]!;
    const bl = gamma[data[p + 2]!]!;

    const x = labF((r * 0.4124564 + g * 0.3575761 + bl * 0.1804375) / XN);
    const y = labF((r * 0.2126729 + g * 0.7151522 + bl * 0.072175) / YN);
    const z = labF((r * 0.0193339 + g * 0.119192 + bl * 0.9503041) / ZN);

    const lightness = 116 * y - 16;
    const aStar = 500 * (x - y);
    const bStar = 200 * (y - z);

    // L* is 0..100; scale to 0..255 so the integral-image helpers apply unchanged.
    L.data[i] = (lightness * 255) / 100;
    a.data[i] = aStar + 128;
    b.data[i] = bStar + 128;
    chroma.data[i] = Math.hypot(aStar, bStar);
  }

  return { L, a, b, chroma };
}

/**
 * High-frequency texture energy: |I - boxBlur3(I)| smoothed over a 9x9 window.
 *
 * The inner difference isolates detail finer than 3 px — grain, fibre, emulsion
 * texture, the fuzz of a halftone. The outer 9x9 mean turns that into a stable
 * local *energy* rather than a noisy per-pixel value, so a single hot pixel
 * cannot create an edge.
 *
 * Both passes run on integral images, so the cost does not depend on the window
 * sizes and the whole channel is one linear sweep.
 */
export function highFrequencyEnergy(image: Gray, innerRadius = 1, outerRadius = 4): Gray {
  const table = integralOf(image);
  const detail = createGray(image.width, image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const local = boxMean(table, x - innerRadius, y - innerRadius, x + innerRadius + 1, y + innerRadius + 1);
      detail.data[y * image.width + x] = Math.abs(image.data[y * image.width + x]! - local);
    }
  }

  const detailTable = integralOf(detail);
  const energy = createGray(image.width, image.height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      energy.data[y * image.width + x] = boxMean(
        detailTable,
        x - outerRadius,
        y - outerRadius,
        x + outerRadius + 1,
        y + outerRadius + 1,
      );
    }
  }
  return energy;
}

/**
 * Per-channel white balance from the paper itself.
 *
 * Takes the 95th percentile of each channel over NON-ink pixels as the local
 * definition of white, and scales so those land at 245 — not 255, so a genuinely
 * bright specular pixel still has somewhere to go rather than clipping.
 *
 * Gains are clamped to [0.8, 1.25]. Beyond that the "correction" is no longer
 * correcting an illuminant; it is inventing colour from a page that is
 * genuinely tinted — cream paper, a pink carbon copy, a yellowed archive form —
 * and neutralising those is a loss of real information.
 */
export function whiteBalanceByPaper(image: Rgb, inkMask: Mask): Rgb {
  const { data, width, height, channels } = image;
  const size = width * height;
  const histograms = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let counted = 0;

  for (let i = 0, p = 0; i < size; i += 1, p += channels) {
    if (inkMask.data[i]! !== 0) continue;
    histograms[0]![data[p]!] += 1;
    histograms[1]![data[p + 1]!] += 1;
    histograms[2]![data[p + 2]!] += 1;
    counted += 1;
  }

  // Almost the whole frame is ink — a dense form, or a failed mask. Leave it alone.
  if (counted < size * 0.05) return image;

  const gains = histograms.map((histogram) => {
    const target = counted * 0.95;
    let seen = 0;
    let level = 255;
    for (let i = 0; i < 256; i += 1) {
      seen += histogram[i]!;
      if (seen >= target) {
        level = i;
        break;
      }
    }
    if (level < 20) return 1;
    return Math.max(0.8, Math.min(1.25, 245 / level));
  });

  const out = new Uint8ClampedArray(data.length);
  for (let i = 0, p = 0; i < size; i += 1, p += channels) {
    out[p] = data[p]! * gains[0]!;
    out[p + 1] = data[p + 1]! * gains[1]!;
    out[p + 2] = data[p + 2]! * gains[2]!;
    if (channels === 4) out[p + 3] = data[p + 3]!;
  }
  return { data: out, width, height, channels };
}

/**
 * Fraction of the image carrying meaningful colour.
 *
 * Drives the greyscale/photocopy branch of the photo detector: below about 2 %,
 * chroma features are measuring nothing and must be dropped from the score
 * rather than contributing a confident zero to every candidate equally.
 */
export function saturatedFraction(chroma: Gray, threshold = 12): number {
  let count = 0;
  for (let i = 0; i < chroma.data.length; i += 1) if (chroma.data[i]! > threshold) count += 1;
  return count / chroma.data.length;
}

/**
 * Counts distinct chroma-weighted hue modes.
 *
 * A photograph of a person contains at least two: skin and backdrop, usually
 * also hair and clothing. A stamp-pad thumb impression contains exactly one —
 * stamp pads are a single ink. Blank paper contains none. This separates a
 * photo from a large ink mark without ever looking at shape.
 *
 * Only pixels above the chroma threshold vote, so the vast neutral majority of
 * a form cannot manufacture a mode.
 */
export function chromaClusterCount(lab: LabImages, region: { x: number; y: number; width: number; height: number }, chromaThreshold = 12): number {
  const bins = new Float64Array(36);
  let total = 0;

  const x1 = Math.min(lab.L.width, region.x + region.width);
  const y1 = Math.min(lab.L.height, region.y + region.height);
  for (let y = Math.max(0, region.y); y < y1; y += 1) {
    const row = y * lab.L.width;
    for (let x = Math.max(0, region.x); x < x1; x += 1) {
      const c = lab.chroma.data[row + x]!;
      if (c <= chromaThreshold) continue;
      const aStar = lab.a.data[row + x]! - 128;
      const bStar = lab.b.data[row + x]! - 128;
      let hue = (Math.atan2(bStar, aStar) * 180) / Math.PI;
      if (hue < 0) hue += 360;
      // Weight by chroma: a strongly-coloured pixel is better evidence of a
      // real hue than a barely-coloured one sitting just over the threshold.
      bins[Math.min(35, Math.floor(hue / 10))] += c;
      total += c;
    }
  }

  if (total <= 0) return 0;

  // A mode is a local maximum on the circular histogram carrying at least 8% of
  // the weight. Requiring a local max stops one broad colour being counted as
  // three adjacent bins.
  let modes = 0;
  for (let i = 0; i < 36; i += 1) {
    const value = bins[i]!;
    if (value / total < 0.08) continue;
    const previous = bins[(i + 35) % 36]!;
    const next = bins[(i + 1) % 36]!;
    if (value >= previous && value >= next) modes += 1;
  }
  return modes;
}

/** Extracts one channel of an interleaved image as a Gray. */
export function channelOf(image: Rgb, index: 0 | 1 | 2): Gray {
  const out = createGray(image.width, image.height);
  for (let i = 0, p = index; i < out.data.length; i += 1, p += image.channels) {
    out.data[i] = image.data[p]!;
  }
  return out;
}

/** Float view of a Gray, for callers that need sub-integer precision downstream. */
export function grayToF32(image: Gray): F32 {
  const out = createF32(image.width, image.height);
  out.data.set(image.data);
  return out;
}
