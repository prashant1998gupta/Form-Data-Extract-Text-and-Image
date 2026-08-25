/**
 * The region-extraction pipeline, end to end.
 *
 * Takes the bytes of a captured form and a template, and returns one result per
 * image field — a crop, or a stated reason there is none. No model is called
 * anywhere in this file.
 *
 * The stages, and why each is where it is:
 *
 *   1. DECODE once, applying EXIF orientation. A phone photo held in portrait
 *      arrives as landscape pixels plus a rotation tag; skip this and page
 *      detection looks for a portrait page in a landscape image and every later
 *      stage degrades silently.
 *   2. LOCATE THE PAGE and rectify it, or refuse to. A bad rectification is
 *      worse than none — the output still looks like a page while every
 *      template coordinate now addresses the wrong part of it.
 *   3. NORMALISE photometrically and measure the paper, which is what every
 *      subsequent threshold is expressed relative to.
 *   4. DETECT each declared image field in its own region.
 *   5. RENDER the crops from the ORIGINAL pixels, not the working copy.
 */

import { prepareChannels, type ScanChannels } from "../ink/normalize.ts";
import {
  CTS_PX_PER_MM,
  clipToPage,
  ctsSize,
  expandMM,
  mmToCts,
  PHOTO_SIZES,
  type RectMM,
} from "../geometry/frames.ts";
import { decodeImage, type DecodedImage } from "../vision/io.ts";
import { detectPageQuad, rectifyPage, type PageDetection } from "../vision/page.ts";
import { toGray } from "../vision/gray.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";
import { detectPhoto } from "../regions/photo.ts";
import { detectSignature } from "../regions/signature.ts";
import { detectThumb } from "../regions/thumb.ts";
import { renderPhotoCrop, renderSignatureCrop } from "../regions/postprocess.ts";
import { REGION_PARAMS, type AbsenceReason, type GateClause } from "../regions/params.ts";
import { allFields, imageFields, isImageField, type FormField, type FormTemplate } from "../templates/types.ts";
import type { Quad, Rect, Rgb } from "../vision/types.ts";

export interface RegionResult {
  readonly fieldId: string;
  readonly key: string;
  readonly label: string;
  readonly type: FormField["type"];
  readonly found: boolean;
  /** PNG bytes when found. RGBA with a transparent background for ink elements. */
  readonly png?: Buffer;
  readonly width?: number;
  readonly height?: number;
  /** Never present when `found` is false. */
  readonly confidence?: number;
  readonly needsReview: boolean;
  /** Present only when `found` is false. */
  readonly reason?: AbsenceReason;
  readonly failedClause?: GateClause;
  readonly detail?: string;
  /** Surfaced when the mark in a box belongs in a different one. */
  readonly warning?: string;
  /** Where the crop was taken from, in the rectified page's pixels. For the overlay. */
  readonly regionInPage?: Rect;
  readonly quadInPage?: Quad;
  readonly rotationDegrees?: number;
  readonly lowResolution?: boolean;
}

export interface ExtractionResult {
  readonly page: PageDetection;
  /** The rectified page as PNG, for the left-hand pane of the verify screen. */
  readonly rectifiedWidth: number;
  readonly rectifiedHeight: number;
  readonly pxPerMM: number;
  readonly regions: readonly RegionResult[];
  readonly timings: Readonly<Record<string, number>>;
  /** Fields the template declares but has no geometry for. */
  readonly fieldsWithoutGeometry: readonly string[];
}

export interface ExtractOptions {
  readonly template: FormTemplate;
  /** Milliseconds since epoch, supplied by the caller so this stays pure. */
  readonly now?: number;
}

/**
 * Runs the deterministic pipeline.
 *
 * `rectified` is returned alongside the results so the caller can show the
 * exact image the detectors saw. Showing the ORIGINAL under the overlay boxes
 * would misplace every box by however much the rectification moved things,
 * which is the most confusing possible way to present a correct result.
 */
