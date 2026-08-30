import Link from "next/link";

import { isDatabaseConfigured } from "@/lib/db/client";
import FormBuilder from "./FormBuilder";

export const dynamic = "force-dynamic";

export default function NewFormPage() {
  if (!isDatabaseConfigured()) {
    return (
      <main className="page">
        <header className="masthead">
          <h1>Build a form</h1>
        </header>
        <p className="notice info">
          No database is connected, so a form cannot be published yet. You can still teach a form
          for this device from the <Link href="/scan">Scan</Link> screen.
        </p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="masthead">
        <h1>Build a form</h1>
        <p>
          Photograph a blank copy of your paper form and draw a box around everything people write
          in. That is the whole build step — the boxes are the form.
        </p>
      </header>

      <FormBuilder />

      <p className="footnote">
        Boxes are stored in millimetres against the squared page, never in pixels of the screen they
        were drawn on, so one drawn on a phone means the same thing on a scan taken next week.
      </p>
    </main>
  );
}
