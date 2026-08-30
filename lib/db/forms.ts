import "server-only";

/**
 * Forms: created, published to a link, and read back by that link.
 *
 * A stored form is the same `FormTemplate` the extraction pipeline already
 * speaks — parsed on the way in through the same trust boundary a taught
 * template crosses (`lib/templates/custom.ts`), never cast. The database is a
 * new door into the extractor, so it gets the same lock as the old one.
 */

import { parseStoredTemplate, TemplateError } from "../templates/custom.ts";
import type { FormTemplate } from "../templates/types.ts";
import { db } from "./client.ts";

export interface StoredForm {
  readonly id: string;
  readonly name: string;
  /** The public link's path segment. */
  readonly slug: string;
  readonly status: "draft" | "published" | "archived";
  readonly template: FormTemplate;
  readonly updatedAt: string;
  readonly recordCount?: number;
}

export class DatabaseUnavailable extends Error {
  constructor() {
    super("No database is configured, so forms cannot be saved or published.");
    this.name = "DatabaseUnavailable";
  }
}

/**
 * A URL-safe slug from a form's name, with a short random suffix.
 *
 * The suffix is not decoration: two hospitals both calling their form "New
 * Patient Registration" must not collide, and a slug that changes when the
 * name is edited would break every link already handed out. So the slug is
 * assigned once, at creation, and never derived again.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base || "form"}-${suffix}`;
}

export async function listForms(): Promise<StoredForm[]> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  const { data, error } = await client
    .from("forms")
    .select("id, name, slug, status, template, updated_at, records(count)")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);

  return (data ?? []).flatMap((row) => {
    const form = toStoredForm(row);
    return form ? [form] : [];
  });
}

export async function formBySlug(slug: string): Promise<StoredForm | null> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  const { data, error } = await client
    .from("forms")
    .select("id, name, slug, status, template, updated_at")
    .eq("slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toStoredForm(data) : null;
}

export async function formById(id: string): Promise<StoredForm | null> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  const { data, error } = await client
    .from("forms")
    .select("id, name, slug, status, template, updated_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toStoredForm(data) : null;
}

export interface SaveFormInput {
  /** Present when updating an existing form. */
  readonly id?: string;
  readonly name: string;
  /** The template, in the wire shape `parseStoredTemplate` validates. */
  readonly template: unknown;
  readonly publish: boolean;
}

export async function saveForm(input: SaveFormInput): Promise<StoredForm> {
  const client = db();
  if (!client) throw new DatabaseUnavailable();

  // Parsed BEFORE it is stored, so a malformed template can never sit in the
  // database waiting to be handed to the extractor by a later request. What is
  // STORED is the wire shape the builder sent, not the parsed result: the row
  // then round-trips through exactly the parser that validated it, and there is
  // no second shape for a future change to have to keep in sync.
  const template = parseStoredTemplate(input.template, input.name);
  const wire = input.template as Record<string, unknown>;
  const status = input.publish ? "published" : "draft";

  if (input.id) {
    const { data, error } = await client
      .from("forms")
      .update({ name: input.name, template: wire, status })
      .eq("id", input.id)
      .select("id, name, slug, status, template, updated_at")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new TemplateError("That form no longer exists.", "form_not_found");
    const stored = toStoredForm(data);
    if (!stored) throw new TemplateError("That form could not be read back.", "form_unreadable");
    return stored;
  }

  const { data, error } = await client
    .from("forms")
    .insert({ name: input.name, slug: slugify(input.name), template: wire, status, page_size: template.page.widthMM === 210 ? "A4" : "custom" })
    .select("id, name, slug, status, template, updated_at")
    .single();
  if (error) throw new Error(error.message);
  const stored = toStoredForm(data);
  if (!stored) throw new TemplateError("That form could not be read back.", "form_unreadable");
  return stored;
}

/**
 * A database row, validated into a `StoredForm`.
 *
 * Returns null rather than throwing when the stored template cannot be
 * parsed: one corrupt row must not take out the whole form list, and the list
 * simply omits what it cannot vouch for.
 */
function toStoredForm(row: Record<string, unknown>): StoredForm | null {
  const id = typeof row.id === "string" ? row.id : null;
  const name = typeof row.name === "string" ? row.name : null;
  const slug = typeof row.slug === "string" ? row.slug : null;
  const status = row.status === "published" || row.status === "archived" ? row.status : "draft";
  if (!id || !name || !slug) return null;

  let template: FormTemplate;
  try {
    template = parseStoredTemplate(row.template, name);
  } catch {
    return null;
  }

  const counts = row.records;
  const recordCount =
    Array.isArray(counts) && counts.length > 0 && typeof (counts[0] as { count?: unknown }).count === "number"
      ? ((counts[0] as { count: number }).count)
      : undefined;

  return {
    id,
    name,
    slug,
    status,
    template,
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : new Date(0).toISOString(),
    recordCount,
  };
}
