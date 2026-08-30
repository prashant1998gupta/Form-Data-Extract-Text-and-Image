import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { formById } from "@/lib/db/forms";
import { extractRegions } from "@/lib/pipeline/extract-regions";
import { resolveReader } from "@/lib/reader/provider";
import { admitReaderScan, scansPerMinute } from "@/lib/reader/throttle";
import { readTextFields } from "@/lib/reader/read-text-fields";
import { readableFields, type FieldReading } from "@/lib/reader/types";
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

/**
 * Defence in depth only — this 413 cannot fire for our own client.
 *
 * Vercel rejects any function request body over 4.5 MB at the edge before this
 * handler runs (measured on the deployment: 2.99 MB succeeds, 5.82 MB returns
 * 413 in half a second), and the browser caps its own uploads at 4 MB in
 * `lib/client/prepare-upload.ts`. This bound catches a caller that bypasses
 * both. The older rationale here — "a 12 MP JPEG is 4-12 MB, so 25 MB is
 * generous headroom" — was the reasoning the edge limit invalidated, and read
 * as though large phone photos upload fine.
 */
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

  // A PUBLISHED form: the caller names a form this deployment stores, and the
  // geometry is loaded server-side. Deliberately not sent by the browser —
  // a published form's boxes are the organization's, and a scan must not be
  // able to redefine where its own crops are cut.
  const formId = form.get("formId");
  let template;
  if (typeof formId === "string" && formId.trim()) {
    if (!isDatabaseConfigured()) {
      return fail(503, "database_unconfigured", "No database is connected, so published forms cannot be opened.");
    }
    const stored = await formById(formId.trim());
    if (!stored) {
      return fail(404, "unknown_template", "That form does not exist.");
    }
    template = stored.template;
  } else {
    // A TAUGHT form: the caller drew the boxes over their own page and sends the
    // layout with the scan. Parsed and validated, never cast — these coordinates
    // decide where a crop is cut, so every field is treated as untrusted input.
    // See the trust-boundary note in lib/templates/custom.ts.
    const supplied = form.get("template");
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
      const seeded = templateById(templateId);
      if (!seeded) {
        return fail(404, "unknown_template", "That form template does not exist.");
      }
      template = seeded;
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
    // The preview encode and the handwriting reader run concurrently: one is
    // local CPU, the other is network wait, and neither reads the other's output.
    const [pagePreview, text] = await Promise.all([
      encodeRgbJpeg(rectified, 1400),
      readHandwriting(rectified, template, result),
    ]);

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
        text,
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

/**
 * The handwriting section of the payload.
 *
 * `enabled` is whether a reader is configured at all — the UI uses it to say
 * how to turn the feature on rather than pretending it does not exist.
 * `skipped` names why nothing was attempted; `failure` appears when every
 * field failed identically (a refused key, an unreachable provider), so the
 * screen can say it once instead of eight times.
 */
interface TextPayload {
  readonly enabled: boolean;
  readonly attempted: boolean;
  readonly provider?: string;
  readonly model?: string;
  /** How the fields reached the model: one request each, or one composite request per scan. */
  readonly mode?: "perField" | "composite";
  readonly skipped?:
    | "no_text_fields"
    | "not_configured"
    | "misconfigured"
    | "not_a_form"
    | "not_registered"
    | "throttled";
  readonly failure?: string;
  readonly fields?: readonly ReturnType<typeof fieldPayload>[];
  readonly ms?: number;
}

/**
 * Runs the handwriting reader, when it should run.
 *
 * The gates mirror the image pipeline's own and exist for the same reason. No
 * reading without form presence: coordinates into a photograph of a wall
 * address nothing. No reading without registration: a text value is a LABELLED
 * claim — "patientName is Anita" — and when the page has not been confirmed as
 * this template, the label is exactly the part that has not been earned. The
 * crops degrade to "unconfirmed candidates" in that situation; a value has no
 * equivalent degraded presentation that is not just a wrong record waiting for
 * a tired click, so no value is produced at all.
 */
async function readHandwriting(
  rectified: Parameters<typeof readTextFields>[0]["rectified"],
  template: Parameters<typeof readTextFields>[0]["template"],
  result: Awaited<ReturnType<typeof extractRegions>>["result"],
): Promise<TextPayload> {
  const reader = resolveReader(process.env);
  const declared = readableFields(template);
  const enabled = reader.provider !== null;

  if (declared.length === 0) {
    return { enabled, attempted: false, skipped: "no_text_fields" };
  }

  // The PAGE gates come before the configuration gate, deliberately. On a
  // capture that is not the form, "add an API key to have these fields
  // transcribed" would be a false promise printed directly under the banner
  // saying no fields were read — the page problem is the only problem, and it
  // is stated once. Configuration only matters on a page that would be read.
  if (!result.formPresence.recognised) {
    return { enabled, attempted: false, skipped: "not_a_form" };
  }
  if (!result.registration.registered) {
    return { enabled, attempted: false, skipped: "not_registered" };
  }

  if (!reader.provider) {
    // `reason` distinguishes "never configured" from "configured wrongly", and
    // it is phrased for exactly this log line. A typo'd FORMLINK_TEXT_PROVIDER
    // that silently presented as "no key set" cost its operator the feature.
    if (reader.misconfigured) console.warn(`handwriting reader disabled: ${reader.reason}`);
    return { enabled: false, attempted: false, skipped: reader.misconfigured ? "misconfigured" : "not_configured" };
  }
  const meta = { enabled: true, provider: reader.provider.name, model: reader.provider.model, mode: reader.mode };

  // The endpoint is unauthenticated, so every admitted scan is somebody's
  // metered spend. The bound is per instance and says so where it is defined —
  // see lib/reader/throttle.ts for what it is and, more importantly, is not.
  if (!admitReaderScan({ scansPerMinute: scansPerMinute(process.env) })) {
    return { ...meta, attempted: false, skipped: "throttled" };
  }

  const started = performance.now();
  let readings: FieldReading[];
  try {
    readings = await readTextFields({ rectified, template, provider: reader.provider, mode: reader.mode });
  } catch (error) {
    // The orchestrator isolates per-field faults, so reaching here means the
    // scan-level machinery failed. The crops above are unaffected; say so.
    console.error("handwriting reader failed", error);
    return { ...meta, attempted: true, failure: "the reader failed unexpectedly" };
  }

  const failures = readings.map((reading) => reading.failure).filter((f): f is string => Boolean(f));
  const sharedFailure =
    failures.length === readings.length && new Set(failures).size === 1 ? failures[0] : undefined;

  return {
    ...meta,
    attempted: true,
    failure: sharedFailure,
    fields: readings.map(fieldPayload),
    ms: Math.round(performance.now() - started),
  };
}

function fieldPayload(reading: FieldReading) {
  return {
    fieldId: reading.fieldId,
    key: reading.key,
    label: reading.label,
    type: reading.type,
    required: reading.required,
    options: reading.options,
    hint: reading.hint,
    value: reading.value,
    blank: reading.blank,
    notInOptions: reading.notInOptions,
    failure: reading.failure,
    // Every model-read value requires review. Constant by design, and sent
    // anyway so the client renders policy rather than embedding it.
    needsReview: true,
    box: reading.regionInPage,
    evidence: reading.evidenceJpeg
      ? `data:image/jpeg;base64,${reading.evidenceJpeg.toString("base64")}`
      : undefined,
  };
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
