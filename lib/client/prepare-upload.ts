/**
 * Browser-side capture preparation.
 *
 * WHY THIS EXISTS. Vercel rejects any function request body over 4.5 MB with a
 * plain-text `FUNCTION_PAYLOAD_TOO_LARGE`, at the edge, before a single line of
 * our code runs. A 12 MP phone photo is 4-12 MB — so the primary capture device
 * our users own fails on the primary path, and it fails somewhere the
 * application cannot even produce a decent error message. Measured against the
 * deployment: 2.99 MB succeeds, 5.82 MB returns 413 in half a second.
 *
 * `docs/02-architecture.md` Stage 1 answers this properly, by PUTting the
 * original straight to Storage and posting a small JSON job. Until persistence
 * exists there is nothing to PUT it to, so the capture is normalised here
 * instead. When Storage lands this module keeps its job — it still produces the
 * analysis-sized copy — and simply stops being the only thing standing between
 * a phone photo and a 413.
 *
 * WHY 3500 PX, NOT 2400. The server analyses at 2400 px on the long edge
 * (`WORKING_EDGE`), and it is tempting to send exactly that and no more. But
 * crops are cut from the uploaded pixels, not from the analysis copy. An A4
 * page at 3500 px on its long edge is 300 DPI of paper, which is exactly the
 * passport photograph's delivery resolution — so at 3500 px the portrait is
 * rendered 1:1 from pixels the phone really captured. At 2400 px the same
 * portrait is a 1.5x upscale of data we were handed for free and threw away.
 * 3500 px at quality 90 is 1.5-2.5 MB, comfortably inside the cap.
 *
 * WHAT IS DELIBERATELY NOT DONE HERE. Nothing is analysed, measured or judged.
 * This resizes and re-encodes, and that is all. Every geometric decision stays
 * on the server, against the pixels it was actually given, because a browser
 * capability gap must never silently move a threshold — a phone whose canvas
 * behaves differently would otherwise change the accuracy of the result rather
 * than just the size of the upload.
 */

/** Long edge of the uploaded capture. 300 DPI on A4 — see the module note. */
export const UPLOAD_EDGE = 3500;

/**
 * Upload budget. Vercel's real ceiling is 4.5 MB; the margin absorbs the
 * multipart envelope and the filename, which are counted against the same
 * limit and are not free.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * iOS Safari caps total canvas area, and a canvas over the cap does not throw —
 * it silently produces a blank or truncated bitmap, which would upload as a
 * white page and be reported as a form with three empty boxes. Well above any
 * size this module targets on a page-shaped capture; it exists so a square or
 * panoramic input cannot reach the cap by accident.
 */
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Quality ladder. Descends only as far as it must: the first rung that fits is
 * the one that ships. 0.6 is the floor because JPEG below it puts blocking
 * artefacts into exactly the 0.4-0.6 mm band that stroke-width statistics are
 * measured in, and a smaller file is not worth a worse measurement.
 */
const QUALITY_STEPS = [0.92, 0.86, 0.8, 0.72, 0.64, 0.6] as const;

export interface PreparedUpload {
  readonly file: File;
  /** False when the capture was already within budget and was passed through untouched. */
  readonly recompressed: boolean;
  readonly originalBytes: number;
  readonly uploadBytes: number;
  readonly width: number;
  readonly height: number;
}

export class UploadPrepareError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "UploadPrepareError";
    this.code = code;
  }
}

/**
 * Normalises a captured file into something the server will actually receive.
 *
 * Returns the ORIGINAL file untouched when it already fits, both in bytes and
 * in pixels. Re-encoding a capture that was already small buys nothing and
 * costs a generation of JPEG loss on the one image the whole product depends
 * on.
 */
export async function prepareUpload(file: File): Promise<PreparedUpload> {
  const bitmap = await decodeToBitmap(file);

  try {
    const longest = Math.max(bitmap.width, bitmap.height);

    if (file.size <= MAX_UPLOAD_BYTES && longest <= UPLOAD_EDGE) {
      return {
        file,
        recompressed: false,
        originalBytes: file.size,
        uploadBytes: file.size,
        width: bitmap.width,
        height: bitmap.height,
      };
    }

    // Two independent ceilings, and the tighter one wins: the long-edge target
    // above, and the canvas area cap that protects against a silently blank
    // draw on iOS.
    const byEdge = Math.min(1, UPLOAD_EDGE / longest);
    const byArea = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
    let scale = Math.min(byEdge, byArea);

    // Two attempts at most. The second halves the dimensions, which quarters the
    // pixel count — enough to bring any plausible capture inside the budget once
    // the quality ladder has already been exhausted.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = drawToCanvas(bitmap, width, height);

      for (const quality of QUALITY_STEPS) {
        const blob = await encodeJpeg(canvas, quality);
        if (blob.size <= MAX_UPLOAD_BYTES) {
          return {
            file: new File([blob], renameToJpeg(file.name), { type: "image/jpeg" }),
            recompressed: true,
            originalBytes: file.size,
            uploadBytes: blob.size,
            width,
            height,
          };
        }
      }

      scale *= 0.5;
    }

    throw new UploadPrepareError(
      "This photo could not be reduced to a size that can be uploaded. Photograph the form again at a lower resolution.",
      "prepare_failed",
    );
  } finally {
    bitmap.close?.();
  }
}

/**
 * Decodes any format the browser itself understands.
 *
 * This is also the HEIC path, and it is why it is worth going through the
 * browser's decoder rather than shipping a transcoder: iOS photographs in HEIC
 * by default, Safari decodes HEIC natively, so an iPhone upload arrives here as
 * a bitmap and leaves as a JPEG with no library at all. A desktop browser that
 * cannot decode HEIC fails here instead, and says so in those words — which is
 * the honest answer, not a silent 422 from the server about a file the operator
 * never chose the format of.
 *
 * `imageOrientation: "from-image"` is load-bearing. Without it the EXIF tag is
 * ignored, and since a canvas re-encode strips EXIF, a portrait phone photo
 * would arrive at the server as landscape pixels with nothing left to say so.
 * Page detection would then look for a portrait A4 in a landscape image and
 * every downstream stage would degrade silently.
 */
async function decodeToBitmap(file: File): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new UploadPrepareError(
      "This browser cannot prepare photos for upload. Try Chrome, Safari or Firefox.",
      "unsupported_browser",
    );
  }

  try {
    return await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (/\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type)) {
      throw new UploadPrepareError(
        "This browser cannot read HEIC photos. On iPhone, set Settings > Camera > Formats to Most Compatible, or export the photo as JPEG.",
        "heic_unsupported",
      );
    }
    throw new UploadPrepareError(
      "This file is not an image the browser can read. Upload a JPG, PNG or WebP photo of the form.",
      "invalid_image",
    );
  }
}

function drawToCanvas(bitmap: ImageBitmap, width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new UploadPrepareError(
      "This browser could not process the photo. Try a different browser.",
      "canvas_unavailable",
    );
  }

  // A scan saved as a transparent PNG would otherwise composite onto black, and
  // every "is this near-white paper?" measurement on the server would invert.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);

  return canvas;
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new UploadPrepareError("The photo could not be encoded for upload.", "encode_failed"));
      },
      "image/jpeg",
      quality,
    );
  });
}

function renameToJpeg(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "form"}.jpg`;
}
