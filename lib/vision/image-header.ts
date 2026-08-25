/**
 * Magic-byte image identification.
 *
 * The MIME type in a `data:` URL and the `Content-Type` on an upload are both
 * supplied by the caller, which means both are attacker-controlled. Trusting
 * either one is how a decoder gets handed a file it was not expecting. This
 * reads the format out of the file's own header instead, and the decode path
 * refuses anything it does not recognise here — before the bytes reach sharp.
 *
 * Dimensions come from the header too, so an oversized image can be rejected
 * without allocating it. A 64000x64000 PNG is a 12-byte header and a few KB of
 * compressed data; decoding it first would be a 12 GB allocation.
 *
 * Zero dependencies, and every branch has a test. Ported in spirit from the
 * sibling project's `lib/business-card/image-header.ts`, which exists for the
 * same reason.
 */

export type ImageFormat = "jpeg" | "png" | "webp";

export interface ImageHeader {
  readonly format: ImageFormat;
  readonly width: number;
  readonly height: number;
}

/**
 * Returns the real format and pixel dimensions, or null if the bytes are not a
 * supported image. Never throws — a malformed header is an expected input here,
 * not an exceptional one.
 */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  return readPng(bytes) ?? readJpeg(bytes) ?? readWebp(bytes);
}

function readPng(bytes: Uint8Array): ImageHeader | null {
  // 89 50 4E 47 0D 0A 1A 0A, then an IHDR chunk whose payload starts at 16.
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) if (bytes[i] !== signature[i]) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  if (width <= 0 || height <= 0) return null;
  return { format: "png", width, height };
}

function readJpeg(bytes: Uint8Array): ImageHeader | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 3 < bytes.length) {
    // Markers may be preceded by any number of 0xFF fill bytes.
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    let marker = bytes[offset + 1]!;
    let markerStart = offset + 1;
    while (marker === 0xff && markerStart + 1 < bytes.length) {
      markerStart += 1;
      marker = bytes[markerStart]!;
    }

    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerStart + 1;
      continue;
    }
    // Start of scan — past this point is entropy-coded data, no more headers.
    if (marker === 0xda || marker === 0xd9) return null;

    const lengthAt = markerStart + 1;
    if (lengthAt + 1 >= bytes.length) return null;
    const length = (bytes[lengthAt]! << 8) | bytes[lengthAt + 1]!;
    if (length < 2) return null;

    // Any SOFn except the DHT/DAC/DNL markers that share the 0xC0-0xCF range.
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      // SOF payload: precision(1), height(2), width(2)
      if (lengthAt + 6 >= bytes.length) return null;
      const height = (bytes[lengthAt + 3]! << 8) | bytes[lengthAt + 4]!;
      const width = (bytes[lengthAt + 5]! << 8) | bytes[lengthAt + 6]!;
      if (width <= 0 || height <= 0) return null;
      return { format: "jpeg", width, height };
    }
    offset = lengthAt + length;
  }
  return null;
}

function readWebp(bytes: Uint8Array): ImageHeader | null {
  // "RIFF" .... "WEBP" then a VP8 / VP8L / VP8X chunk.
  if (bytes.length < 30) return null;
  if (!matchAscii(bytes, 0, "RIFF") || !matchAscii(bytes, 8, "WEBP")) return null;

  if (matchAscii(bytes, 12, "VP8 ")) {
    // Lossy: a 3-byte frame tag, the 3-byte start code 0x9D012A, then 14-bit dims.
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = ((bytes[27]! << 8) | bytes[26]!) & 0x3fff;
    const height = ((bytes[29]! << 8) | bytes[28]!) & 0x3fff;
    if (width <= 0 || height <= 0) return null;
    return { format: "webp", width, height };
  }

  if (matchAscii(bytes, 12, "VP8L")) {
    // Lossless: signature byte 0x2F, then 14 bits width-1 and 14 bits height-1.
    if (bytes[20] !== 0x2f) return null;
    const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: "webp", width, height };
  }

  if (matchAscii(bytes, 12, "VP8X")) {
    // Extended: 24-bit little-endian canvas width-1 and height-1 at offset 24.
    const width = (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1;
    const height = (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1;
    return { format: "webp", width, height };
  }

  return null;
}

function matchAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

const dataUrlPattern = /^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=\r\n]+)$/;

/**
 * Decodes a base64 data URL to bytes, rejecting anything whose real header does
 * not agree that it is a supported image.
 *
 * The declared MIME is only used to reject obviously-wrong input early; the
 * authoritative answer is always the header. A PNG announced as `image/jpeg` is
 * accepted and reported as PNG, because the bytes are what the decoder will
 * act on and lying about the container is not itself an attack.
 */
export function decodeImageDataUrl(dataUrl: string, maxBytes = 15 * 1024 * 1024): {
  bytes: Uint8Array;
  header: ImageHeader;
} {
  const match = dataUrlPattern.exec(dataUrl);
  if (!match) throw new Error("Not a supported base64 image data URL.");
  const base64 = match[1]!;
  // Bound before decoding: base64 is 4 characters per 3 bytes.
  if ((base64.length * 3) / 4 > maxBytes) {
    throw new Error(`Image exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`);
  }
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  const header = readImageHeader(bytes);
  if (!header) throw new Error("The uploaded file is not a valid JPG, PNG or WebP image.");
  return { bytes, header };
}
