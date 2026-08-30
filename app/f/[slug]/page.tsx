import Link from "next/link";
import { notFound } from "next/navigation";

import { isDatabaseConfigured } from "@/lib/db/client";
import { formBySlug } from "@/lib/db/forms";
import ScanWorkbench from "../../ScanWorkbench";

export const dynamic = "force-dynamic";

/**
 * A PUBLISHED FORM'S LINK — the screen staff actually live in.
 *
 * The template is loaded here and identified to the scanner by id alone. The
 * geometry never travels through the browser on this path: a published form's
 * boxes belong to the organization, and a scan must not be able to redefine
 * where its own crops are cut.
 */
export default async function PublishedFormPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  if (!isDatabaseConfigured()) {
    return (
      <main className="page">
        <header className="masthead">
          <h1>Form link</h1>
        </header>
        <p className="notice info">
          No database is connected on this deployment, so published forms cannot be opened. You can
          still scan from the <Link href="/scan">Scan</Link> screen.
        </p>
      </main>
    );
  }

  const form = await formBySlug(slug);
  if (!form || form.status !== "published") notFound();

  const fields = form.template.sections.flatMap((section) => section.fields);

  return (
    <main className="page">
      <header className="masthead">
        <h1>{form.name}</h1>
        <p>
          Photograph a filled-in copy of this form. Every value is checked by you before anything is
          saved — {fields.length} field{fields.length === 1 ? "" : "s"} are read from each scan.
        </p>
      </header>

      <ScanWorkbench form={{ id: form.id, name: form.name }} />

      <p className="footnote">
        Saving writes one record: the values as you left them, the extracted images, and the
        original photograph of the paper archived beside them. Nothing is written until you press
        Save.
      </p>
    </main>
  );
}
