/**
 * Turns a detection into a deliverable image.
 *
 * Two outputs, and the second is the one that makes the product feel finished.
 *
 * PHOTOGRAPH — the detected quadrilateral warped upright in a single resample,
 * inset to shed the cut edge and drop shadow, and delivered at exactly the
 * declared physical size. A crooked paste comes out straight.
 *
 * SIGNATURE — ink on a TRANSPARENT background, not a rectangle of paper. This
 * matters more than it sounds. A signature crop as a JPEG carries the paper
 * texture and a slice of the printed rule through the middle of it, and it
 * cannot be placed on a discharge summary or a letterhead without a white box
 * around it. Ink on transparency composites onto anything. It is only possible
 * because the printed rule was subtracted before detection, so what remains
 * genuinely is the person's ink and nothing else.
 */

import { estimateHomography, minAreaRect, multiply3 } from "../vision/geometry.ts";
import { insetQuad, warpPerspectiveRgb, warpQuadRgb } from "../vision/warp-rgb.ts";
import {
  boundsOf,
  quadPoints,
  type Mask,
  type Matrix3,
  type Point,
  type Quad,
  type Rect,
  type Rgb,
} from "../vision/types.ts";
import { REGION_PARAMS } from "./params.ts";

/**
 * A higher-resolution source to sample the photograph from.
 *
 * The detection ran on the rectified page, which is 200 DPI of paper by
 * construction. The uploaded capture is usually finer than that — and the
 * passport photograph is the one output where the difference is visible on a
 * printed ID card. So the quad is measured in the rectified page and then
 * SAMPLED from the original, in the same single resample that does the
 * perspective correction and the scaling. Warping the rectified page and
 * upscaling the result would be two interpolations, the second one undoing what
 * the first preserved.
 */
export interface PhotoSource {
  /** Pixels to sample. */
  readonly image: Rgb;
  /** Maps a point in rectified-page pixels to a point in `image`. */
  readonly transform: Matrix3;
  /** Resolution of `image` at the crop's location, in pixels per millimetre of paper. */
  readonly pxPerMM: number;
}

export interface PhotoCropResult {
  readonly image: Rgb;
  /** Output size in pixels. */
  readonly width: number;
  readonly height: number;
  /**
   * True when reaching the target resolution would have needed more upscaling
   * than is honest. The image is delivered at native scale instead and the
   * field's confidence is capped.
   */
  readonly lowResolution: boolean;
  /** Effective resolution actually achieved, in dots per inch of paper. */
  readonly effectiveDpi: number;
}

/**
 * Renders the delivered photograph.
 *
 * @param source    Full-resolution image the quad is expressed in.
 * @param quad      Detected boundary, in `source` pixel coordinates.
 * @param sizeMM    Declared physical size, e.g. 35x45.
 * @param sourcePxPerMM Resolution of `source`, used to decide whether the
 *   target is reachable without inventing detail.
 * @param finer Optional higher-resolution pixels to sample instead. `quad` is
 *   still measured in `source`; only the sampling moves. Omit and the crop is
 *   taken from `source` exactly as before.
 */
