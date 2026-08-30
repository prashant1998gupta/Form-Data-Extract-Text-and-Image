import Link from "next/link";

import { isDatabaseConfigured } from "@/lib/db/client";
import { listRecords } from "@/lib/db/records";

export const dynamic = "force-dynamic";

/** Every saved scan, newest first. */
export default async function RecordsPage({ searchParams }: { searchParams: Promise<{ form?: string }> }) {
  const { form } = await searchParams;

  if (!isDatabaseConfigured()) {
    return (
      <main className="page">
        <header className="masthead">
          <h1>Records</h1>
        </header>
        <p className="notice info">
          No database is connected, so nothing is saved yet. Scanning still works — see{" "}
          <Link href="/scan">Scan</Link>.
        </p>
      </main>
    );
  }

  const records = await listRecords(form);

  return (
    <main className="page">
      <header className="masthead">
        <h1>Records</h1>
        <p>Every scan a person verified and saved, with the original paper archived beside it.</p>
      </header>

      {records.length === 0 ? (
        <p className="notice info">
          No records yet. Open a <Link href="/forms">published form</Link>, scan a filled-in copy,
          check the values, and save.
        </p>
      ) : (
        <div className="record-list">
          {records.map((record) => {
            const primary = record.values[0];
            return (
              <Link key={record.id} className="record-row" href={`/r/${record.reference}`}>
                <span className="record-ref mono">{record.reference}</span>
                <span className="record-summary">
                  {primary?.value || <em style={{ color: "var(--muted)" }}>no values</em>}
                  {record.formName ? <small> · {record.formName}</small> : null}
                </span>
                {/* A fixed locale and zone, like the record page: a date that
                    renders differently on the server and in the browser is a
                    hydration mismatch, and on a records list it also means two
                    people reading the same row can see different days. */}
                <span className="record-date">
                  {new Date(record.createdAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" })}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </main>
  );
}
