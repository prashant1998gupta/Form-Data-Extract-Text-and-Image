import "server-only";

import { parseReaderReply, ReplyFormatError } from "@/lib/extract/parse";
import { buildReaderPrompt } from "@/lib/extract/prompt";
import { ProviderError, type TextProvider } from "@/lib/extract/provider-types";
import { readWithRetry, resolveReader } from "@/lib/extract/reader";
import { admitReaderScan, scansPerMinute } from "@/lib/extract/throttle";
import { formById, type FormDefinition } from "@/lib/forms/definitions";
import { cropPhoto, rectifyCapture, type RectifiedCapture } from "@/lib/photo/crop-photo";
import { encodeRgbJpeg, ImageDecodeError } from "@/lib/vision/io";

export const runtime = "nodejs";
/**
 * Page straightening and photo detection are CPU-bound and run in-process, and
 * the reader is a network round trip on top. The default 10 s ceiling is too
 * tight to be safe, and a timeout here looks to the person like a broken app.
 */
export const maxDuration = 60;

/**
 * Defence in depth only — Vercel rejects bodies over 4.5 MB at the edge before
 * this runs, and the browser caps its own uploads at 4 MB. This catches a
 * caller that bypasses both.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * The page image the model is shown: the straightened page at 2000 px on its
 * long edge — about 170 dpi of paper, comfortably legible for handwriting —
 * encoded once for the request. Well inside Groq's 4 MB base64 limit.
 */
const READER_IMAGE_EDGE = 2000;
const READER_TIMEOUT_MS = 40_000;

/**
 * One scan: the straightened page goes to the vision model with the form's
 * field list, while the photograph is measured and cut locally. The two run
 * concurrently — one is network wait, the other is CPU — and neither reads
 * the other's output.
 *
 * NOTHING IS PERSISTED. The reply carries values and a crop; saving is a
 * separate, explicit action on the scan screen after a person has looked.
 */
export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return fail(415, "unsupported_content_type", "Send the form photo as multipart/form-data.");
  }

  let body: FormData;
  try {
    body = await request.formData();
  } catch {
    return fail(400, "invalid_body", "The upload could not be read. Please try again.");
  }

  const form = formById(String(body.get("form") ?? ""));
  if (!form) return fail(400, "unknown_form", "Choose which form you are scanning.");

  const file = body.get("image");
  if (!(file instanceof File)) return fail(400, "missing_image", "No photo of the form was uploaded.");
  if (file.size > MAX_BYTES) {
    return fail(413, "image_too_large", "That photo is too large. Photograph the form again at a lower resolution.");
  }

  // The reader is checked BEFORE any work: with no key, the honest answer is
  // "reading is off on this server", in words the operator can act on.
  const reader = resolveReader(process.env);
  if (!reader.provider) {
    return fail(
      503,
      "reader_not_configured",
      "Form reading is not configured on this server: set GROQ_API_KEY. You can still fill the form by hand.",
    );
  }
  // The endpoint is unauthenticated, so every admitted scan is metered spend.
  if (!admitReaderScan({ scansPerMinute: scansPerMinute(process.env) })) {
    return fail(429, "throttled", "Too many scans in the last minute. Wait a moment and try again.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  let capture: RectifiedCapture;
  try {
    capture = await rectifyCapture(bytes, form.page);
  } catch (error) {
    if (error instanceof ImageDecodeError) return fail(422, error.code, error.message);
    console.error("capture could not be prepared", error);
    return fail(500, "extraction_failed", "The photo could not be processed. Try photographing the form again with the whole page in frame.");
  }

  try {
    const [reading, cropped] = await Promise.all([readPage(capture, form, reader.provider), cropPhoto(capture, form.photo)]);
    const photo = cropped.photo;

    return Response.json(
      {
        form: form.id,
        readable: reading.readable,
        values: reading.values,
        unreadable: reading.unreadable,
        notInOptions: reading.notInOptions,
        filled: reading.filled,
        photo: photo.found
          ? {
              found: true,
              dataUrl: `data:image/png;base64,${photo.png.toString("base64")}`,
              width: photo.width,
              height: photo.height,
              confidence: photo.confidence,
              needsReview: photo.needsReview,
              detail: photo.detail,
            }
          : { found: false, reason: photo.reason, detail: photo.detail },
        page: { method: capture.page.method, confidence: capture.page.confidence, isForm: cropped.formPresence.recognised },
        reader: { provider: reader.provider.name, model: reader.provider.model, ms: reading.ms },
        timings: { ...capture.timings, ...cropped.timings, read: reading.ms },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ProviderError) {
      const status = error.status === 429 ? 429 : 502;
      return fail(status, status === 429 ? "reader_busy" : "reader_failed", `The form could not be read: ${error.message}.`);
    }
    if (error instanceof ReplyFormatError) {
      return fail(502, "reader_reply_invalid", "The reader replied in an unexpected format. Please try again.");
    }
    console.error("extract failed", error);
    return fail(500, "extraction_failed", "The form could not be processed. Please try again.");
  }
}

async function readPage(capture: RectifiedCapture, form: FormDefinition, provider: TextProvider) {
  const started = performance.now();
  const jpeg = await encodeRgbJpeg(capture.rectified, READER_IMAGE_EDGE, 85);
  const prompt = buildReaderPrompt(form);
  const text = await readWithRetry(provider, {
    imageJpegBase64: jpeg.toString("base64"),
    system: prompt.system,
    prompt: prompt.user,
    timeoutMs: READER_TIMEOUT_MS,
  });
  const parsed = parseReaderReply(text, form);
  return { ...parsed, ms: Math.round(performance.now() - started) };
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
