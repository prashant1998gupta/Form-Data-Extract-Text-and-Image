/**
 * The person's photograph, cut from a photograph of the form.
 *
 * The one thing the vision model cannot do is hand back an image, so this is
 * the deterministic half of a scan: decode the capture, find and straighten
 * the page, then measure the pasted print's four edges where the form says it
 * is and deliver it upright at print resolution. No model is called here.
 *
 * Two steps, split so the reader can start on the straightened page while the
 * photograph is still being measured:
 *
 *   1. `rectifyCapture` — decode once (EXIF applied), locate the page and warp
 *      it onto the Canonical Template Space raster, so a millimetre is the
 *      same number of pixels whatever phone took the picture.
 *   2. `cropPhoto` — normalise, confirm the page carries printed structure at
 *      all, then detect and render the photograph.
 *
 * A refusal is a stated answer, not an error: "the frame is there and it is
 * empty" is a correct result for an unfilled form, and it is reported with
 * its reason rather than as a failure.
 */

import { A4, CTS_PX_PER_MM, ctsSize, mmToCts, type PageSizeMM } from "../geometry/frames.ts";
import { prepareChannels } from "../ink/normalize.ts";
import type { PhotoDefinition } from "../forms/definitions.ts";
import { assessFormPresence, type FormPresence } from "../regions/form-presence.ts";
import { REGION_PARAMS, type AbsenceReason } from "../regions/params.ts";
import { detectPhoto } from "../regions/photo.ts";
import { renderPhotoCrop, type PhotoSource } from "../regions/postprocess.ts";
import { applyHomography, estimateHomography, minAreaRect, multiply3 } from "../vision/geometry.ts";
import { decodeFullRgb, decodeImage, encodeRgbPng, type DecodedImage } from "../vision/io.ts";
import { detectPageQuad, type PageDetection } from "../vision/page.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";
import { quadPoints, type Matrix3, type Point, type Quad, type Rgb } from "../vision/types.ts";

export interface RectifiedCapture {
  readonly page: PageDetection;
  /** The page, upright and at the canonical 200 dpi raster. What the reader is shown. */
  readonly rectified: Rgb;
  readonly pxPerMM: number;
  readonly timings: Readonly<Record<string, number>>;
  /**
   * The capture's own pixels, mapped from the rectified page, when they are
   * finer than the raster — decoded lazily, and only if a photograph is found.
   */
  readonly finerSource: () => Promise<PhotoSource | null>;
}

export async function rectifyCapture(bytes: Uint8Array, page: PageSizeMM = A4): Promise<RectifiedCapture> {
  const timings: Record<string, number> = {};
  let started = performance.now();
  const decoded = await decodeImage(bytes);
  timings.decode = Math.round(performance.now() - started);

  started = performance.now();
  const detection = detectPageQuad(decoded.gray);
  const cts = ctsSize(page);

  let pageSourceQuad: Quad;
  let rectified: Rgb;
  if (detection.method === "perspective") {
    pageSourceQuad = detection.quad;
    rectified = warpQuadRgb(decoded.rgb, detection.quad, cts.width, cts.height);
  } else {
    // No usable page boundary — a scan, or a capture cropped to the page. The
    // frame IS the page, so map the frame onto the raster — with the measured
    // skew applied here, in the same single resample. Mapping a rotated page
    // onto a square raster without it puts every template coordinate out by
    // its distance from the centre times the angle.
    const skew = (detection.skewDegrees * Math.PI) / 180;
    const cos = Math.cos(skew);
    const sin = Math.sin(skew);
    const cx = decoded.rgb.width / 2;
    const cy = decoded.rgb.height / 2;
    const scaleX = decoded.rgb.width / cts.width;
    const scaleY = decoded.rgb.height / cts.height;
    const corner = (dx: number, dy: number): Point => {
      const sx = dx * scaleX - cx;
      const sy = dy * scaleY - cy;
      return { x: sx * cos - sy * sin + cx, y: sx * sin + sy * cos + cy };
    };
    pageSourceQuad = {
      tl: corner(0, 0),
      tr: corner(cts.width, 0),
      br: corner(cts.width, cts.height),
      bl: corner(0, cts.height),
    };
    rectified = warpQuadRgb(decoded.rgb, pageSourceQuad, cts.width, cts.height);
  }
  timings.page = Math.round(performance.now() - started);

  return {
    page: detection,
    rectified,
    pxPerMM: CTS_PX_PER_MM,
    timings,
    finerSource: photoSourceFactory(bytes, decoded, pageSourceQuad, cts),
  };
}

