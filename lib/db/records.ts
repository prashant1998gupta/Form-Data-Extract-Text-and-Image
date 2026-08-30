import "server-only";

/**
 * Records: a verified scan, made permanent.
 *
 * THE PRODUCT RULE THIS MODULE IS. "No record is written without an explicit
 * human Save" has been trivially satisfied until now because nothing was
 * written at all. This is where it stops being trivial and starts being a
 * design: there is exactly one function that writes a record, it is reachable
 * only from the Save button's route, and it stores WHAT THE HUMAN CONFIRMED —
 * never the reader's raw output. A value the operator retyped is stored as
 * theirs; a value they accepted unchanged is stored as accepted. That
 * distinction is the whole audit trail, and it costs one field.
 *
 * THE ORIGINAL IS ARCHIVED HERE. The spec's Must item — "the original image is
 * stored permanently and unmodified with the record" — is satisfied by
 * uploading the exact bytes the browser sent to the `captures` bucket before
 * the row is written. (The client still resizes captures over 4 MB to get
 * past the platform's edge limit; what is archived is the bytes that reached
 * the server, and the README says so rather than overclaiming.)
 */

import { BUCKETS, db } from "./client.ts";
import { DatabaseUnavailable } from "./forms.ts";

/** How a stored value came to be what it is. The audit trail, in one word. */
export type ValueSource = "read" | "corrected" | "typed" | "blank";

export interface RecordValue {
  readonly key: string;
  readonly label: string;
  readonly type: string;
  readonly value: string;
  readonly source: ValueSource;
}

export interface SavedRecord {
  readonly id: string;
  readonly formId: string;
  readonly formName?: string;
  readonly reference: string;
  readonly values: readonly RecordValue[];
  readonly photoPath: string | null;
  readonly signaturePath: string | null;
  readonly thumbPath: string | null;
  readonly originalPath: string | null;
  readonly extraction: Record<string, unknown>;
  readonly createdAt: string;
}

export interface SaveRecordInput {
  readonly formId: string;
  readonly values: readonly RecordValue[];
  readonly extraction: Record<string, unknown>;
  /** The exact bytes the server received, archived unmodified. */
  readonly original?: { readonly bytes: Uint8Array; readonly contentType: string };
  readonly crops?: {
    readonly photo?: Uint8Array;
    readonly signature?: Uint8Array;
    readonly thumb?: Uint8Array;
  };
  readonly savedBy?: string;
}

/**
 * A human-facing reference, e.g. `HSP-4F2A19`.
 *
 * Random rather than sequential on purpose: a sequential id printed on a
 * patient receipt tells a stranger how many patients the hospital has seen
 * this week, and lets anyone guess the neighbouring record's number.
 */
function newReference(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // no I/L/O/U — misread on paper
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `HSP-${suffix}`;
}

export async function saveRecord(input: SaveRecordInput): Promise<SavedRecord> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  const reference = newReference();
  const stamp = `${new Date().toISOString().slice(0, 10)}/${reference}`;

  // Evidence first, row second. If an upload fails the record is not written,
  // so there is never a row claiming a crop that does not exist — the reverse
  // order can leave an orphaned image, which is merely untidy, but a record
  // pointing at nothing is a record that lies about its own evidence.
  const originalPath = input.original
    ? await upload(client, BUCKETS.captures, `${stamp}/original.jpg`, input.original.bytes, input.original.contentType)
    : null;
  const photoPath = input.crops?.photo
    ? await upload(client, BUCKETS.crops, `${stamp}/photo.png`, input.crops.photo, "image/png")
    : null;
  const signaturePath = input.crops?.signature
    ? await upload(client, BUCKETS.crops, `${stamp}/signature.png`, input.crops.signature, "image/png")
    : null;
  const thumbPath = input.crops?.thumb
    ? await upload(client, BUCKETS.crops, `${stamp}/thumb.png`, input.crops.thumb, "image/png")
    : null;

  const { data, error } = await client
    .from("records")
    .insert({
      form_id: input.formId,
      reference,
      values: input.values,
      photo_path: photoPath,
      signature_path: signaturePath,
      thumb_path: thumbPath,
      original_path: originalPath,
      extraction: input.extraction,
      saved_by: input.savedBy ?? null,
    })
    .select("id, form_id, reference, values, photo_path, signature_path, thumb_path, original_path, extraction, created_at")
    .single();
  if (error) throw new Error(error.message);
  return toRecord(data);
}

export async function recordByReference(reference: string): Promise<SavedRecord | null> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  const { data, error } = await client
    .from("records")
    .select(
      "id, form_id, reference, values, photo_path, signature_path, thumb_path, original_path, extraction, created_at, forms(name)",
    )
    .eq("reference", reference.toUpperCase())
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toRecord(data) : null;
}

export async function listRecords(formId?: string): Promise<SavedRecord[]> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  let query = client
    .from("records")
    .select(
      "id, form_id, reference, values, photo_path, signature_path, thumb_path, original_path, extraction, created_at, forms(name)",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (formId) query = query.eq("form_id", formId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toRecord);
}

/**
 * A short-lived signed URL for a stored image.
 *
 * The buckets are private — a photograph of a patient's face is not something
 * to serve from a guessable public path — so every view mints a URL that
 * expires. One hour is long enough to read a record and short enough that a
 * copied link is not a permanent leak.
 */
export async function signedUrl(bucket: string, path: string | null, seconds = 3600): Promise<string | null> {
  if (!path) return null;
  const client = db();
  if (!client) return null;
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, seconds);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export async function recordImageUrls(record: SavedRecord) {
  const [photo, signature, thumb, original] = await Promise.all([
    signedUrl(BUCKETS.crops, record.photoPath),
    signedUrl(BUCKETS.crops, record.signaturePath),
    signedUrl(BUCKETS.crops, record.thumbPath),
    signedUrl(BUCKETS.captures, record.originalPath),
  ]);
  return { photo, signature, thumb, original };
}

async function upload(
  client: NonNullable<ReturnType<typeof db>>,
  bucket: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string> {
  const { error } = await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
  if (error) throw new Error(`Could not archive ${path}: ${error.message}`);
  return path;
}

function toRecord(row: Record<string, unknown>): SavedRecord {
  const form = row.forms;
  const formName =
    typeof form === "object" && form !== null && typeof (form as { name?: unknown }).name === "string"
      ? ((form as { name: string }).name)
      : undefined;

  return {
    id: String(row.id),
    formId: String(row.form_id),
    formName,
    reference: String(row.reference),
    values: Array.isArray(row.values) ? (row.values as RecordValue[]) : [],
    photoPath: (row.photo_path as string | null) ?? null,
    signaturePath: (row.signature_path as string | null) ?? null,
    thumbPath: (row.thumb_path as string | null) ?? null,
    originalPath: (row.original_path as string | null) ?? null,
    extraction: (row.extraction as Record<string, unknown>) ?? {},
    createdAt: String(row.created_at),
  };
}