export async function extractRegions(
  bytes: Uint8Array,
  options: ExtractOptions,
): Promise<{ result: ExtractionResult; rectified: Rgb; decoded: DecodedImage }> {
  const { template } = options;
  const timings: Record<string, number> = {};
  const mark = (label: string, from: number) => {
    timings[label] = Math.round(performance.now() - from);
  };

  let started = performance.now();
  const decoded = await decodeImage(bytes);
  mark("decode", started);

  // ---- page localisation --------------------------------------------------
  started = performance.now();
  const detection = detectPageQuad(decoded.gray);
  const cts = ctsSize(template.page);

  // Rectify to the Canonical Template Space raster, so a millimetre is the same
  // number of pixels regardless of how the page was captured.
  let rectified: Rgb;
  if (detection.method === "perspective") {
    rectified = warpQuadRgb(decoded.rgb, detection.quad, cts.width, cts.height);
  } else {
    // No usable page boundary — a scan, or a capture cropped to the page. The
    // frame IS the page, so map the frame onto the CTS raster.
    //
    // THE ROTATION MUST BE APPLIED HERE. `detection.skewDegrees` is measured
    // from the page's own content, and ignoring it maps a rotated page onto a
    // square raster: the image looks fine, and every template coordinate is off
    // by however far its distance from the centre times the angle. Measured on
    // a 4-degree fixture, the photograph and thumb both failed detection
    // outright while the signature — nearer the rotation centre and searched in
    // a generously padded region — still succeeded, which is exactly the kind of
    // partial, plausible failure that is hard to attribute.
    //
    // Rotating the SOURCE quad by the measured angle makes the warp undo it, in
    // the same single resample that does the scaling.
    const skew = (detection.skewDegrees * Math.PI) / 180;
    const cos = Math.cos(skew);
    const sin = Math.sin(skew);
    const cx = decoded.rgb.width / 2;
    const cy = decoded.rgb.height / 2;
    const scaleX = decoded.rgb.width / cts.width;
    const scaleY = decoded.rgb.height / cts.height;

    const corner = (dx: number, dy: number) => {
      const sx = dx * scaleX - cx;
      const sy = dy * scaleY - cy;
      return { x: sx * cos - sy * sin + cx, y: sx * sin + sy * cos + cy };
    };

    const frame: Quad = {
      tl: corner(0, 0),
      tr: corner(cts.width, 0),
      br: corner(cts.width, cts.height),
      bl: corner(0, cts.height),
    };
    rectified = warpQuadRgb(decoded.rgb, frame, cts.width, cts.height);
  }
  void rectifyPage;
  void toGray;
  mark("page", started);

  // In CTS the scale is fixed by construction — that is the entire point of
  // having a canonical space.
  const pxPerMM = CTS_PX_PER_MM;

  // ---- photometric normalisation -----------------------------------------
  started = performance.now();
  const declaredRegions = imageFields(template)
    .map((field) => (field.box ? toPixels(field.box, template) : null))
    .filter((rect): rect is Rect => rect !== null);

  const channels = prepareChannels(rectified, { pxPerMM, imageRegions: declaredRegions });
  mark("normalise", started);

  // ---- detection ----------------------------------------------------------
  started = performance.now();
  const regions: RegionResult[] = [];
  const withoutGeometry: string[] = [];

  for (const field of allFields(template)) {
    if (!isImageField(field.type)) continue;
    if (!field.box) {
      withoutGeometry.push(field.key);
      regions.push({
        fieldId: field.id,
        key: field.key,
        label: field.label,
        type: field.type,
        found: false,
        needsReview: true,
        reason: "geometry_unknown",
        detail: "this template has no position recorded for this field yet",
      });
      continue;
    }

    regions.push(await detectField(field, template, channels, rectified, pxPerMM));
  }
  mark("detect", started);

  return {
    result: {
      page: detection,
      rectifiedWidth: rectified.width,
      rectifiedHeight: rectified.height,
      pxPerMM,
      regions,
      timings,
      fieldsWithoutGeometry: withoutGeometry,
    },
    rectified,
    decoded,
  };
}