export interface PhotoCropOptions {
  /**
   * How far the pasted print may sit from where the form says. `loose` is the
   * default: a photograph is glued by hand and lands where it lands. `exact`
   * is for geometry that was registered rather than declared.
   */
  readonly placement?: "exact" | "loose";
  readonly targetDpi?: number;
}

export type PhotoCrop =
  | {
      readonly found: true;
      readonly png: Buffer;
      readonly width: number;
      readonly height: number;
      readonly confidence: number;
      /** Low confidence or low resolution — the person should look before saving. */
      readonly needsReview: boolean;
      readonly lowResolution: boolean;
      readonly rotationDegrees: number;
      readonly detail: string;
    }
  | {
      readonly found: false;
      readonly reason: AbsenceReason | "not_a_form";
      readonly detail: string;
    };

export interface PhotoCropReport {
  readonly photo: PhotoCrop;
  readonly formPresence: FormPresence;
  readonly timings: Readonly<Record<string, number>>;
}

export async function cropPhoto(
  capture: RectifiedCapture,
  spec: PhotoDefinition,
  options: PhotoCropOptions = {},
): Promise<PhotoCropReport> {
  const { rectified, pxPerMM } = capture;
  const timings: Record<string, number> = {};
  const expected = mmToCts(spec.box);

  let started = performance.now();
  const channels = prepareChannels(rectified, { pxPerMM, imageRegions: [expected] });
  timings.normalise = Math.round(performance.now() - started);

  // Before the detector runs: addressed at the photo frame of a photograph of
  // a wall there is genuinely no photograph, and "the frame is empty" about it
  // would be a confident, specific, false statement.
  started = performance.now();
  const formPresence = assessFormPresence({ ink: channels.ink, rules: channels.rules, pxPerMM });
  if (!formPresence.recognised) {
    timings.detect = Math.round(performance.now() - started);
    return {
      photo: { found: false, reason: "not_a_form", detail: formPresence.detail },
      formPresence,
      timings,
    };
  }

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected,
    sizeMM: spec.sizeMM,
    pxPerMM,
    printedBorder: mmToCts(spec.printedBorder),
    pageSaturatedFraction: channels.saturatedFraction,
    sizeTolerance: spec.sizeTolerance,
    prior:
      (options.placement ?? "loose") === "loose"
        ? { sigmaMM: REGION_PARAMS.photo.drawnPriorSigmaMM, bandMM: REGION_PARAMS.photo.drawnPriorBandMM }
        : undefined,
  });

  if (!detection.found) {
    timings.detect = Math.round(performance.now() - started);
    return { photo: { found: false, reason: detection.reason, detail: detection.detail }, formPresence, timings };
  }

  // Delivered at the declared print size when the measurement agrees with it
  // to within the few per cent an edge fit carries — a 35x45 print comes out
  // at exactly 413x531 — and otherwise at the photograph's own measured
  // shape: the frame is the form's, the print is whatever the person pasted,
  // and stretching one into the other would distort the face.
  const finer = await capture.finerSource();
  const crop = renderPhotoCrop(
    rectified,
    detection.quad,
    deliverySize(measuredSizeMM(detection.quad, pxPerMM), spec.sizeMM),
    pxPerMM,
    options.targetDpi ?? 300,
    finer ?? undefined,
  );
  const confidence = crop.lowResolution
    ? Math.min(detection.confidence, REGION_PARAMS.photo.lowResolutionConfidenceCap)
    : detection.confidence;
  const png = await encodeRgbPng(crop.image);
  timings.detect = Math.round(performance.now() - started);

  return {
    photo: {
      found: true,
      png,
      width: crop.width,
      height: crop.height,
      confidence,
      needsReview: confidence < 0.8 || crop.lowResolution,
      lowResolution: crop.lowResolution,
      rotationDegrees: detection.rotationDegrees,
      detail: crop.lowResolution
        ? `found, but the capture only carries ${crop.effectiveDpi} dpi of it — photograph the form closer for a sharper print`
        : `found at ${Math.round(confidence * 100)} % confidence`,
    },
    formPresence,
    timings,
  };
}

