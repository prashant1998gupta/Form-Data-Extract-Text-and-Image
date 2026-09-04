"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Rows, Scan } from "./icons";

const links = [
  { href: "/", label: "Scan a form", short: "Scan", Icon: Scan, matches: (path: string) => path === "/" || path.startsWith("/scan") },
  { href: "/saved", label: "Saved scans", short: "Saved", Icon: Rows, matches: (path: string) => path.startsWith("/saved") },
];

/** The two destinations: a segmented control on desktop, a tab bar on phones. */
export default function NavLinks() {
  const pathname = usePathname() ?? "/";
  return (
    <nav className="topnav" aria-label="Main">
      {links.map(({ href, label, short, Icon, matches }) => (
        <Link key={href} href={href} aria-current={matches(pathname) ? "page" : undefined}>
          <Icon />
          <span className="tab-label" aria-hidden="true">{short}</span>
          <span className="visually-hidden">{label}</span>
        </Link>
      ))}
    </nav>
  );
}
