/**
 * A saved scan, as both halves of the app see it.
 *
 * The server stores the photograph in Storage and hands the browser a URL to
 * it; the browser-only store keeps the photograph as a data URL. Either way a
 * saved scan carries `photoUrl`, and nothing that renders one needs to know
 * which kind of store it came from.
 */

import type { FormId, FormValues } from "../forms/definitions.ts";

export interface SavedScan {
  readonly id: string;
  readonly form: FormId;
  /** Human-facing id, e.g. SCH-4F2A19. */
  readonly reference: string;
  /** The value of the form's title field at save time, for listing and search. */
  readonly title: string;
  readonly values: FormValues;
  readonly photoUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the scan screen hands to a store. `photo` is a PNG or JPEG data URL. */
export interface ScanDraft {
  readonly form: FormId;
  readonly values: FormValues;
  readonly photo: string | null;
}

/**
 * An edit. `photo` undefined leaves the stored photograph alone; null removes
 * it; a data URL replaces it.
 */
export interface ScanPatch {
  readonly values: FormValues;
  readonly photo?: string | null;
}
