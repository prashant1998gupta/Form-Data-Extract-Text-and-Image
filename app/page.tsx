import Link from "next/link";

import { isDatabaseConfigured } from "@/lib/db/client";
import { resolveReader } from "@/lib/reader/provider";

/**
 * The home screen: what this deployment can do right now, and the three doors.
 *
 * It states its own capabilities rather than assuming them, because both of
 * this product's optional halves — the database and the reader — are genuinely
 * optional, and a home screen that promised a Save button that is not there
 * would be the same false confidence the verify screen exists to refuse.
 */
export default function Home() {
  const database = isDatabaseConfigured();
  const reader = resolveReader(process.env);

  return (
    <main className="page">
      <header className="masthead">
        <h1>
          Form<em>Link</em>
        </h1>
        <p>
          Build your paper form once, publish it to a link, and turn every filled-in copy into a
          verified digital record — the photograph, signature and thumb impression cropped as
          separate images, and the handwriting read for review.
        </p>
      </header>

      <div className="tiles">
        <Link className="tile" href="/forms">
          <h2>1 · Build a form</h2>
          <p>
            Recreate your paper form by drawing boxes on a photo of it: the three image elements,
            and a labelled field for every handwritten answer. Publish it to a link your staff open.
          </p>
          <span className="tile-go">Forms &rarr;</span>
        </Link>

        <Link className="tile" href="/scan">
          <h2>2 · Scan a filled form</h2>
          <p>
            Photograph the completed paper. The page is located and squared, each element measured
            and cropped, and every handwritten field read — then shown for you to check.
          </p>
          <span className="tile-go">Scan &rarr;</span>
        </Link>

        <Link className="tile" href="/records">
          <h2>3 · Read the records</h2>
          <p>
            Every saved scan, with its Doctor and Patient views, the extracted images, and the
            original photograph of the paper archived beside it.
          </p>
          <span className="tile-go">Records &rarr;</span>
        </Link>
      </div>

      <section className="pane" style={{ marginTop: 26 }}>
        <header>
          <h2>What this deployment has</h2>
        </header>
        <div className="pane-body">
          <ul className="capability-list">
            <li>
              <strong>Region extraction</strong> — always on, and calls no model at all.
              Photograph, signature and thumb impression, each cropped or refused with a reason.
            </li>
            <li>
              <strong>Handwriting reading</strong> —{" "}
              {reader.provider ? (
                <>
                  on, via <code>{reader.provider.name === "groq" ? "Groq" : "Claude"}</code> (
                  {reader.provider.model}). Every value is shown for review beside the crop it was
                  read from.
                </>
              ) : (
                <>
                  off. Set <code>GROQ_API_KEY</code> or <code>ANTHROPIC_API_KEY</code> in the
                  server&rsquo;s environment to have handwritten fields transcribed.
                </>
              )}
            </li>
            <li>
              <strong>Saving records</strong> —{" "}
              {database ? (
                <>
                  on. A verified scan is written once, by an explicit Save, with its original
                  capture archived beside it.
                </>
              ) : (
                <>
                  off. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                  <code>SUPABASE_SERVICE_ROLE_KEY</code> to publish forms and save records.
                </>
              )}
            </li>
          </ul>
        </div>
      </section>

      <p className="footnote">
        No record is written without an explicit human Save, and no value reaches one without a
        person confirming it against the paper. Confidence is shown only for elements that were
        actually found — a refusal never carries a percentage, because there is no calibrated
        probability for a non-event.
      </p>
    </main>
  );
}
