import Link from "next/link";

import { isDatabaseConfigured } from "@/lib/db/client";
import { listForms } from "@/lib/db/forms";

export const dynamic = "force-dynamic";

/**
 * The forms an organization has built, and the link each one publishes to.
 *
 * A form is built by TEACHING it — drawing boxes on a photograph of the paper
 * — which is the scanner's own editor. So this screen does not duplicate that
 * editor; it sends people to it and keeps what comes back.
 */
export default async function FormsPage() {
  if (!isDatabaseConfigured()) {
    return (
      <main className="page">
        <header className="masthead">
          <h1>Forms</h1>
          <p>Build your paper form once, publish it to a link, and scan every filled copy against it.</p>
        </header>
        <p className="notice info">
          No database is connected, so forms cannot be published yet. Set{" "}
          <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>SUPABASE_SERVICE_ROLE_KEY</code> in the
          server&rsquo;s environment. Scanning and reading still work without one — see{" "}
          <Link href="/scan">Scan</Link>.
        </p>
      </main>
    );
  }

  const forms = await listForms();

  return (
    <main className="page">
      <header className="masthead">
        <h1>Forms</h1>
        <p>Build your paper form once, publish it to a link, and scan every filled copy against it.</p>
      </header>

      <div className="actions" style={{ justifyContent: "flex-start", marginBottom: 20 }}>
        <Link className="button" href="/forms/new">
          Build a form
        </Link>
      </div>

      {forms.length === 0 ? (
        <p className="notice info">
          No forms yet. <Link href="/forms/new">Build one</Link> by photographing a blank copy of
          your paper form and drawing a box around each thing people write in.
        </p>
      ) : (
        <div className="form-list">
          {forms.map((form) => {
            const fields = form.template.sections.flatMap((section) => section.fields);
            return (
              <article key={form.id} className="form-card">
                <div>
                  <h2>{form.name}</h2>
                  <div className="form-card-meta">
                    <span className={`chip ${form.status === "published" ? "ok" : ""}`}>{form.status}</span>
                    <span className="chip mono">{fields.length} fields</span>
                    <span className="chip mono">{form.recordCount ?? 0} records</span>
                  </div>
                </div>
                <div className="form-card-actions">
                  {form.status === "published" ? (
                    <Link className="button" href={`/f/${form.slug}`}>
                      Open scan link
                    </Link>
                  ) : (
                    <span style={{ fontSize: 13, color: "var(--muted)" }}>Draft — not yet published</span>
                  )}
                  <Link className="button secondary" href={`/records?form=${form.id}`}>
                    Records
                  </Link>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <p className="footnote">
        A published form&rsquo;s link is what staff open to scan. Its geometry is stored in
        millimetres against the page, so a box drawn on a phone today means the same thing on a
        flatbed scan next week.
      </p>
    </main>
  );
}
