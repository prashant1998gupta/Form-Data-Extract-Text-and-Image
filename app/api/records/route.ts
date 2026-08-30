import "server-only";

import { isDatabaseConfigured } from "@/lib/db/client";
import { DatabaseUnavailable } from "@/lib/db/forms";
import { formById } from "@/lib/db/forms";
import { listRecords, saveRecord, type RecordValue, type ValueSource } from "@/lib/db/records";

export const runtime = "nodejs";
/** A save uploads up to four images before the row is written. */
export const maxDuration = 60;

/**
 * THE SAVE. The one place in this application that writes a patient record.
 *
 * It is a POST with a body the VERIFY SCREEN built — the values as the human
 * left them, each tagged with whether they accepted the reader's transcription
 * or replaced it. Nothing here re-reads, re-crops or re-decides anything: by
 * the time this route runs, every judgement has been made by a person looking
 * at the evidence. That is what "no record is written without an explicit
 * human Save" means in code rather than in a README.
 *
 * Multipart, not JSON, because the crops and the original capture come with
 * it: base64 in a JSON body inflates by a third, and the original is the
 * largest thing in the request precisely because it is the thing being
 * archived unmodified.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json(
      { error: "No database is connected, so records cannot be saved yet.", code: "database_unconfigured" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "That save could not be read.", code: "invalid_body" }, { status: 400 });
  }

  const formId = String(form.get("formId") ?? "");
  if (!formId) {
    return Response.json({ error: "That save named no form.", code: "record_no_form" }, { status: 400 });
  }

  // The form must exist and be one this deployment knows: a record pointing at
  // an unknown form is a record nobody can ever read back correctly.
  let stored;
  try {
    stored = await formById(formId);
  } catch (error) {
    return fail(error);
  }
  if (!stored) {
    return Response.json({ error: "That form no longer exists.", code: "form_not_found" }, { status: 404 });
  }

  const values = parseValues(form.get("values"), stored);
  if (values === null) {
    return Response.json({ error: "The values could not be read.", code: "record_bad_values" }, { status: 400 });
  }

  const extraction = parseJsonObject(form.get("extraction"));

  try {
    const record = await saveRecord({
      formId,
      values,
      extraction,
      original: await filePart(form.get("original")),
      crops: {
        photo: await bytesPart(form.get("photo")),
        signature: await bytesPart(form.get("signature")),
        thumb: await bytesPart(form.get("thumb")),
      },
      savedBy: typeof form.get("savedBy") === "string" ? String(form.get("savedBy")) : undefined,
    });

    return Response.json(
      { record: { id: record.id, reference: record.reference, createdAt: record.createdAt } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

export async function GET(request: Request): Promise<Response> {
  if (!isDatabaseConfigured()) {
    return Response.json({ configured: false, records: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  const formId = new URL(request.url).searchParams.get("formId") ?? undefined;
  try {
    const records = await listRecords(formId);
    return Response.json(
      {
        configured: true,
        records: records.map((record) => ({
          reference: record.reference,
          formName: record.formName,
          createdAt: record.createdAt,
          // The first value is the record's human handle on a list screen —
          // usually the name — and is far more useful than a UUID.
          summary: record.values[0]?.value ?? "",
          fieldCount: record.values.length,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return fail(error);
  }
}

/**
 * The submitted values, checked against the form they claim to belong to.
 *
 * A value whose key the form does not declare is DROPPED rather than stored:
 * the browser does not get to invent fields on a saved record, and silently
 * ignoring the extra is safer than refusing the whole save over one stray key
 * a future client version might add.
 */
function parseValues(raw: FormDataEntryValue | null, form: { template: { sections: readonly { fields: readonly { key: string; label: string; type: string }[] }[] } }): RecordValue[] | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const declared = new Map(
    form.template.sections.flatMap((section) => section.fields).map((field) => [field.key, field]),
  );

  const values: RecordValue[] = [];
  for (const entry of parsed.slice(0, 100)) {
    if (typeof entry !== "object" || entry === null) continue;
    const source = entry as Record<string, unknown>;
    const key = typeof source.key === "string" ? source.key : "";
    const field = declared.get(key);
    if (!field) continue;

    const value = typeof source.value === "string" ? source.value.slice(0, 1000) : "";
    const provenance = source.source;
    const valueSource: ValueSource =
      provenance === "read" || provenance === "corrected" || provenance === "typed" || provenance === "blank"
        ? provenance
        : "typed";

    values.push({ key, label: field.label, type: field.type, value, source: valueSource });
  }
  return values;
}

function parseJsonObject(raw: FormDataEntryValue | null): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function filePart(part: FormDataEntryValue | null) {
  if (!(part instanceof File) || part.size === 0) return undefined;
  return { bytes: new Uint8Array(await part.arrayBuffer()), contentType: part.type || "image/jpeg" };
}

async function bytesPart(part: FormDataEntryValue | null) {
  if (!(part instanceof File) || part.size === 0) return undefined;
  return new Uint8Array(await part.arrayBuffer());
}

function fail(error: unknown): Response {
  if (error instanceof DatabaseUnavailable) {
    return Response.json({ error: error.message, code: "database_unconfigured" }, { status: 503 });
  }
  console.error("records route failed", error);
  return Response.json({ error: "That record could not be saved. Please try again.", code: "record_failed" }, { status: 500 });
}