export function renderPhotoCrop(
  source: Rgb,
  quad: Quad,
  sizeMM: { readonly widthMM: number; readonly heightMM: number },
  sourcePxPerMM: number,
  targetDpi = 300,
  finer?: PhotoSource,
): PhotoCropResult {
  const inset = insetQuad(quad, REGION_PARAMS.photo.insetFraction);

  const targetPxPerMM = targetDpi / 25.4;
  let width = Math.max(1, Math.round(sizeMM.widthMM * targetPxPerMM));
  let height = Math.max(1, Math.round(sizeMM.heightMM * targetPxPerMM));

  // How big is the photo in the source? Use the fitted rectangle rather than the
  // axis-aligned bounds, which overstate a rotated quad by up to 40 %.
  const measured = minAreaRect(quadPoints(inset));
  // Measured in `source`, so when sampling from finer pixels it has to be
  // restated in those. Skipping this conversion would leave the honest-upscale
  // gate judging the ORIGINAL's resolution by the rectified page's pixel count,
  // and it would cap a crop that needed no upscaling at all.
  const resolutionGain = finer ? finer.pxPerMM / sourcePxPerMM : 1;
  const sourceShort = Math.min(measured.width, measured.height) * resolutionGain;
  const targetShort = Math.min(width, height);
  const upscale = targetShort / Math.max(1, sourceShort);

  let lowResolution = false;
  if (upscale > REGION_PARAMS.photo.maxHonestUpscale) {
    // NO INVENTED RESOLUTION. Delivering a 413x531 image built from 180x230
    // real pixels claims a fidelity that is not there, and a hospital printing
    // it on an ID card gets a soft, blocky portrait with no warning. Emit at
    // the honest native size and let the confidence cap say why.
    lowResolution = true;
    const scale = REGION_PARAMS.photo.maxHonestUpscale / upscale;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const image = finer
    ? warpQuadFrom(finer.image, inset, finer.transform, width, height)
    : warpQuadRgb(source, inset, width, height);
  const effectiveDpi = (Math.min(width, height) / Math.min(sizeMM.widthMM, sizeMM.heightMM)) * 25.4;

  return { image, width, height, lowResolution, effectiveDpi: Math.round(effectiveDpi) };
}

/**
 * Warps `quad` — expressed in the rectified page — into an upright rectangle,
 * sampling from a different image entirely.
 *
 * The two homographies compose into one, which is the whole point: output pixel
 * to rectified page (`toQuad`), rectified page to the original capture
 * (`transform`). Applying them separately would mean rendering an intermediate
 * raster and resampling it, and the second resample is exactly the softness this
 * path exists to avoid.
 */
function warpQuadFrom(image: Rgb, quad: Quad, transform: Matrix3, width: number, height: number): Rgb {
  const destination: Point[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const toQuad = estimateHomography(destination, [quad.tl, quad.tr, quad.br, quad.bl]);
  return warpPerspectiveRgb(image, multiply3(transform, toQuad), width, height);
}

export interface SignatureCropResult {
  /** RGBA, ink opaque and paper fully transparent. */
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Median ink colour, so a blue pen stays blue. */
  readonly inkColour: readonly [number, number, number];
  /** The region of `source` this was taken from, after padding. */
  readonly region: Rect;
}

/**
 * Renders the signature as ink on transparency.
 *
 * Alpha comes from the ink mask, dilated slightly and feathered, so the strokes
 * keep soft edges instead of the hard aliased boundary a raw binary mask would
 * give. Colour is the MEDIAN of the actual ink pixels rather than a fixed black:
 * most Indian forms are signed in blue ballpoint, and rendering that as black is
 * a visible falsification of the document.
 */
export function renderSignatureCrop(
  source: Rgb,
  inkMask: Mask,
  bounds: Rect,
  pxPerMM: number,
): SignatureCropResult {
  const pad = Math.round(REGION_PARAMS.signature.outputPadMM * pxPerMM);
  const x0 = Math.max(0, Math.floor(bounds.x) - pad);
  const y0 = Math.max(0, Math.floor(bounds.y) - pad);
  const x1 = Math.min(source.width, Math.ceil(bounds.x + bounds.width) + pad);
  const y1 = Math.min(source.height, Math.ceil(bounds.y + bounds.height) + pad);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  // `inkMask` is origin-aligned with `bounds`, NOT with `source`. The padded
  // output region extends beyond `bounds`, so every lookup converts from the
  // padded frame to the mask's frame and range-checks against the mask's own
  // size. Indexing it with source coordinates reads outside the buffer, returns
  // zero everywhere, and produces a completely blank signature with no error.
  const maskAt = (paddedX: number, paddedY: number): boolean => {
    const mx = x0 + paddedX - Math.floor(bounds.x);
    const my = y0 + paddedY - Math.floor(bounds.y);
    if (mx < 0 || my < 0 || mx >= inkMask.width || my >= inkMask.height) return false;
    return inkMask.data[my * inkMask.width + mx] !== 0;
  };

  // Alpha: dilate the mask a little so the stroke keeps its full weight, then
  // blur so the edge is not a staircase.
  const dilateRadius = REGION_PARAMS.signature.alphaDilatePx;
  const alpha = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!maskAt(x, y)) continue;
      for (let dy = -dilateRadius; dy <= dilateRadius; dy += 1) {
        for (let dx = -dilateRadius; dx <= dilateRadius; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          alpha[ny * width + nx] = 1;
        }
      }
    }
  }
  const feathered = boxBlur(alpha, width, height, REGION_PARAMS.signature.alphaFeatherPx);

  // Median ink colour over the masked pixels only.
  const reds: number[] = [];
  const greens: number[] = [];
  const blues: number[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!maskAt(x, y)) continue;
      const sx = x0 + x;
      const sy = y0 + y;
      if (sx >= source.width || sy >= source.height) continue;
      const p = (sy * source.width + sx) * source.channels;
      reds.push(source.data[p]!);
      greens.push(source.data[p + 1]!);
      blues.push(source.data[p + 2]!);
    }
  }
  const inkColour: [number, number, number] = reds.length
    ? [median(reds), median(greens), median(blues)]
    : [30, 30, 60];

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const a = feathered[i]!;
    if (a <= 0.004) continue;
    rgba[i * 4] = inkColour[0];
    rgba[i * 4 + 1] = inkColour[1];
    rgba[i * 4 + 2] = inkColour[2];
    rgba[i * 4 + 3] = a * 255;
  }

  return { rgba, width, height, inkColour, region: { x: x0, y: y0, width, height } };
}

/**
 * Flattens an ink-on-transparency signature onto white.
 *
 * Emitted alongside the transparent version for anything that cannot composite
 * — a printed receipt, an older PDF pipeline, an email client.
 */
export function flattenOntoWhite(rgba: Uint8ClampedArray, width: number, height: number): Rgb {
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    const a = rgba[i * 4 + 3]! / 255;
    data[i * 3] = rgba[i * 4]! * a + 255 * (1 - a);
    data[i * 3 + 1] = rgba[i * 4 + 1]! * a + 255 * (1 - a);
    data[i * 3 + 2] = rgba[i * 4 + 2]! * a + 255 * (1 - a);
  }
  return { data, width, height, channels: 3 };
}

/** Axis-aligned bounds of a detected quad, for UI overlays. */
export function quadBounds(quad: Quad): Rect {
  return boundsOf(quadPoints(quad));
}

// ---------------------------------------------------------------------------

function boxBlur(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius <= 0) return values;
  const horizontal = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        sum += values[y * width + nx]!;
        count += 1;
      }
      horizontal[y * width + x] = sum / count;
    }
  }
  const out = new Float32Array(values.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        sum += horizontal[ny * width + x]!;
        count += 1;
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1]!;
}
