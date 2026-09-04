import type { Metadata } from "next";

import SavedScans from "@/components/saved/SavedScans";
import { isDatabaseConfigured } from "@/lib/db/client";

export const metadata: Metadata = { title: "Saved scans" };

/** Everything that has been saved, like CardLink's contacts. */
export default function SavedPage() {
  const persistence = isDatabaseConfigured() ? "database" : "browser";
  return (
    <main className="page">
      <header className="masthead">
        <div>
          <p className="eyebrow">Saved</p>
          <h1>Saved scans</h1>
        </div>
      </header>
      <SavedScans persistence={persistence} />
    </main>
  );
}
