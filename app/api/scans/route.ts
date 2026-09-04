import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { DatabaseUnavailable, insertScan, listScans, publicScan } from "@/lib/db/scans";
import { isFormId } from "@/lib/forms/definitions";
import { parseScanBody, ScanInputError } from "@/lib/scans/validate";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

/** The saved scans, newest first, optionally one form's. */
export async function GET(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) return unconfigured();
  const form = new URL(request.url).searchParams.get("form");
  if (form && !isFormId(form)) return fail(400, "unknown_form", "That form does not exist.");
  try {
    const scans = await listScans(form && isFormId(form) ? form : undefined);
    return Response.json({ scans: scans.map(publicScan) }, { headers: NO_STORE });
  } catch (error) {
    return serverError(error);
  }
}

/** Save. Reachable only from the scan screen's Save button, after review. */
export async function POST(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) return unconfigured();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "invalid_json", "The request body is not valid JSON.");
  }
  try {
    const parsed = parseScanBody(body);
    const scan = await insertScan({ form: parsed.form.id, values: parsed.values, photo: parsed.photo ?? null });
    return Response.json({ scan: publicScan(scan) }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof ScanInputError) return fail(400, error.code, error.message);
    return serverError(error);
  }
}

function unconfigured(): Response {
  return fail(503, "database_unconfigured", "No database is connected, so scans cannot be saved on this server.");
}

function serverError(error: unknown): Response {
  if (error instanceof DatabaseUnavailable) return unconfigured();
  console.error("scans route failed", error);
  return fail(500, "scan_failed", "The scan could not be saved. Please try again.");
}

function fail(status: number, code: string, error: string): Response {
  return Response.json({ error, code }, { status, headers: NO_STORE });
}
