import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { DatabaseUnavailable, listForms, saveForm } from "@/lib/db/forms";
import { TemplateError } from "@/lib/templates/custom";

export const runtime = "nodejs";

/**
 * The forms an organization has built.
 *
 * GET lists them; POST creates or updates one, publishing it if asked. Both
 * answer `configured: false` rather than 500 when no database is set up, so
 * the builder screen can say "connect a database" instead of showing an error
 * the person cannot act on.
 */
export async function GET(): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json({ configured: false, forms: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  try {
    const forms = await listForms();
    return Response.json(
      {
        configured: true,
        forms: forms.map((form) => ({
          id: form.id,
          name: form.name,
          slug: form.slug,
          status: form.status,
          updatedAt: form.updatedAt,
          recordCount: form.recordCount ?? 0,
          fieldCount: form.template.sections.flatMap((section) => section.fields).length,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json(
      { error: "No database is connected, so forms cannot be saved yet.", code: "database_unconfigured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That request could not be read.", code: "invalid_body" }, { status: 400 });
  }

  const source = (body ?? {}) as Record<string, unknown>;
  const name = typeof source.name === "string" ? source.name.trim() : "";
  if (!name) {
    return Response.json({ error: "Give the form a name.", code: "form_no_name" }, { status: 400 });
  }

  try {
    const form = await saveForm({
      id: typeof source.id === "string" ? source.id : undefined,
      name,
      template: source.template,
      publish: source.publish === true,
    });
    return Response.json(
      {
        form: { id: form.id, name: form.name, slug: form.slug, status: form.status, updatedAt: form.updatedAt },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

function fail(error: unknown): Response {
  if (error instanceof TemplateError) {
    return Response.json({ error: error.message, code: error.code }, { status: 400 });
  }
  if (error instanceof DatabaseUnavailable) {
    return Response.json({ error: error.message, code: "database_unconfigured" }, { status: 503 });
  }
  console.error("forms route failed", error);
  return Response.json({ error: "That could not be saved. Please try again.", code: "forms_failed" }, { status: 500 });
}
