/**
 * Turns a photograph detection into a deliverable image: the detected
 * quadrilateral warped upright in a single resample, inset to shed the cut
 * edge and drop shadow, and delivered at the print's physical size. A crooked
 * paste comes out straight.
 */

import { estimateHomography, minAreaRect, multiply3 } from "../vision/geometry.ts";
import { insetQuad, warpPerspectiveRgb, warpQuadRgb } from "../vision/warp-rgb.ts";
import { boundsOf, quadPoints, type Matrix3, type Point, type Quad, type Rect, type Rgb } from "../vision/types.ts";
import { REGION_PARAMS } from "./params.ts";

/**
 * A higher-resolution source to sample the photograph from.
 *
 * The detection ran on the rectified page, which is 200 DPI of paper by
 * construction. The uploaded capture is usually finer than that — and the
 * photograph is the one output where the difference is visible on a printed
 * ID card. So the quad is measured in the rectified page and then SAMPLED
 * from the original, in the same single resample that does the perspective
 * correction and the scaling. Warping the rectified page and upscaling the
 * result would be two interpolations, the second undoing what the first
 * preserved.
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
 * @param sizeMM    Physical size to deliver at, e.g. 35x45.
 * @param sourcePxPerMM Resolution of `source`, used to decide whether the
 *   target is reachable without inventing detail.
 * @param finer Optional higher-resolution pixels to sample instead. `quad` is
 *   still measured in `source`; only the sampling moves.
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
  // restated in those, or the honest-upscale gate judges the original's
  // resolution by the rectified page's pixel count.
  const resolutionGain = finer ? finer.pxPerMM / sourcePxPerMM : 1;
  const sourceShort = Math.min(measured.width, measured.height) * resolutionGain;
  const targetShort = Math.min(width, height);
  const upscale = targetShort / Math.max(1, sourceShort);

  let lowResolution = false;
  if (upscale > REGION_PARAMS.photo.maxHonestUpscale) {
    // NO INVENTED RESOLUTION. Delivering a 413x531 image built from 180x230
    // real pixels claims a fidelity that is not there. Emit at the honest
    // native size and let the confidence cap say why.
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
 * sampling from a different image entirely. The two homographies compose into
 * one: output pixel to rectified page, rectified page to the original capture.
 * Applying them separately would render an intermediate raster and resample
 * it, and the second resample is exactly the softness this path avoids.
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

/** Axis-aligned bounds of a detected quad, for UI overlays. */
export function quadBounds(quad: Quad): Rect {
  return boundsOf(quadPoints(quad));
}
