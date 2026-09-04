/**
 * Where saved scans live, decided by the server's configuration.
 *
 * `database` talks to this app's routes, which keep scans in Postgres and
 * photographs in Storage. `browser` keeps them in IndexedDB on this device.
 * The scan screen and the saved list use one interface and never know which.
 */

import { formById, recordTitle, type FormId } from "../forms/definitions.ts";
import { newReference } from "../scans/reference.ts";
import type { SavedScan, ScanDraft, ScanPatch } from "../scans/types.ts";
import { deleteLocalScan, getLocalScan, listLocalScans, putLocalScan } from "./local-scans.ts";

export type Persistence = "database" | "browser";

export interface ScanStore {
  readonly persistence: Persistence;
  list(form?: FormId): Promise<SavedScan[]>;
  get(id: string): Promise<SavedScan | null>;
  create(draft: ScanDraft): Promise<SavedScan>;
  update(id: string, patch: ScanPatch): Promise<SavedScan>;
  remove(id: string): Promise<void>;
}

export class StoreError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function scanStore(persistence: Persistence): ScanStore {
  return persistence === "database" ? remoteStore() : browserStore();
}

// ---------------------------------------------------------------------------

function remoteStore(): ScanStore {
  return {
    persistence: "database",
    async list(form) {
      const payload = await call(`/api/scans${form ? `?form=${form}` : ""}`);
      return (payload.scans as SavedScan[]) ?? [];
    },
    async get(id) {
      const response = await fetch(`/api/scans/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (response.status === 404) return null;
      const payload = await parse(response);
      return (payload.scan as SavedScan) ?? null;
    },
    async create(draft) {
      const payload = await call("/api/scans", { method: "POST", body: draft });
      return payload.scan as SavedScan;
    },
    async update(id, patch) {
      const payload = await call(`/api/scans/${encodeURIComponent(id)}`, { method: "PUT", body: patch });
      return payload.scan as SavedScan;
    },
    async remove(id) {
      const response = await fetch(`/api/scans/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) await parse(response);
    },
  };
}

async function call(url: string, init: { method?: string; body?: unknown } = {}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.body === undefined ? undefined : { "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch {
    throw new StoreError("The server could not be reached. Check your connection and try again.", "network_error");
  }
  return parse(response);
}

async function parse(response: Response): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    payload = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      (payload && typeof payload.error === "string" && payload.error) ||
      (response.status === 413 ? "The scan is too large to save." : "The scan could not be saved. Please try again.");
    const code = (payload && typeof payload.code === "string" && payload.code) || "service_error";
    throw new StoreError(message, code);
  }
  return payload ?? {};
}

// ---------------------------------------------------------------------------

function browserStore(): ScanStore {
  return {
    persistence: "browser",
    list: (form) => listLocalScans(form),
    get: (id) => getLocalScan(id),
    async create(draft) {
      const form = formById(draft.form);
      if (!form) throw new StoreError("That form does not exist.", "unknown_form");
      const now = new Date().toISOString();
      const scan: SavedScan = {
        id: crypto.randomUUID(),
        form: draft.form,
        reference: newReference(form.referencePrefix),
        title: recordTitle(form, draft.values),
        values: draft.values,
        photoUrl: draft.photo,
        createdAt: now,
        updatedAt: now,
      };
      await putLocalScan(scan);
      return scan;
    },
    async update(id, patch) {
      const existing = await getLocalScan(id);
      if (!existing) throw new StoreError("That scan no longer exists in this browser.", "not_found");
      const form = formById(existing.form);
      if (!form) throw new StoreError("That form does not exist.", "unknown_form");
      const scan: SavedScan = {
        ...existing,
        title: recordTitle(form, patch.values),
        values: patch.values,
        photoUrl: patch.photo === undefined ? existing.photoUrl : patch.photo,
        updatedAt: new Date().toISOString(),
      };
      await putLocalScan(scan);
      return scan;
    },
    remove: (id) => deleteLocalScan(id),
  };
}
