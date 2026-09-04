import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import Scanner from "@/components/scanner/Scanner";
import { isDatabaseConfigured } from "@/lib/db/client";
import { formById } from "@/lib/forms/definitions";

type Props = {
  params: Promise<{ form: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const form = formById((await params).form);
  return { title: form ? `Scan · ${form.name}` : "Scan a form" };
}

/** The scan screen for one form. `?edit=<id>` opens a saved scan for editing. */
export default async function ScanFormPage({ params, searchParams }: Props) {
  const form = formById((await params).form);
  if (!form) notFound();

  const edit = (await searchParams).edit;
  const editId = typeof edit === "string" && edit.trim() ? edit.trim() : null;
  const persistence = isDatabaseConfigured() ? "database" : "browser";

  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">{editId ? "Editing a saved scan" : "Scanning"}</p>
          <h1>{form.name}</h1>
        </div>
        <Link className="button ghost small" href="/">
          Change form
        </Link>
      </header>
      <Scanner key={`${form.id}-${editId ?? "new"}`} form={form} persistence={persistence} editId={editId} />
    </main>
  );
}
