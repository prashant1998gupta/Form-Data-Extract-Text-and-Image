/**
 * The bridge between encoded image files and the raw pixel buffers the rest of
 * `lib/vision/` works on. Backed by sharp (libvips).
 *
 * sharp does the two things that would be miserable to implement here — format
 * decoding and high-quality resampling of very large images — and nothing else.
 * All analysis happens on our own buffers, so it stays testable without a
 * native dependency and behaves identically whatever sharp version is installed.
 *
 * ORIENTATION IS THE HEADLINE. Every decode path in this file calls `.rotate()`
 * with no arguments, which applies the EXIF orientation tag and then strips it.
 * The sibling project (Card-to-Connect) has no orientation handling at all and
 * relies on the browser having baked rotation into a canvas; that works in the
 * browser and does not work here. A photo from an iPhone held in portrait
 * arrives as landscape pixels plus "rotate 90" in EXIF. Skip the rotate and the
 * page-detection stage looks for a portrait A4 in a landscape image, finds
 * nothing, and every downstream stage degrades to its cold-start path — silently,
 * with no error, on the single most common capture device our users own.
 */

import sharp from "sharp";

import { toGray } from "./gray.ts";
import { readImageHeader, type ImageFormat } from "./image-header.ts";
import { rgbFrom, type Gray, type Rgb } from "./types.ts";

/** Hard ceilings. Anything beyond these is a decode bomb or a mistake, not a form. */
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_INPUT_PIXELS = 60_000_000;
export const MIN_INPUT_EDGE = 320;

/**
 * The resolution analysis runs at.
 *
 * 2400px on the long edge of an A4 page is ~200 DPI, which is comfortably above
 * what handwriting stroke analysis needs (a ballpoint stroke is 3-5px at this
 * scale, so stroke-width statistics are meaningful) and well below the point
 * where a serverless function starts running out of time and memory.
 *
 * The delivered PHOTOGRAPH is re-sampled from the original capture rather than
 * from this working copy, when the original is finer — see `decodeFullRgb` and
 * the `PhotoSource` path in `lib/regions/postprocess.ts`, which composes the
 * crop-to-page and page-to-original homographies into one resample. Signature
 * and thumb are NOT: they are ink-on-transparency built from a mask measured in
 * the rectified page, and upsampling that mask would soften the very edges the
 * crop is made of.
 */
export const WORKING_EDGE = 2400;

export interface DecodedImage {
  /** Colour pixels at working resolution. */
  readonly rgb: Rgb;
  /** Luma at working resolution. The input to almost every detector. */
  readonly gray: Gray;
  /** Dimensions of the ORIGINAL image, after EXIF rotation, before downscaling. */
  readonly originalWidth: number;
  readonly originalHeight: number;
  /** working / original. Multiply a working-resolution coordinate by 1/scale to address the original. */
  readonly scale: number;
  readonly format: ImageFormat;
}

export interface DecodeOptions {
  readonly workingEdge?: number;
  readonly maxBytes?: number;
  readonly minEdge?: number;
}

/**
 * Note the plain field assignment rather than a TypeScript parameter property
 * (`constructor(message: string, readonly code: string)`). Node's strip-only
 * type stripping — which is how `npm test` and the fixture scripts run — cannot
 * compile parameter properties, because erasing the type would also erase the
 * assignment. Nothing in this repo may use them, nor enums or namespaces, for
 * the same reason.
 */
export class ImageDecodeError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ImageDecodeError";
    this.code = code;
  }
}

/**
 * Decodes to working resolution, applying EXIF orientation first.
 *
 * Order matters and is not interchangeable: rotate, then resize. Resizing first
 * would compute the fit against the pre-rotation aspect ratio and produce an
 * off-target size on every portrait photo.
 */
export async function decodeImage(bytes: Uint8Array, options: DecodeOptions = {}): Promise<DecodedImage> {
  const { workingEdge = WORKING_EDGE, maxBytes = MAX_INPUT_BYTES, minEdge = MIN_INPUT_EDGE } = options;

  if (bytes.length > maxBytes) {
    throw new ImageDecodeError(
      `This image is larger than ${Math.round(maxBytes / 1024 / 1024)} MB. Photograph the form again at a lower resolution.`,
      "image_too_large",
    );
  }

  // The header is checked before sharp is handed the bytes, so an unsupported
  // or hostile container never reaches the decoder.
  const header = readImageHeader(bytes);
  if (!header) {
    throw new ImageDecodeError("The file is not a JPG, PNG or WebP image. Upload a photo or scan of the form.", "invalid_image");
  }
  if (header.width * header.height > MAX_INPUT_PIXELS) {
    throw new ImageDecodeError(
      `This image is ${header.width}x${header.height}, which is too large to process. Use a smaller capture.`,
      "invalid_dimensions",
    );
  }

  const pipeline = sharp(Buffer.from(bytes), { limitInputPixels: MAX_INPUT_PIXELS, sequentialRead: true })
    // No argument: apply the EXIF orientation tag, then drop it. See the module note.
    .rotate();

  const metadata = await pipeline.metadata().catch(() => {
    throw new ImageDecodeError(
      "This image could not be read. It may be corrupt — try photographing the form again.",
      "decode_failed",
    );
  });

  // After .rotate(), width/height in metadata still describe the stored
  // orientation, so swap them ourselves for the quarter-turn tags. Getting this
  // wrong produces a scale factor that is right in one axis and wrong in the
  // other, which shears every reported coordinate.
  const turned = (metadata.orientation ?? 1) >= 5;
  const originalWidth = (turned ? metadata.height : metadata.width) ?? header.width;
  const originalHeight = (turned ? metadata.width : metadata.height) ?? header.height;

  if (Math.min(originalWidth, originalHeight) < minEdge) {
    throw new ImageDecodeError(
      `This image is only ${originalWidth}x${originalHeight}. Handwriting cannot be read reliably below ${minEdge} pixels on the short edge — photograph the form closer.`,
      "image_too_small",
    );
  }

  const longest = Math.max(originalWidth, originalHeight);
  const scale = longest > workingEdge ? workingEdge / longest : 1;
  const targetWidth = Math.max(1, Math.round(originalWidth * scale));
  const targetHeight = Math.max(1, Math.round(originalHeight * scale));

  const { data, info } = await pipeline
    .resize(targetWidth, targetHeight, { fit: "fill", kernel: "lanczos3" })
    // Flatten onto white: a transparent PNG scan would otherwise composite onto
    // black and every "is this near-white paper?" test would invert.
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgb = rgbFrom(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3);

  return {
    rgb,
    gray: toGray(rgb),
    originalWidth,
    originalHeight,
    scale: info.width / originalWidth,
    format: header.format,
  };
}

