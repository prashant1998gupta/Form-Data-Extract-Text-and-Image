/**
 * The browser's side of a scan: prepare the photo, post it with the form's
 * id, and turn the reply — or the refusal — into something the screen can
 * show. Mirrors CardLink's extraction service, one image instead of two.
 */

import type { FormId, FormValues } from "../forms/definitions.ts";
import { prepareUpload, UploadPrepareError } from "./prepare-upload.ts";

export type ScanStage = "preparing" | "reading" | "finishing" | "";

export interface ExtractedPhoto {
  readonly found: boolean;
  /** PNG data URL when found. */
  readonly dataUrl: string | null;
  readonly confidence?: number;
  readonly needsReview?: boolean;
  readonly detail: string;
}

export interface ExtractedForm {
  readonly form: FormId;
  readonly readable: boolean;
  readonly values: FormValues;
  readonly unreadable: readonly string[];
  readonly notInOptions: readonly string[];
  readonly filled: number;
  readonly photo: ExtractedPhoto;
  readonly reader: { readonly provider: string; readonly model: string; readonly ms: number };
}

export class ExtractError extends Error {
  readonly code: string;
  /** Worth another press of the button, as opposed to a different photo. */
  readonly retryable: boolean;

  constructor(message: string, code: string, retryable = false) {
    super(message);
    this.name = "ExtractError";
    this.code = code;
    this.retryable = retryable;
  }
}

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", ""]);
const MAX_FILE_BYTES = 30 * 1024 * 1024;

export function validateFormFile(file: File): void {
  if (!ACCEPTED_TYPES.has(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
    throw new ExtractError("Please choose a JPG, PNG or WebP photo of the form.", "invalid_type");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ExtractError("The photo must be 30 MB or smaller.", "file_too_large");
  }
}

export async function extractForm(
  file: File,
  form: FormId,
  onStage: (stage: ScanStage) => void,
): Promise<ExtractedForm> {
  onStage("preparing");
  let prepared;
  try {
    prepared = await prepareUpload(file);
  } catch (error) {
    if (error instanceof UploadPrepareError) throw new ExtractError(error.message, error.code);
    throw new ExtractError("The photo could not be prepared for upload.", "prepare_failed");
  }

  const body = new FormData();
  body.append("form", form);
  body.append("image", prepared.file, prepared.file.name);

  onStage("reading");
  let response: Response;
  try {
    response = await fetch("/api/extract", { method: "POST", body });
  } catch {
    throw new ExtractError("The scanner could not be reached. Check your connection and try again.", "network_error", true);
  }

  const payload = await readJson(response);
  if (!response.ok) {
    const code = (payload && typeof payload.code === "string" && payload.code) || "service_error";
    const message = (payload && typeof payload.error === "string" && payload.error) || statusMessage(response.status);
    throw new ExtractError(message, code, response.status === 429 || response.status >= 500);
  }

  onStage("finishing");
  if (!payload || typeof payload.values !== "object" || payload.values === null) {
    throw new ExtractError("The scanner returned an incomplete reply. Please try again.", "invalid_response", true);
  }
  return payload as unknown as ExtractedForm;
}

/**
 * Reads a JSON body without assuming there is one. A request refused at the
 * platform edge — too large, a gateway timeout — answers in plain text.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function statusMessage(status: number): string {
  if (status === 413) return "That photo was too large to upload. Photograph the form again at a lower resolution.";
  if (status === 504 || status === 408) return "The scan took too long. Try again with the whole page in frame.";
  if (status >= 500) return "The server could not process the form. Please try again in a moment.";
  return "The form could not be scanned.";
}
