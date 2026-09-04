import FormChooser from "@/components/FormChooser";
import { isDatabaseConfigured } from "@/lib/db/client";
import { resolveReader } from "@/lib/extract/reader";

/**
 * The home screen: pick the form you are holding.
 *
 * It also states what this deployment can do, because both optional halves —
 * the reader and the database — are genuinely optional, and a scan button
 * that quietly does nothing is worse than one that says why.
 */
export default function Home() {
  const database = isDatabaseConfigured();
  const reader = resolveReader(process.env);

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Choose a form</p>
          <h1>Which form are you scanning?</h1>
          <p className="lede">
            Pick the form, photograph the filled-in copy, and its answers and photograph are read into a record you can
            check, correct and save.
          </p>
        </div>
      </header>

      <FormChooser />

      <section className="status-strip" aria-label="What this server can do">
        <div className={`status ${reader.provider ? "is-on" : "is-off"}`}>
          <strong>AI reading</strong>
          <span>
            {reader.provider ? (
              <>
                on · Groq <code>{reader.provider.model}</code>
              </>
            ) : (
              <>
                off · set <code>GROQ_API_KEY</code> on the server
              </>
            )}
          </span>
        </div>
        <div className={`status ${database ? "is-on" : "is-off"}`}>
          <strong>Saving</strong>
          <span>{database ? "to the database, with photographs in storage" : "in this browser only — no database connected"}</span>
        </div>
        <div className="status is-on">
          <strong>Never read</strong>
          <span>signatures and thumb impressions — only the answers and the photograph</span>
        </div>
      </section>
    </main>
  );
}
