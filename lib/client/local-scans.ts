/**
 * Saved scans in this browser, for a deployment with no database.
 *
 * IndexedDB rather than localStorage because a scan carries a photograph:
 * a few hundred kilobytes each, and localStorage's whole budget is five
 * megabytes. Everything stays on the device — nothing here talks to a server.
 */

import type { FormId } from "../forms/definitions.ts";
import type { SavedScan } from "../scans/types.ts";

const DATABASE = "formlink";
const STORE = "scans";
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser cannot store scans."));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The browser's scan store could not be opened."));
  });
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The browser's scan store failed."));
  });
}

export async function listLocalScans(form?: FormId): Promise<SavedScan[]> {
  const db = await open();
  try {
    const all = await settle(db.transaction(STORE, "readonly").objectStore(STORE).getAll());
    return (all as SavedScan[])
      .filter((scan) => !form || scan.form === form)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  } finally {
    db.close();
  }
}

export async function getLocalScan(id: string): Promise<SavedScan | null> {
  const db = await open();
  try {
    const scan = await settle(db.transaction(STORE, "readonly").objectStore(STORE).get(id));
    return (scan as SavedScan | undefined) ?? null;
  } finally {
    db.close();
  }
}

export async function putLocalScan(scan: SavedScan): Promise<void> {
  const db = await open();
  try {
    await settle(db.transaction(STORE, "readwrite").objectStore(STORE).put(scan));
  } finally {
    db.close();
  }
}

export async function deleteLocalScan(id: string): Promise<void> {
  const db = await open();
  try {
    await settle(db.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
  } finally {
    db.close();
  }
}