/** Measurement error an edge fit is allowed before it outranks the declaration. */
const DECLARED_SIZE_SNAP = 0.06;

function deliverySize(
  measured: { widthMM: number; heightMM: number },
  declared: { widthMM: number; heightMM: number },
): { widthMM: number; heightMM: number } {
  const close = (a: number, b: number) => Math.abs(a - b) / b <= DECLARED_SIZE_SNAP;
  return close(measured.widthMM, declared.widthMM) && close(measured.heightMM, declared.heightMM) ? declared : measured;
}

/** The fitted rectangle's own dimensions, in millimetres of paper. */
function measuredSizeMM(quad: Quad, pxPerMM: number): { widthMM: number; heightMM: number } {
  const rect = minAreaRect(quadPoints(quad));
  return { widthMM: rect.width / pxPerMM, heightMM: rect.height / pxPerMM };
}

/**
 * Builds the mapping from rectified-page pixels back to the original capture,
 * and decodes the original — once, lazily, and only when asked.
 *
 * A function rather than a value because the decode is the expensive part and
 * most scans never need it: a form with no photograph, or a capture already at
 * the working resolution, must not pay 300 ms and 36 MB for pixels nobody will
 * sample.
 */
function photoSourceFactory(
  bytes: Uint8Array,
  decoded: DecodedImage,
  pageSourceQuad: Quad,
  cts: { width: number; height: number },
): () => Promise<PhotoSource | null> {
  let cached: PhotoSource | null | undefined;

  return async () => {
    if (cached !== undefined) return cached;

    // The working copy IS the original: a second decode would return the same
    // pixels through an identity transform.
    if (decoded.scale >= 0.999) {
      cached = null;
      return cached;
    }

    const ctsCorners: Point[] = [
      { x: 0, y: 0 },
      { x: cts.width - 1, y: 0 },
      { x: cts.width - 1, y: cts.height - 1 },
      { x: 0, y: cts.height - 1 },
    ];
    const ctsToWorking = estimateHomography(ctsCorners, [
      pageSourceQuad.tl,
      pageSourceQuad.tr,
      pageSourceQuad.br,
      pageSourceQuad.bl,
    ]);
    const inverse = 1 / decoded.scale;
    const workingToOriginal: Matrix3 = [inverse, 0, 0, 0, inverse, 0, 0, 0, 1];
    const transform = multiply3(workingToOriginal, ctsToWorking);

    // Measure what that mapping actually buys at the centre of the page with a
    // 10 mm rod, rather than assuming it.
    const rodMM = 10;
    const a = applyHomography(transform, { x: cts.width / 2, y: cts.height / 2 });
    const b = applyHomography(transform, { x: cts.width / 2 + rodMM * CTS_PX_PER_MM, y: cts.height / 2 });
    const pxPerMM = Math.hypot(b.x - a.x, b.y - a.y) / rodMM;

    if (pxPerMM <= CTS_PX_PER_MM * 1.02) {
      cached = null;
      return cached;
    }

    try {
      cached = { image: await decodeFullRgb(bytes), transform, pxPerMM };
    } catch {
      // A second decode failing where the first succeeded is not a reason to
      // fail the scan; the rectified page is what every crop came from before.
      cached = null;
    }
    return cached;
  };
}
