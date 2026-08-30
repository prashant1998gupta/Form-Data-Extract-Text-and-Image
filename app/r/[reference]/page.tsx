import Link from "next/link";
import { notFound } from "next/navigation";

import { isDatabaseConfigured } from "@/lib/db/client";
import { recordByReference } from "@/lib/db/records";
import RecordViews from "./RecordViews";

export const dynamic = "force-dynamic";

/** One saved record, in the two views the spec asks for. */
export default async function RecordPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;

  if (!isDatabaseConfigured()) {
    return (
      <main className="page">
        <header className="masthead">
          <h1>Record</h1>
        </header>
        <p className="notice info">
          No database is connected on this deployment, so records cannot be read.{" "}
          <Link href="/scan">Scan</Link> still works.
        </p>
      </main>
    );
  }

  const record = await recordByReference(reference);
  if (!record) notFound();

  // Served through this application, never as storage links: a signed URL in
  // the page is a bearer token for a patient's photograph that outlives the
  // tab it was rendered in. See the route's own note.
  const image = (kind: string, path: string | null) =>
    path ? `/api/records/${encodeURIComponent(record.reference)}/image/${kind}` : null;
  const images = {
    photo: image("photo", record.photoPath),
    signature: image("signature", record.signaturePath),
    thumb: image("thumb", record.thumbPath),
    original: image("original", record.originalPath),
  };

  // Formatted once, on the server, in a fixed locale so the HTML and the
  // hydrated page always agree — see RecordViews for why that matters here.
  const saved = new Date(record.createdAt);
  const savedAt = saved.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
  const savedOn = saved.toLocaleDateString("en-GB", { dateStyle: "long", timeZone: "UTC" });

  return (
    <main className="page">
      <header className="masthead no-print">
        <h1>Record {record.reference}</h1>
        <p>
          Every value below was confirmed by a person before it was written. <Link href="/records">All records</Link>
        </p>
      </header>

      <RecordViews
        reference={record.reference}
        formName={record.formName ?? "Form"}
        savedAt={savedAt}
        savedOn={savedOn}
        values={record.values.map((value) => ({
          key: value.key,
          label: value.label,
          value: value.value,
          source: value.source,
        }))}
        images={images}
      />
    </main>
  );
}
