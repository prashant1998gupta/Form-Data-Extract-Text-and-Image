import type { Metadata, Viewport } from "next";
import Link from "next/link";

import NavLinks from "@/components/NavLinks";
import "./globals.css";

export const metadata: Metadata = {
  title: "FormLink — scan a form",
  description: "Photograph a filled-in form and its details and photograph are read into an editable record you can check and save.",
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
        <header className="topbar">
          <Link className="brand" href="/">
            Form<em>Link</em>
          </Link>
          <NavLinks />
        </header>
        {children}
      </body>
    </html>
  );
}
