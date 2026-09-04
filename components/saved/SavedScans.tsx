"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { Pencil, Search, Trash, User, X } from "@/components/icons";
import { scanStore, type Persistence } from "@/lib/client/scan-store";
import { FORMS, formById, recordSummary, type FormId } from "@/lib/forms/definitions";
import type { SavedScan } from "@/lib/scans/types";

type Props = { persistence: Persistence };

const dateFormatter = new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" });

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase();
}

function Avatar({ scan, size }: { scan: SavedScan; size: number }) {
  const initials = initialsOf(scan.title);
  return (
    <span className="avatar" style={{ width: size, height: Math.round(size * 1.25) }}>
      {scan.photoUrl ? (
        <Image src={scan.photoUrl} alt="" width={size} height={Math.round(size * 1.25)} unoptimized />
      ) : initials ? (
        <b>{initials}</b>
      ) : (
        <User size={Math.round(size * 0.5)} />
      )}
    </span>
  );
}

/**
 * The saved list, in the shape of CardLink's contacts: search, a filter per
 * form, rows with the photograph, and a drawer with every detail.
 */
export default function SavedScans({ persistence }: Props) {
  const store = useMemo(() => scanStore(persistence), [persistence]);
  const [scans, setScans] = useState<SavedScan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [formFilter, setFormFilter] = useState<FormId | "">("");
  const [selected, setSelected] = useState<SavedScan | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    store
      .list()
      .then((items) => {
        if (!active) return;
        setScans(items);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Saved scans could not be loaded.");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [store]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scans.filter((scan) => {
      if (formFilter && scan.form !== formFilter) return false;
      if (!needle) return true;
      const haystack = [scan.title, scan.reference, ...Object.values(scan.values)].join(" ").toLowerCase();
      return haystack.includes(needle);
    });
  }, [scans, query, formFilter]);

  async function remove(scan: SavedScan) {
    const label = scan.title || scan.reference;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    setDeleting(scan.id);
    try {
      await store.remove(scan.id);
      setScans((current) => current.filter((item) => item.id !== scan.id));
      if (selected?.id === scan.id) setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scan could not be deleted.");
    } finally {
      setDeleting(null);
    }
  }

  const counts = useMemo(() => {
    const byForm = new Map<string, number>();
    for (const scan of scans) byForm.set(scan.form, (byForm.get(scan.form) ?? 0) + 1);
    return byForm;
  }, [scans]);

  return (
    <section className="saved" aria-labelledby="saved-title">
      <div className="saved-toolbar">
        <label className="search">
          <Search size={18} />
          <span className="visually-hidden">Search saved scans</span>
          <input type="search" value={query} placeholder="Search by name, reference or any detail" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="chips" role="group" aria-label="Filter by form">
          <button type="button" className={`chip ${formFilter === "" ? "is-on" : ""}`} onClick={() => setFormFilter("")}>
            All <b>{scans.length}</b>
          </button>
          {FORMS.map((form) => (
            <button
              key={form.id}
              type="button"
              className={`chip ${formFilter === form.id ? "is-on" : ""}`}
              onClick={() => setFormFilter(form.id)}
            >
              {form.name.replace(/ Form$/, "")} <b>{counts.get(form.id) ?? 0}</b>
            </button>
          ))}
        </div>
      </div>

      <p className="saved-where">
        {persistence === "database" ? "Saved to the database — visible on every device." : "Saved in this browser only — no database is connected."}
      </p>

      {error && (
        <p className="scan-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="section-note">Loading saved scans…</p>
      ) : visible.length === 0 ? (
        <div className="empty">
          <h2 id="saved-title">{scans.length === 0 ? "No saved scans yet" : "Nothing matches"}</h2>
          <p>{scans.length === 0 ? "Scan a filled-in form and save it, and it will be listed here." : "Try a different search or filter."}</p>
          {scans.length === 0 && (
            <Link className="button primary" href="/">
              Scan a form
            </Link>
          )}
        </div>
      ) : (
        <ul className="scan-list" aria-labelledby="saved-title">
          <h2 id="saved-title" className="visually-hidden">
            Saved scans
          </h2>
          {visible.map((scan) => {
            const form = formById(scan.form);
            const summary = form ? recordSummary(form, scan.values) : "";
            return (
              <li key={scan.id} className="scan-row">
                <button type="button" className="scan-row-main" onClick={() => setSelected(scan)}>
                  <Avatar scan={scan} size={44} />
                  <span className="scan-row-copy">
                    <strong>{scan.title || "Untitled"}</strong>
                    <small>
                      {form?.name ?? scan.form}
                      {summary ? ` · ${summary}` : ""}
                    </small>
                  </span>
                  <span className="scan-row-meta">
                    <span className="reference">{scan.reference}</span>
                    <time dateTime={scan.createdAt}>{formatDate(scan.createdAt)}</time>
                  </span>
                </button>
                <span className="scan-row-actions">
                  <Link className="icon-button" href={`/scan/${scan.form}?edit=${encodeURIComponent(scan.id)}`} aria-label={`Edit ${scan.title || scan.reference}`}>
                    <Pencil size={18} />
                  </Link>
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => remove(scan)}
                    disabled={deleting === scan.id}
                    aria-label={`Delete ${scan.title || scan.reference}`}
                  >
                    <Trash size={18} />
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {selected && (
        <>
          <div className="drawer-backdrop" onClick={() => setSelected(null)} aria-hidden="true" />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
            <header className="drawer-header">
              <Avatar scan={selected} size={72} />
              <div>
                <h2 id="drawer-title">{selected.title || "Untitled"}</h2>
                <p>
                  {formById(selected.form)?.name ?? selected.form} · <span className="reference">{selected.reference}</span>
                </p>
                <p className="drawer-date">Saved {formatDate(selected.createdAt)}</p>
              </div>
              <button type="button" className="icon-button" onClick={() => setSelected(null)} aria-label="Close">
                <X size={20} />
              </button>
            </header>
            <div className="drawer-body">
              {(formById(selected.form)?.sections ?? []).map((section) => {
                const rows = section.fields.filter((field) => (selected.values[field.key] ?? "").trim());
                if (!rows.length) return null;
                return (
                  <section key={section.id} className="drawer-section">
                    <h3>{section.title}</h3>
                    <dl>
                      {rows.map((field) => (
                        <div key={field.key}>
                          <dt>{field.label}</dt>
                          <dd>{selected.values[field.key]}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
            <footer className="drawer-actions">
              <Link className="button primary" href={`/scan/${selected.form}?edit=${encodeURIComponent(selected.id)}`}>
                <Pencil size={18} /> Edit
              </Link>
              <button type="button" className="button text danger" onClick={() => remove(selected)} disabled={deleting === selected.id}>
                <Trash size={18} /> Delete
              </button>
            </footer>
          </aside>
        </>
      )}
    </section>
  );
}
