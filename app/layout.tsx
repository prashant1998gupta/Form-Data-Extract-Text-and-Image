import type { Metadata, Viewport } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: "FormLink — form digitization",
  description:
    "Turn handwritten paper forms into verified digital records: build a form, publish it to a link, scan the paper, verify every value, and save.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f4f2ed",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* One bar, four destinations, in the order the product is used:
            build a form, scan against it, read what was saved. */}
        <nav className="topbar" aria-label="Main">
          <Link className="topbar-brand" href="/">
            Form<em>Link</em>
          </Link>
          <div className="topbar-links">
            <Link href="/forms">Forms</Link>
            <Link href="/scan">Scan</Link>
            <Link href="/records">Records</Link>
          </div>
        </nav>
        {children}
      </body>
    </html>
  );
}
