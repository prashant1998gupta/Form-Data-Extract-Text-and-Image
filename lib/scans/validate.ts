/**
 * What a browser sends when it saves a scan, checked before anything is
 * stored. Both the database route and the browser store call this, so the
 * two never disagree about what a valid scan is.
 */

import { formById, normaliseValues, type FormDefinition, type FormValues } from "../forms/definitions.ts";

export class ScanInputError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ScanInputError";
    this.code = code;
  }
}

/** A stored photograph is a print, not a poster. */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface DecodedPhoto {
  readonly bytes: Uint8Array;
  readonly contentType: "image/png" | "image/jpeg" | "image/webp";
  readonly extension: "png" | "jpg" | "webp";
}

/**
 * A data URL into bytes, typed by what the bytes actually are rather than by
 * what the URL claims: the declared MIME is attacker-controlled.
 */
export function decodePhotoDataUrl(dataUrl: unknown): DecodedPhoto {
  if (typeof dataUrl !== "string") throw new ScanInputError("The photograph must be an image.", "invalid_photo");
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new ScanInputError("The photograph must be a PNG, JPEG or WebP data URL.", "invalid_photo");

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
  } catch {
    throw new ScanInputError("The photograph could not be decoded.", "invalid_photo");
  }
  if (bytes.byteLength === 0) throw new ScanInputError("The photograph is empty.", "invalid_photo");
  if (bytes.byteLength > MAX_PHOTO_BYTES) {
    throw new ScanInputError("The photograph must be 5 MB or smaller.", "photo_too_large");
  }

  const sniffed = sniffImage(bytes);
  if (!sniffed) throw new ScanInputError("The photograph is not a PNG, JPEG or WebP image.", "invalid_photo");
  return { bytes, ...sniffed };
}

/** The format from the file's own header. */
export function sniffImage(bytes: Uint8Array): Pick<DecodedPhoto, "contentType" | "extension"> | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export interface ParsedScanBody {
  readonly form: FormDefinition;
  readonly values: FormValues;
  /** undefined: not mentioned. null: no photograph. Otherwise the decoded image. */
  readonly photo: DecodedPhoto | null | undefined;
}

/**
 * The JSON body of a save or an edit. `requireForm` is false for an edit,
 * whose form is already known from the stored row.
 */
export function parseScanBody(body: unknown, knownForm?: FormDefinition): ParsedScanBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ScanInputError("The request body must be a JSON object.", "invalid_body");
  }
  const record = body as Record<string, unknown>;

  const form = knownForm ?? formById(typeof record.form === "string" ? record.form : null);
  if (!form) throw new ScanInputError("Choose which form this scan is of.", "unknown_form");

  if (typeof record.values !== "object" || record.values === null || Array.isArray(record.values)) {
    throw new ScanInputError("The scan's values are missing.", "invalid_values");
  }
  const values = normaliseValues(form, record.values as Record<string, unknown>);

  let photo: DecodedPhoto | null | undefined;
  if (!("photo" in record) || record.photo === undefined) photo = undefined;
  else if (record.photo === null || record.photo === "") photo = null;
  else photo = decodePhotoDataUrl(record.photo);

  return { form, values, photo };
}
