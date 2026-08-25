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
import { decodeFullRgb, decodeImage, type DecodedImage } from "../vision/io.ts";
import { detectPageQuad, type PageDetection } from "../vision/page.ts";
import { warpQuadRgb } from "../vision/warp-rgb.ts";
import { applyHomography, estimateHomography, multiply3 } from "../vision/geometry.ts";
import { detectPhoto } from "../regions/photo.ts";
import { detectSignature } from "../regions/signature.ts";
import { detectThumb } from "../regions/thumb.ts";
import { renderPhotoCrop, renderSignatureCrop, type PhotoSource } from "../regions/postprocess.ts";
import { assessFormPresence, type FormPresence } from "../regions/form-presence.ts";
import { verifyTemplateAnchors, type TemplateRegistration } from "../regions/template-anchors.ts";
import { REGION_PARAMS, type AbsenceReason, type GateClause } from "../regions/params.ts";
import { allFields, imageFields, isImageField, type FormField, type FormTemplate } from "../templates/types.ts";
import type { Matrix3, Point, Quad, Rect, Rgb } from "../vision/types.ts";

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
  /**
   * True when this result was produced against a template whose landmarks could
   * NOT be confirmed on the page. The crop may be a perfectly good crop of
   * something; what is not established is that it is this FIELD. The verify
   * screen must not present it as a settled value.
   */
  readonly unverifiedTemplate?: boolean;
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
  /**
   * Whether the capture carries enough printed structure to be addressed by
   * template coordinates at all. When it does not, no detector runs: see
   * `lib/regions/form-presence.ts` for why a refusal is worse than useless if
   * the page it describes was never there.
   */
  readonly formPresence: FormPresence;
  /**
   * Whether the template's own printed landmarks were found where it says they
   * are. When they were not, template coordinates mean nothing on this page and
   * NO ABSENCE MAY BE ASSERTED — see `lib/regions/template-anchors.ts`.
   */
  readonly registration: TemplateRegistration;
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
  // The quad in WORKING pixels that the rectified page was sampled from. Kept
  // because it is exactly the mapping needed to go back the other way, from a
  // coordinate measured on the rectified page to the pixels of the original
  // capture — which is how the delivered photograph gets its full resolution.
  let pageSourceQuad: Quad;
  let rectified: Rgb;
  if (detection.method === "perspective") {
    pageSourceQuad = detection.quad;
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
    pageSourceQuad = frame;
    rectified = warpQuadRgb(decoded.rgb, frame, cts.width, cts.height);
  }
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

  // ---- is this the form at all? -------------------------------------------
  //
  // BEFORE any detector runs, because a detector's answer is only worth having
  // if the coordinates it was handed mean something. Addressed at 160.2 mm,
  // 30.3 mm of a photograph of a wall there is genuinely no passport photo, and
  // reporting "the box was located and is empty" about it is a confident,
  // specific, false statement — the exact failure this product refuses to make
  // one step earlier in the pipeline.
  started = performance.now();
  const formPresence = assessFormPresence({ ink: channels.ink, rules: channels.rules, pxPerMM });

  // ...and is it THIS form? Presence and identity are different questions, and
  // conflating them is how a school certificate got measured against hospital
  // coordinates. This one cannot correct a misalignment, only notice one — but
  // noticing is what decides whether an absence may be asserted at all.
  const registration = verifyTemplateAnchors({
    inkWithRules: channels.inkWithRules,
    template,
    pxPerMM,
  });
  mark("recognise", started);

  // ---- detection ----------------------------------------------------------
  started = performance.now();
  const regions: RegionResult[] = [];
  const withoutGeometry: string[] = [];

  // Decoded at most once, and only if a photograph is actually found. Nothing
  // else delivers enough resolution to be worth a second decode: the signature
  // and thumb are ink-on-transparency built from a mask measured in the
  // rectified page, and upsampling that mask would soften the very edges the
  // crop is made of.
  const finerPhotoSource = photoSourceFactory(bytes, decoded, pageSourceQuad, cts);

  for (const field of allFields(template)) {
    if (!isImageField(field.type)) continue;

    const base = { fieldId: field.id, key: field.key, label: field.label, type: field.type };

    if (!field.box) {
      withoutGeometry.push(field.key);
      regions.push({
        ...base,
        found: false,
        needsReview: true,
        reason: "geometry_unknown",
        detail: "this template has no position recorded for this field yet",
      });
      continue;
    }

    if (!formPresence.recognised) {
      regions.push({
        ...base,
        found: false,
        needsReview: true,
        reason: "geometry_unknown",
        failedClause: "trust",
        detail: formPresence.detail,
      });
      continue;
    }

    const result = await detectField(field, template, channels, rectified, pxPerMM, finerPhotoSource);
    regions.push(registration.registered ? result : withoutTemplateTrust(result, registration));
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
      formPresence,
      registration,
    },
    rectified,
    decoded,
  };
}

