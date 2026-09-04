import "server-only";

import { parseReaderReply, ReplyFormatError } from "@/lib/extract/parse";
import { buildReaderPrompt } from "@/lib/extract/prompt";
import { ProviderError, type TextProvider } from "@/lib/extract/provider-types";
import { readWithRetry, resolveReader } from "@/lib/extract/reader";
import { admitReaderScan, scansPerMinute } from "@/lib/extract/throttle";
import { formById, type FormDefinition } from "@/lib/forms/definitions";
import { canvasBoxToImage, locatePhoto, normalizeBox, type LocatedPhoto } from "@/lib/photo/locate-photo";
import { decodeFullRgb, decodeImage, encodeRgbJpegSquare, ImageDecodeError, type DecodedImage } from "@/lib/vision/io";

export const runtime = "nodejs";
/**
 * Decoding a phone photo and measuring the photograph are CPU-bound and run
 * in-process, and the reader is a network round trip on top. The default 10 s
 * ceiling is too tight to be safe, and a timeout here looks like a broken app.
 */
export const maxDuration = 60;

/**
 * Defence in depth only — Vercel rejects bodies over 4.5 MB at the edge before
 * this runs, and the browser caps its own uploads at 4 MB. This catches a
 * caller that bypasses both.
 */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * The picture the model is shown: the capture as taken, at 2000 px on its long
 * edge, at the top-left of a 2000 px square canvas — comfortably legible for
 * handwriting, well inside Groq's 4 MB base64 limit. Not straightened first:
 * the model reads a tilted page fine, and the box it returns must refer to
 * the frame the crop is cut from. Square, because the model's box was found
 * to use the picture's height as the scale of BOTH axes; on a square every
 * convention agrees (see `encodeRgbJpegSquare`).
 */
const READER_IMAGE_EDGE = 2000;
const READER_TIMEOUT_MS = 40_000;

/**
 * One scan: the capture goes to the vision model with the form's field list;
 * the reply carries every field and where the pasted photograph is; the
 * photograph is then cut from the capture there.
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
  const timings: Record<string, number> = {};
  let decoded: DecodedImage;
  try {
    const started = performance.now();
    decoded = await decodeImage(bytes);
    timings.decode = Math.round(performance.now() - started);
  } catch (error) {
    if (error instanceof ImageDecodeError) return fail(422, error.code, error.message);
    console.error("capture could not be decoded", error);
    return fail(500, "extraction_failed", "The photo could not be processed. Try photographing the form again.");
  }

  try {
    const reading = await readCapture(decoded, form, reader.provider);
    timings.read = reading.ms;

    const started = performance.now();
    const photo = await findPhoto(bytes, decoded, reading.photoBox, form);
    timings.photo = Math.round(performance.now() - started);
    // Where the reader said the photograph was, raw and as read. Diagnostic:
    // a crop that misses is explained by these four numbers or by nothing.
    const hint = { raw: reading.rawPhotoBox, box: reading.photoBox, imageSize: reading.sent };

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
              method: photo.method,
              detail: photo.detail,
              hint,
            }
          : { found: false, reason: photo.reason, detail: photo.detail, hint },
        reader: { provider: reader.provider.name, model: reader.provider.model, ms: reading.ms },
        timings,
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

/** The model reads the capture; its photo box comes back as fractions of the capture. */
async function readCapture(decoded: DecodedImage, form: FormDefinition, provider: TextProvider) {
  const started = performance.now();
  const canvas = await encodeRgbJpegSquare(decoded.rgb, READER_IMAGE_EDGE, 85);
  const prompt = buildReaderPrompt(form);
  const text = await readWithRetry(provider, {
    imageJpegBase64: canvas.jpeg.toString("base64"),
    system: prompt.system,
    prompt: prompt.user,
    timeoutMs: READER_TIMEOUT_MS,
  });
  const parsed = parseReaderReply(text, form);
  const onCanvas = parsed.photoBox ? normalizeBox(parsed.photoBox, canvas.edge, canvas.edge) : null;
  const photoBox = onCanvas ? canvasBoxToImage(onCanvas, canvas.width, canvas.height, canvas.edge) : null;
  return {
    ...parsed,
    rawPhotoBox: parsed.photoBox,
    photoBox,
    sent: { width: canvas.width, height: canvas.height, edge: canvas.edge },
    ms: Math.round(performance.now() - started),
  };
}

/**
 * The photograph is cut from the capture at its NATIVE resolution when the
 * working copy was downscaled — the box is in fractions, so it addresses
 * either image — and only decoded a second time when there is a box to cut.
 */
async function findPhoto(
  bytes: Uint8Array,
  decoded: DecodedImage,
  box: ReturnType<typeof normalizeBox>,
  form: FormDefinition,
): Promise<LocatedPhoto> {
  if (!box) return locatePhoto(decoded.rgb, null, form.photo);
  let source = decoded.rgb;
  if (decoded.scale < 0.999) {
    try {
      source = await decodeFullRgb(bytes);
    } catch {
      // The working copy is what every crop came from before; a failed second
      // decode costs resolution, never the photograph.
    }
  }
  return locatePhoto(source, box, form.photo);
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
}