/**
 * Decodes the capture at its NATIVE resolution, EXIF orientation applied.
 *
 * The counterpart to `decodeImage`, which deliberately downscales: analysis
 * wants 2400 px because that is fast and sufficient, while the delivered
 * passport photograph wants every pixel the phone captured. Both come from the
 * same bytes and must agree about orientation, so the `.rotate()` here is the
 * same one and is not optional.
 *
 * Costs a second decode of the same JPEG — about 300 ms on a 12 MP capture, and
 * roughly 36 MB of RGB held while the crop is warped out of it. Call it only
 * when there is a crop to take, and only when `decodeImage` actually downscaled
 * something; on a capture already at or below the working edge this returns
 * pixels identical to ones already in hand.
 */
export async function decodeFullRgb(bytes: Uint8Array): Promise<Rgb> {
  const { data, info } = await sharp(Buffer.from(bytes), {
    limitInputPixels: MAX_INPUT_PIXELS,
    sequentialRead: true,
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return rgbFrom(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height, 3);
}

/** Encodes a working-resolution grayscale buffer to PNG. Debug and fixture output. */
export async function encodeGrayPng(image: Gray): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 1 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Encodes an RGB buffer to JPEG, optionally downscaled to a maximum long edge.
 *
 * For SCREEN PREVIEWS only — never for a delivered crop. The rectified A4 page
 * is 1654x2339, and as a lossless PNG inlined into a JSON response it is about
 * 8.7 MB of base64: slow to transfer, slow to parse, and entirely wasted on a
 * pane a few hundred pixels wide. At 1400 px and quality 82 the same image is
 * roughly a fortieth of that and visually identical at display size.
 *
 * Crops keep PNG. They are the artifact the hospital keeps, and JPEG's ringing
 * around high-contrast ink is exactly the wrong compromise for a signature.
 */
export async function encodeRgbJpeg(image: Rgb, maxEdge?: number, quality = 82): Promise<Buffer> {
  let pipeline = sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: image.channels },
  });
  if (maxEdge && Math.max(image.width, image.height) > maxEdge) {
    pipeline = pipeline.resize(maxEdge, maxEdge, { fit: "inside", kernel: "lanczos3" });
  }
  return pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
}

/**
 * Encodes the image at the top-left of a SQUARE canvas of `edge` pixels,
 * scaled so its long side fills the canvas, padded along the other side
 * with a flat grey.
 *
 * For the vision model, whose bounding boxes are asked for in thousandths of
 * the picture. On a portrait page the model was found to measure x in
 * thousandths of the HEIGHT — as if the picture had been letterboxed to a
 * square — so on a square canvas thousandths of width, thousandths of height
 * and pixels of a 1000-px copy all coincide, and its box means one thing.
 *
 * The picture is scaled UP as well as down. A small capture left at its own
 * size sat in the canvas's corner with padding on two sides, and the
 * model's box for it landed in the padding; with the picture spanning the
 * canvas's full height the boxes were right on every capture tried.
 */
export async function encodeRgbJpegSquare(
  image: Rgb,
  edge: number,
  quality = 82,
  background = { r: 118, g: 118, b: 118 },
): Promise<{ jpeg: Buffer; width: number; height: number; edge: number }> {
  const longest = Math.max(image.width, image.height);
  const scale = edge / longest;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const jpeg = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: image.channels },
  })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .extend({ top: 0, left: 0, right: edge - width, bottom: edge - height, background })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return { jpeg, width, height, edge };
}

/** Encodes a working-resolution RGB buffer to PNG. */
export async function encodeRgbPng(image: Rgb): Promise<Buffer> {
  return sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: image.channels },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Encodes an RGBA buffer to PNG, preserving transparency.
 *
 * Signature crops use this: the deliverable is ink on a transparent background,
 * so the hospital can place it on a letterhead or a discharge summary without a
 * white rectangle around it.
 */
export async function encodeRgbaPng(data: Uint8ClampedArray, width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
