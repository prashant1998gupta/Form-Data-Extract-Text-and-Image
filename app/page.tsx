import ScanWorkbench from "./ScanWorkbench";

/**
 * A Server Component that renders one interactive island, per the coding
 * standard. There is no data to fetch yet — when templates move into the
 * database this is where they will be loaded.
 */
export default function Home() {
  return (
    <main className="page">
      <header className="masthead">
        <h1>
          Form<em>Link</em>
        </h1>
        <p>
          Photograph a filled-in form. The photograph, signature and thumb impression are cropped as
          separate images — with no model calls.
        </p>
      </header>

      <ScanWorkbench />

      <p className="footnote">
        Nothing is stored. Crops are returned in the response and written nowhere: persistence
        belongs behind an explicit human Save. Confidence is shown only for elements that were
        actually found — a refusal never carries a percentage, because there is no calibrated
        probability for a non-event.
      </p>
    </main>
  );
}
