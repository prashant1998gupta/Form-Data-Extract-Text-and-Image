import "server-only";

import { extractRegions } from "@/lib/pipeline/extract-regions";
import { HOSPITAL_TEMPLATE, templateById } from "@/lib/templates/seed";
import { parseCustomTemplate, TemplateError } from "@/lib/templates/custom";
import { encodeRgbJpeg, ImageDecodeError } from "@/lib/vision/io";

export const runtime = "nodejs";
/**
 * Region extraction is CPU-bound and runs entirely in-process. A large scan on
 * a cold function can take a few seconds; the default 10s ceiling is too tight
 * to be safe and a timeout here looks to the operator like a broken product.
 */
export const maxDuration = 60;

/** Bounds the request body. A 12 MP JPEG is 4-12 MB; 25 MB is generous headroom. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Runs the deterministic region-extraction pipeline on an uploaded form.
 *
 * Multipart rather than a base64 data URL: base64 inflates by a third, and the
 * whole point of accepting a phone photo is that it is already large.
 *
 * NOTHING IS PERSISTED. This endpoint returns crops in the response and writes
 * nothing anywhere. Persistence belongs behind an explicit human Save, per the
 * product rule, and a demo endpoint that quietly stored patient photographs
 * would be the wrong thing to build first.
 */
export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return fail(415, "unsupported_content_type", "Send the form image as multipart/form-data.");
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail(400, "invalid_body", "The upload could not be read. Please try again.");
  }

  const file = form.get("image");
  if (!(file instanceof File)) {
    return fail(400, "missing_image", "No form image was uploaded.");
  }
  if (file.size > MAX_BYTES) {
    return fail(
      413,
      "image_too_large",
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. Photograph the form again at a lower resolution.`,
    );
  }

  // A TAUGHT form: the caller drew the boxes over their own page and sends the
  // layout with the scan. Parsed and validated, never cast — these coordinates
  // decide where a crop is cut, so every field is treated as untrusted input.
  // See the trust-boundary note in lib/templates/custom.ts.
  const supplied = form.get("template");
  let template;
  if (typeof supplied === "string" && supplied.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(supplied);
    } catch {
      return fail(400, "template_invalid", "The form layout could not be read.");
    }
    try {
      template = parseCustomTemplate(parsed);
    } catch (error) {
      if (error instanceof TemplateError) return fail(400, error.code, error.message);
      throw error;
    }
  } else {
    const templateId = String(form.get("templateId") ?? HOSPITAL_TEMPLATE.id);
    template = templateById(templateId);
    if (!template) {
      return fail(404, "unknown_template", "That form template does not exist.");
    }
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const { result, rectified } = await extractRegions(bytes, { template });

    // The rectified page, not the original, is what the verify screen shows.
    // Overlay boxes are computed in rectified coordinates; drawing them over the
    // original would misplace every one of them by however far rectification
    // moved things, which is the most confusing way to present a correct result.
    // JPEG, downscaled: this is a screen preview, not a stored artifact. As a
    // full-resolution PNG the same page is ~8.7 MB of base64 inlined into the
    // JSON, which is slow to transfer and parse and invisible at display size.
    const pagePreview = await encodeRgbJpeg(rectified, 1400);

    return Response.json(
      {
        template: { id: template.id, name: template.name, page: template.page },
        page: {
          method: result.page.method,
          confidence: result.page.confidence,
          reason: result.page.reason,
          skewDegrees: result.page.skewDegrees,
        },
        // Whether this is a printed form at all. Surfaced as a PAGE-level fact
        // rather than left to be inferred from three identical region messages:
        // when the capture is not a form, every field failing for the same
        // reason is one problem, and showing it once with the measurement
        // behind it is the difference between an operator re-photographing the
        // right thing and an operator concluding the product is broken.
        formPresence: {
          recognised: result.formPresence.recognised,
          detail: result.formPresence.detail,
          textLines: result.formPresence.textLines,
          rules: result.formPresence.rules,
        },
        // Whether this is THIS form, which is a different question from whether
        // it is a form. When the answer is no, every crop below is an
        // unconfirmed candidate rather than a field value, and no absence is
        // asserted anywhere in the payload.
        registration: {
          registered: result.registration.registered,
          detail: result.registration.detail,
          anchorsFound: result.registration.anchorsFound,
          anchorsChecked: result.registration.anchorsChecked,
        },
        rectified: {
          width: result.rectifiedWidth,
          height: result.rectifiedHeight,
          pxPerMM: result.pxPerMM,
          dataUrl: `data:image/jpeg;base64,${pagePreview.toString("base64")}`,
        },
        regions: result.regions.map((region) => ({
          fieldId: region.fieldId,
          key: region.key,
          label: region.label,
          type: region.type,
          found: region.found,
          // A refusal carries NO confidence number. There is no calibrated
          // probability for a non-event, and a percentage next to "Not Detected"
          // is false precision that undermines every other number on screen.
          confidence: region.found ? region.confidence : undefined,
          needsReview: region.needsReview,
          reason: region.reason,
          detail: region.detail,
          warning: region.warning,
          lowResolution: region.lowResolution,
          unverifiedTemplate: region.unverifiedTemplate,
          rotationDegrees: region.rotationDegrees,
          width: region.width,
          height: region.height,
          box: overlayBox(region),
          dataUrl: region.png ? `data:image/png;base64,${region.png.toString("base64")}` : undefined,
        })),
        fieldsWithoutGeometry: result.fieldsWithoutGeometry,
        timings: result.timings,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ImageDecodeError) {
      return fail(422, error.code, error.message);
    }
    // Log the real error server-side; show the operator something actionable.
    console.error("extract failed", error);
    return fail(
      500,
      "extraction_failed",
      "The form could not be processed. Try photographing it again with the whole page in frame.",
    );
  }
}

/** Axis-aligned overlay rectangle in rectified-page pixels, when there is one. */
function overlayBox(region: {
  quadInPage?: { tl: { x: number; y: number }; tr: { x: number; y: number }; br: { x: number; y: number }; bl: { x: number; y: number } };
  regionInPage?: { x: number; y: number; width: number; height: number };
}) {
  if (region.quadInPage) {
    const xs = [region.quadInPage.tl.x, region.quadInPage.tr.x, region.quadInPage.br.x, region.quadInPage.bl.x];
    const ys = [region.quadInPage.tl.y, region.quadInPage.tr.y, region.quadInPage.br.y, region.quadInPage.bl.y];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  return region.regionInPage;
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
