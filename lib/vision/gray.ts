/**
 * Grayscale conversion, resampling and cropping.
 *
 * Two choices here are deliberate and worth defending, because both look like
 * details and both change detection results:
 *
 *  1. **Luma weights, not a channel average.** A blue ballpoint signature and a
 *     black one must both survive as "dark". Rec.601 luma (0.299R + 0.587G +
 *     0.114B) weights blue at 11%, which makes blue ink read *darker* than a
 *     flat average would — exactly what we want for an ink mask on Indian forms,
 *     where blue pen is the norm. A plain (R+G+B)/3 lifts blue ink toward the
 *     paper and thins the resulting strokes.
 *  2. **Area-average when shrinking, bilinear when growing.** Downscaling a
 *     12 MP phone photo with bilinear point-sampling aliases handwriting into
 *     broken dashes, which destroys connected-component analysis — one stroke
 *     becomes nine fragments and every shape statistic computed from it is
 *     wrong. Area averaging is the correct antialiasing filter for integer-ish
 *     shrink factors and costs nothing we care about.
 */

import {
  createGray,
  createF32,
  type F32,
  type Gray,
  type Rect,
  type Rgb,
  clipRect,
} from "./types.ts";

/** Rec.601 luma. See the module note on why this is not a channel average. */
export function toGray(image: Rgb): Gray {
  const { data, width, height, channels } = image;
  const out = createGray(width, height);
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i += 1, p += channels) {
    dst[i] = (data[p]! * 299 + data[p + 1]! * 587 + data[p + 2]! * 114) / 1000;
  }
  return out;
}

/**
 * Per-pixel saturation in [0,255], from the HSV definition (max - min) scaled
 * by max. A pasted colour photograph carries saturation almost everywhere; a
 * printed form is near-zero except at its logo. This is the single strongest
 * cue for locating a colour photo, so it gets its own function rather than
 * being buried in the detector.
 *
 * Achromatic pixels (max == 0, i.e. pure black) return 0 rather than NaN.
 */
export function saturation(image: Rgb): Gray {
  const { data, width, height, channels } = image;
  const out = createGray(width, height);
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i += 1, p += channels) {
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    const max = r > g ? (r > b ? r : b) : g > b ? g : b;
    const min = r < g ? (r < b ? r : b) : g < b ? g : b;
    dst[i] = max === 0 ? 0 : ((max - min) * 255) / max;
  }
  return out;
}

/**
 * Value channel (HSV max). Used alongside saturation so a detector can ask
 * "coloured AND not near-white" in one pass over two cheap maps.
 */
export function valueChannel(image: Rgb): Gray {
  const { data, width, height, channels } = image;
  const out = createGray(width, height);
  const dst = out.data;
  for (let i = 0, p = 0; i < dst.length; i += 1, p += channels) {
    const r = data[p]!;
    const g = data[p + 1]!;
    const b = data[p + 2]!;
    dst[i] = r > g ? (r > b ? r : b) : g > b ? g : b;
  }
  return out;
}

export function cloneGray(image: Gray): Gray {
  return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
}

/** Copies a sub-rectangle. The rect is clipped to the image first, so callers may pass a padded box. */
export function cropGray(image: Gray, rect: Rect): Gray {
  const box = clipRect(rect, image.width, image.height);
  if (box.width === 0 || box.height === 0) {
    throw new Error(`cropGray: empty crop ${JSON.stringify(rect)} against ${image.width}x${image.height}`);
  }
  const out = createGray(box.width, box.height);
  for (let y = 0; y < box.height; y += 1) {
    const src = (box.y + y) * image.width + box.x;
    out.data.set(image.data.subarray(src, src + box.width), y * box.width);
  }
  return out;
}

/** Copies a sub-rectangle of an interleaved colour image, preserving channel count. */
export function cropRgb(image: Rgb, rect: Rect): Rgb {
  const box = clipRect(rect, image.width, image.height);
  if (box.width === 0 || box.height === 0) {
    throw new Error(`cropRgb: empty crop ${JSON.stringify(rect)} against ${image.width}x${image.height}`);
  }
  const c = image.channels;
  const data = new Uint8ClampedArray(box.width * box.height * c);
  const rowBytes = box.width * c;
  for (let y = 0; y < box.height; y += 1) {
    const src = ((box.y + y) * image.width + box.x) * c;
    data.set(image.data.subarray(src, src + rowBytes), y * rowBytes);
  }
  return { data, width: box.width, height: box.height, channels: c };
}

/**
 * Resamples to an exact size. Area-average when shrinking on an axis, bilinear
 * when growing — decided per axis, so a 3000x400 → 300x800 resize antialiases
 * horizontally and interpolates vertically, which is the correct thing and what
 * a single-strategy resizer gets wrong.
 */
