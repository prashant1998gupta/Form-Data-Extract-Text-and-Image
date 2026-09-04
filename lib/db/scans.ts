import "server-only";

/**
 * Saved scans, the way CardLink saves contacts: one row per scan, the
 * photograph in Storage beside it.
 *
 * Every write here is reachable only from an explicit Save or Update on the
 * scan screen, after a person has looked at what the reader produced — the
 * model's raw output is never stored. The photograph is uploaded BEFORE the
 * row is written, so there is never a row pointing at a file that does not
 * exist; the reverse can leave an orphaned file, which is merely untidy.
 */

import { randomUUID } from "node:crypto";

import { formById, recordTitle, type FormId, type FormValues } from "../forms/definitions.ts";
import { newReference } from "../scans/reference.ts";
import type { SavedScan } from "../scans/types.ts";
import type { DecodedPhoto } from "../scans/validate.ts";
import { BUCKETS, db } from "./client.ts";

export class DatabaseUnavailable extends Error {
  constructor() {
    super("No database is configured on this server.");
    this.name = "DatabaseUnavailable";
  }
}

export interface StoredScan extends SavedScan {
  /** Storage path of the photograph, server-side only. */
  readonly photoPath: string | null;
}

const TABLE = "scans";
const SELECT = "id, form, reference, title, values, photo_path, created_at, updated_at";
const LIST_LIMIT = 500;

type Client = NonNullable<ReturnType<typeof db>>;

function client(): Client {
  const instance = db();
  if (!instance) throw new DatabaseUnavailable();
  return instance;
}

export async function listScans(form?: FormId): Promise<StoredScan[]> {
  let query = client().from(TABLE).select(SELECT).order("created_at", { ascending: false }).limit(LIST_LIMIT);
  if (form) query = query.eq("form", form);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map(toScan);
}

export async function scanById(id: string): Promise<StoredScan | null> {
  const { data, error } = await client().from(TABLE).select(SELECT).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toScan(data) : null;
}

export interface InsertScanInput {
  readonly form: FormId;
  readonly values: FormValues;
  readonly photo: DecodedPhoto | null;
}

export async function insertScan(input: InsertScanInput): Promise<StoredScan> {
  const supabase = client();
  const form = formById(input.form);
  if (!form) throw new Error(`unknown form ${input.form}`);

  // The id is minted here so the photograph's path is known before the row
  // exists, and the two can never disagree.
  const id = randomUUID();
  const photoPath = input.photo ? await uploadPhoto(supabase, id, input.photo) : null;

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      id,
      form: input.form,
      reference: newReference(form.referencePrefix),
      title: recordTitle(form, input.values),
      values: input.values,
      photo_path: photoPath,
    })
    .select(SELECT)
    .single();
  if (error) throw new Error(error.message);
  return toScan(data);
}

export interface UpdateScanInput {
  readonly values: FormValues;
  /** undefined leaves the photograph alone; null removes it; a photo replaces it. */
  readonly photo?: DecodedPhoto | null;
}

export async function updateScan(id: string, input: UpdateScanInput): Promise<StoredScan | null> {
  const supabase = client();
  const existing = await scanById(id);
  if (!existing) return null;
  const form = formById(existing.form);
  if (!form) throw new Error(`unknown form ${existing.form}`);

  let photoPath = existing.photoPath;
  if (input.photo === null && existing.photoPath) {
    await removePhoto(supabase, existing.photoPath);
    photoPath = null;
  } else if (input.photo) {
    // A new file rather than an overwrite: the old path may be cached by a
    // browser under the URL it was served from.
    const next = await uploadPhoto(supabase, id, input.photo);
    if (existing.photoPath && existing.photoPath !== next) await removePhoto(supabase, existing.photoPath);
    photoPath = next;
  }

  const { data, error } = await supabase
    .from(TABLE)
    .update({ title: recordTitle(form, input.values), values: input.values, photo_path: photoPath })
    .eq("id", id)
    .select(SELECT)
    .single();
  if (error) throw new Error(error.message);
  return toScan(data);
}

export async function deleteScan(id: string): Promise<boolean> {
  const supabase = client();
  const existing = await scanById(id);
  if (!existing) return false;
  if (existing.photoPath) await removePhoto(supabase, existing.photoPath);
  const { error } = await supabase.from(TABLE).delete().eq("id", id);
  if (error) throw new Error(error.message);
  return true;
}

export interface StoredPhoto {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}

export async function scanPhoto(id: string): Promise<StoredPhoto | null> {
  const supabase = client();
  const existing = await scanById(id);
  if (!existing?.photoPath) return null;
  const { data, error } = await supabase.storage.from(BUCKETS.crops).download(existing.photoPath);
  if (error || !data) return null;
  return { bytes: await data.arrayBuffer(), contentType: contentTypeOf(existing.photoPath) };
}

// ---------------------------------------------------------------------------

async function uploadPhoto(supabase: Client, id: string, photo: DecodedPhoto): Promise<string> {
  const path = `scans/${id}/photo-${Date.now()}.${photo.extension}`;
  const { error } = await supabase.storage
    .from(BUCKETS.crops)
    .upload(path, photo.bytes, { contentType: photo.contentType, upsert: false });
  if (error) throw new Error(`Could not store the photograph: ${error.message}`);
  return path;
}

async function removePhoto(supabase: Client, path: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKETS.crops).remove([path]);
  // A photograph that could not be removed is an orphaned file, not a broken
  // record; log it and carry on.
  if (error) console.warn(`could not remove ${path}: ${error.message}`);
}

function contentTypeOf(path: string): string {
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function toScan(row: Record<string, unknown>): StoredScan {
  const id = String(row.id);
  const updatedAt = String(row.updated_at);
  const photoPath = (row.photo_path as string | null) ?? null;
  const values =
    typeof row.values === "object" && row.values !== null && !Array.isArray(row.values)
      ? (row.values as Record<string, string>)
      : {};
  return {
    id,
    form: row.form as FormId,
    reference: String(row.reference),
    title: String(row.title ?? ""),
    values,
    // Streamed through the app, never a storage URL: no bearer token for a
    // person's photograph leaves the server. The version suffix defeats a
    // browser cache after the photograph is replaced.
    photoUrl: photoPath ? `/api/scans/${id}/photo?v=${encodeURIComponent(updatedAt)}` : null,
    photoPath,
    createdAt: String(row.created_at),
    updatedAt,
  };
}

/** The wire shape: everything a browser may see. */
export function publicScan(scan: StoredScan): SavedScan {
  const { photoPath: _photoPath, ...rest } = scan;
  return rest;
}
