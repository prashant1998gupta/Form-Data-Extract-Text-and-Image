import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { DatabaseUnavailable, deleteScan, publicScan, scanById, updateScan } from "@/lib/db/scans";
import { formById } from "@/lib/forms/definitions";
import { parseScanBody, ScanInputError } from "@/lib/scans/validate";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<Response> {
  if (!isDatabaseConfigured()) return unconfigured();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  try {
    const scan = await scanById(id);
    return scan ? Response.json({ scan: publicScan(scan) }, { headers: NO_STORE }) : notFound();
  } catch (error) {
    return serverError(error);
  }
}

/** Edit a saved scan: new values, and optionally a new or removed photograph. */
export async function PUT(request: Request, { params }: Params): Promise<Response> {
  if (!isDatabaseConfigured()) return unconfigured();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json", "The request body is not valid JSON.");
  }
  try {
    const existing = await scanById(id);
    if (!existing) return notFound();
    const form = formById(existing.form);
    if (!form) return fail(500, "unknown_form", "This scan's form is no longer defined.");
    const parsed = parseScanBody(body, form);
    const scan = await updateScan(id, { values: parsed.values, photo: parsed.photo });
    return scan ? Response.json({ scan: publicScan(scan) }, { headers: NO_STORE }) : notFound();
  } catch (error) {
    if (error instanceof ScanInputError) return fail(400, error.code, error.message);
    return serverError(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  if (!isDatabaseConfigured()) return unconfigured();
  const { id } = await params;
  if (!UUID.test(id)) return notFound();
  try {
    const removed = await deleteScan(id);
    return removed ? new Response(null, { status: 204, headers: NO_STORE }) : notFound();
  } catch (error) {
    return serverError(error);
  }
}

function unconfigured(): Response {
  return fail(503, "database_unconfigured", "No database is connected on this server.");
}

function notFound(): Response {
  return fail(404, "not_found", "That scan does not exist.");
}

function serverError(error: unknown): Response {
  if (error instanceof DatabaseUnavailable) return unconfigured();
  console.error("scan route failed", error);
  return fail(500, "scan_failed", "The scan could not be updated. Please try again.");
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: NO_STORE });
}