export function resizeGray(image: Gray, width: number, height: number): Gray {
  if (width === image.width && height === image.height) return cloneGray(image);
  const shrinkX = width < image.width;
  const shrinkY = height < image.height;
  // Mixed directions are rare enough that doing two passes is simpler and still
  // correct: shrink first (cheaper on the second pass), then grow.
  if (shrinkX !== shrinkY) {
    const midWidth = shrinkX ? width : image.width;
    const midHeight = shrinkY ? height : image.height;
    const mid = areaResize(image, midWidth, midHeight);
    return bilinearResize(mid, width, height);
  }
  return shrinkX ? areaResize(image, width, height) : bilinearResize(image, width, height);
}

/**
 * Scales so the longest edge is at most `maxEdge`. Never upscales — enlarging a
 * blurry capture invents detail the detectors would then measure as real.
 */
export function fitWithin(image: Gray, maxEdge: number): Gray {
  const longest = Math.max(image.width, image.height);
  if (longest <= maxEdge) return cloneGray(image);
  const scale = maxEdge / longest;
  return resizeGray(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
}

function areaResize(image: Gray, width: number, height: number): Gray {
  const out = createGray(width, height);
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = y * scaleY;
    const y1 = (y + 1) * scaleY;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(image.height, Math.ceil(y1));
    for (let x = 0; x < width; x += 1) {
      const x0 = x * scaleX;
      const x1 = (x + 1) * scaleX;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(image.width, Math.ceil(x1));
      let sum = 0;
      let weight = 0;
      for (let sy = iy0; sy < iy1; sy += 1) {
        // Partial coverage at the first and last row/column, so a non-integer
        // scale factor does not bias the result toward the top-left.
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        const row = sy * image.width;
        for (let sx = ix0; sx < ix1; sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          sum += image.data[row + sx]! * w;
          weight += w;
        }
      }
      out.data[y * width + x] = weight > 0 ? sum / weight : 0;
    }
  }
  return out;
}

function bilinearResize(image: Gray, width: number, height: number): Gray {
  const out = createGray(width, height);
  // Map destination centres to source centres, so the result is not shifted by
  // half a pixel — a shift that quietly biases every coordinate we later report.
  const scaleX = image.width / width;
  const scaleY = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const fx = sx - x0;
      const a = image.data[y0 * image.width + x0]!;
      const b = image.data[y0 * image.width + x1]!;
      const c = image.data[y1 * image.width + x0]!;
      const d = image.data[y1 * image.width + x1]!;
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      out.data[y * width + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

/** Samples with bilinear interpolation at fractional coordinates, clamping at the border. */
export function sampleBilinear(image: Gray, x: number, y: number): number {
  const cx = Math.min(image.width - 1, Math.max(0, x));
  const cy = Math.min(image.height - 1, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = image.data[y0 * image.width + x0]!;
  const b = image.data[y0 * image.width + x1]!;
  const c = image.data[y1 * image.width + x0]!;
  const d = image.data[y1 * image.width + x1]!;
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/** Converts to float without rescaling, for the gradient and energy stages. */
export function toF32(image: Gray): F32 {
  const out = createF32(image.width, image.height);
  out.data.set(image.data);
  return out;
}

/** Rescales a float map to 0..255 using its own min and max. Flat maps become all-zero, not NaN. */
export function normalizeF32(map: F32): Gray {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < map.data.length; i += 1) {
    const v = map.data[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = createGray(map.width, map.height);
  const range = max - min;
  if (range <= 0) return out;
  for (let i = 0; i < map.data.length; i += 1) {
    out.data[i] = ((map.data[i]! - min) * 255) / range;
  }
  return out;
}

/** 256-bin intensity histogram. */
export function histogram(image: Gray): Uint32Array {
  const bins = new Uint32Array(256);
  for (let i = 0; i < image.data.length; i += 1) bins[image.data[i]!] += 1;
  return bins;
}

/**
 * Intensity at a given cumulative fraction of pixels, e.g. `percentile(g, 0.95)`
 * for "how bright is the paper". Robust background estimation uses this instead
 * of the max, which is one specular highlight away from being useless.
 */
export function percentile(image: Gray, fraction: number): number {
  const bins = histogram(image);
  const target = Math.max(0, Math.min(1, fraction)) * image.data.length;
  let seen = 0;
  for (let i = 0; i < 256; i += 1) {
    seen += bins[i]!;
    if (seen >= target) return i;
  }
  return 255;
}

export function meanOf(image: Gray): number {
  let sum = 0;
  for (let i = 0; i < image.data.length; i += 1) sum += image.data[i]!;
  return sum / image.data.length;
}
