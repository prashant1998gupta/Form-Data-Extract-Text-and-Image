"use client";

import { useState } from "react";

/**
 * The two views the spec asks for, over one saved record.
 *
 * DOCTOR VIEW is the clinical sheet: everything, with the evidence images and
 * a link to the original paper. PATIENT VIEW is the receipt — deliberately
 * much simpler, printable, and carrying only what a patient needs to carry
 * home. They are tabs over the same record rather than two stored documents,
 * because a record that can disagree with itself is worse than either view.
 *
 * WHAT IS NOT SHOWN ANYWHERE HERE: a confidence percentage. Every value on
 * this page was confirmed by a person before it was written, so a number
 * describing how sure a model once was would be both stale and irrelevant —
 * and this product does not print a model's opinion of itself.
 */

export interface RecordValueView {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly source: string;
}

export interface RecordImages {
  readonly photo: string | null;
  readonly signature: string | null;
  readonly thumb: string | null;
  readonly original: string | null;
}

export default function RecordViews({
  reference,
  formName,
  savedAt,
  savedOn,
  values,
  images,
}: {
  reference: string;
  formName: string;
  /**
   * Already formatted, by the server, on purpose. `toLocaleString()` in a
   * client component renders one string during SSR and a different one in the
   * browser whenever their timezones or locales differ, which React reports as
   * a hydration failure — and on a record screen, a date that changes between
   * the HTML and the hydrated page is exactly the kind of quiet inconsistency
   * this product cannot afford.
   */
  savedAt: string;
  savedOn: string;
  values: readonly RecordValueView[];
  images: RecordImages;
}) {
  const [view, setView] = useState<"doctor" | "patient">("doctor");

  return (
    <>
      <div className="tabs" role="tablist" aria-label="Record views">
        <button
          role="tab"
          aria-selected={view === "doctor"}
          className={`tab${view === "doctor" ? " is-active" : ""}`}
          onClick={() => setView("doctor")}
        >
          Doctor view
        </button>
        <button
          role="tab"
          aria-selected={view === "patient"}
          className={`tab${view === "patient" ? " is-active" : ""}`}
          onClick={() => setView("patient")}
        >
          Patient receipt
        </button>
      </div>

      {view === "doctor" ? (
        <section className="pane" aria-label="Doctor view">
          <header>
            <h2>{formName}</h2>
            <span className="chip mono">{reference}</span>
          </header>
          <div className="pane-body doctor-grid">
            <div className="doctor-photo">
              {images.photo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={images.photo} alt="Patient photograph, as extracted from the form" />
              ) : (
                <div className="crop is-missing">
                  <span>No photograph</span>
                </div>
              )}
            </div>

            <dl className="doctor-values">
              {values.map((value) => (
                <div key={value.key} className="doctor-value">
                  <dt>{value.label}</dt>
                  <dd>
                    {value.value || <span style={{ color: "var(--muted)" }}>—</span>}
                    {/* How this value came to be what it is. Quiet, but present:
                        a record that cannot say which values a human retyped is
                        a record that cannot be audited. */}
                    {value.source === "corrected" ? <span className="chip">corrected on review</span> : null}
                    {value.source === "typed" ? <span className="chip">entered by hand</span> : null}
                    {value.source === "blank" ? <span className="chip">read as blank</span> : null}
                  </dd>
                </div>
              ))}
            </dl>

            <div className="doctor-marks">
              <figure>
                <figcaption>Signature</figcaption>
                {images.signature ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={images.signature} alt="Signature, as extracted" />
                ) : (
                  <div className="crop is-missing">
                    <span>Not Detected</span>
                  </div>
                )}
              </figure>
              <figure>
                <figcaption>Thumb impression</figcaption>
                {images.thumb ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={images.thumb} alt="Thumb impression, as extracted" />
                ) : (
                  <div className="crop is-missing">
                    <span>Not Detected</span>
                  </div>
                )}
              </figure>
            </div>
          </div>
          <div className="stats">
            <span>saved {savedAt}</span>
            {images.original ? (
              <span>
                <a href={images.original} target="_blank" rel="noreferrer">
                  the original paper form
                </a>
              </span>
            ) : (
              <span>no original archived</span>
            )}
          </div>
        </section>
      ) : (
        <section className="receipt" aria-label="Patient receipt">
          <h2>{formName}</h2>
          <p className="receipt-ref">
            Reference <strong>{reference}</strong>
          </p>
          <dl>
            {values.map((value) => (
              <div key={value.key}>
                <dt>{value.label}</dt>
                <dd>{value.value || "—"}</dd>
              </div>
            ))}
          </dl>
          <p className="receipt-date">Recorded {savedOn}</p>

          <div className="receipt-instructions">
            <h3>General instructions</h3>
            <ul>
              <li>Take medicines as prescribed by the doctor.</li>
              <li>Bring previous medical reports during the next visit.</li>
              <li>Arrive at least 15 minutes before the scheduled appointment.</li>
              <li>Contact the hospital if the appointment needs to be rescheduled.</li>
            </ul>
          </div>

          <div className="actions no-print" style={{ justifyContent: "flex-start", marginTop: 16 }}>
            <button className="button" type="button" onClick={() => window.print()}>
              Print this receipt
            </button>
          </div>
        </section>
      )}
    </>
  );
}