/**
 * Downgrades a result produced against a template whose landmarks were not
 * found on the page.
 *
 * THE ASYMMETRY THIS ENFORCES. A POSITIVE finding — "there is a pasted
 * photograph here" — is a claim about pixels that were examined, and it
 * survives not knowing which form this is. A NEGATIVE finding — "the photo box
 * is empty" — is a claim about a LOCATION, and it is meaningless unless the
 * location is known. When the template's own printed furniture is not where it
 * says, the location is not known.
 *
 * So absence is demoted to `geometry_unknown`, the reason that already means
 * "registration could not be trusted, so no region could be addressed at all" —
 * never `box_empty`, which asserts a located box. That is the exact sentence
 * that was produced about a photograph plainly present on a user's form.
 *
 * A crop that WAS found is kept, because it is real: something is there and the
 * operator should see it. What is removed is the assertion that it belongs to
 * this field. It is flagged, forced to review, and the verify screen presents it
 * as an unconfirmed candidate rather than as a value — because the harm in the
 * reported failure was not the crop, it was the words "Patient Signature"
 * printed under a photograph of a table.
 */
function withoutTemplateTrust(result: RegionResult, registration: TemplateRegistration): RegionResult {
  if (!result.found) {
    return {
      ...result,
      reason: "geometry_unknown",
      failedClause: "trust",
      detail: registration.detail,
      needsReview: true,
    };
  }
  return { ...result, unverifiedTemplate: true, needsReview: true };
}

/**
 * Builds the mapping from rectified-page pixels back to the original capture,
 * and decodes the original — once, lazily, and only when asked.
 *
 * Returns a function rather than a value because the decode is the expensive
 * part and most scans never need it: a form with no photograph, or a capture
 * already at the working resolution, must not pay 300 ms and 36 MB for pixels
 * nobody will sample.
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

    // The working copy IS the original. A second decode would return the same
    // pixels and the warp would sample them through an identity transform.
    if (decoded.scale >= 0.999) {
      cached = null;
      return cached;
    }

    // Rectified page -> working pixels. This is the inverse of the warp that
    // produced the rectified page, and `warpQuadRgb` builds it in exactly this
    // direction, so it is re-derived rather than inverted.
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

    // Working -> original is a pure scale: `decoded.scale` is working/original.
    const inverse = 1 / decoded.scale;
    const workingToOriginal: Matrix3 = [inverse, 0, 0, 0, inverse, 0, 0, 0, 1];
    const transform = multiply3(workingToOriginal, ctsToWorking);

    // Measure what that mapping actually buys, rather than assuming it. Under
    // perspective the gain varies across the page, so it is measured at the
    // centre with a 10 mm rod — long enough not to be dominated by rounding,
    // short enough to be local.
    const rodMM = 10;
    const a = applyHomography(transform, { x: cts.width / 2, y: cts.height / 2 });
    const b = applyHomography(transform, {
      x: cts.width / 2 + rodMM * CTS_PX_PER_MM,
      y: cts.height / 2,
    });
    const pxPerMM = Math.hypot(b.x - a.x, b.y - a.y) / rodMM;

    // Nothing to gain, and a decode to prove it. Sampling a source that is no
    // finer than the rectified page only adds an interpolation.
    if (pxPerMM <= CTS_PX_PER_MM * 1.02) {
      cached = null;
      return cached;
    }

    try {
      cached = { image: await decodeFullRgb(bytes), transform, pxPerMM };
    } catch {
      // A second decode failing where the first succeeded is not a reason to
      // fail the scan. Fall back to the rectified page, which is what every
      // crop was taken from before this path existed.
      cached = null;
    }
    return cached;
  };
}

async function detectField(
  field: FormField,
  template: FormTemplate,
  channels: ScanChannels,
  rectified: Rgb,
  pxPerMM: number,
  finerPhotoSource: () => Promise<PhotoSource | null>,
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
      // A box a person DREW is a different kind of claim from one registration
      // produced, and the detector has to be told. With the registered prior it
      // refuses a box 4 mm out; with this one it recovers a box 6 mm out at IoU
      // 0.988. Widening further makes it WORSE, not better — see the measured
      // sweep in params.ts.
      prior:
        field.origin === "drawn"
          ? { sigmaMM: REGION_PARAMS.photo.drawnPriorSigmaMM, bandMM: REGION_PARAMS.photo.drawnPriorBandMM }
          : undefined,
    });

    if (!detection.found) {
      return { ...base, found: false, needsReview: true, reason: detection.reason, failedClause: detection.failedClause, detail: detection.detail };
    }

    const finer = await finerPhotoSource();
    const crop = renderPhotoCrop(rectified, detection.quad, size, pxPerMM, 300, finer ?? undefined);
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
