import ScanWorkbench from "../ScanWorkbench";

/**
 * Scanning without a published form — the demo path, and the one that needs
 * no database. The seeded hospital template is used unless the operator
 * teaches a form of their own.
 */
export default function ScanPage() {
  return (
    <main className="page">
      <header className="masthead">
        <h1>Scan a form</h1>
        <p>
          Photograph a filled-in form. The photograph, signature and thumb impression are cropped
          with no model calls — and the handwritten fields are read for review when an AI key is
          configured.
        </p>
      </header>

      <ScanWorkbench />

      <p className="footnote">
        Scanning here saves nothing. To keep what a scan produces, open a{" "}
        <a href="/forms">published form</a> and scan from its link — that path ends in a Save.
      </p>
    </main>
  );
}