async function detectField(
  field: FormField,
  template: FormTemplate,
  channels: ScanChannels,
  rectified: Rgb,
  pxPerMM: number,
): Promise<RegionResult> {
  const base = { fieldId: field.id, key: field.key, label: field.label, type: field.type };

  if (field.type === "photograph") {
    const expected = toPixels(field.box!, template);
    const size = PHOTO_SIZES[field.photoSize ?? "passport35x45"];
    const detection = detectPhoto({
      lab: channels.lab,
      texture: channels.texture,
      ink: channels.ink,
      paper: channels.paper,
      expected,
      sizeMM: size,
      pxPerMM,
      printedBorder: field.printedBorder ? toPixels(field.printedBorder, template) : undefined,
      pageSaturatedFraction: channels.saturatedFraction,
    });

    if (!detection.found) {
      return { ...base, found: false, needsReview: true, reason: detection.reason, failedClause: detection.failedClause, detail: detection.detail };
    }

    const crop = renderPhotoCrop(rectified, detection.quad, size, pxPerMM);
    const { encodeRgbPng } = await import("../vision/io.ts");
    return {
      ...base,
      found: true,
      png: await encodeRgbPng(crop.image),
      width: crop.width,
      height: crop.height,
      confidence: crop.lowResolution
        ? Math.min(detection.confidence, REGION_PARAMS.photo.lowResolutionConfidenceCap)
        : detection.confidence,
      needsReview: detection.confidence < 0.8 || crop.lowResolution,
      quadInPage: detection.quad,
      rotationDegrees: detection.rotationDegrees,
      lowResolution: crop.lowResolution,
    };
  }

  // Signature and thumb both search an EXPANDED region: signatures habitually
  // overflow their printed box, and a thumb is pressed by hand rather than
  // placed.
  const params = field.type === "signature" ? REGION_PARAMS.signature : REGION_PARAMS.thumb;
  const padMM = "searchPadMM" in params ? params.searchPadMM : 0;
  const roiMM = clipToPage(expandMM(field.box!, padMM, params.searchPadFraction), template.page);
  const roi = toPixels(roiMM, template);

  if (field.type === "signature") {
    const detection = detectSignature({
      ink: channels.ink,
      roi,
      pxPerMM,
      baselineY: field.baselineMM ? field.baselineMM * pxPerMM : undefined,
    });
    if (!detection.found) {
      return { ...base, found: false, needsReview: true, reason: detection.reason, failedClause: detection.failedClause, detail: detection.detail };
    }
    const crop = renderSignatureCrop(rectified, detection.mask, detection.bounds, pxPerMM);
    const { encodeRgbaPng } = await import("../vision/io.ts");
    return {
      ...base,
      found: true,
      png: await encodeRgbaPng(crop.rgba, crop.width, crop.height),
      width: crop.width,
      height: crop.height,
      confidence: detection.confidence,
      needsReview: detection.needsReview,
      regionInPage: detection.bounds,
      warning: detection.excludedAdjacentContent
        ? "Part of the surrounding content was excluded from this crop — please check nothing is missing."
        : undefined,
    };
  }

  const detection = detectThumb({ ink: channels.ink, rgb: rectified, roi, pxPerMM });
  if (!detection.found) {
    return {
      ...base,
      found: false,
      needsReview: true,
      reason: detection.reason,
      failedClause: detection.failedClause,
      detail: detection.detail,
      warning: detection.wrongBoxWarning,
    };
  }
  const crop = renderSignatureCrop(rectified, detection.mask, detection.bounds, pxPerMM);
  const { encodeRgbaPng } = await import("../vision/io.ts");
  return {
    ...base,
    found: true,
    png: await encodeRgbaPng(crop.rgba, crop.width, crop.height),
    width: crop.width,
    height: crop.height,
    confidence: detection.confidence,
    needsReview: true,
    regionInPage: detection.bounds,
  };
}

function toPixels(rect: RectMM, template: FormTemplate): Rect {
  void template;
  return mmToCts(rect);
}
