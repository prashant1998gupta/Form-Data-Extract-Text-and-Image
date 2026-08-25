"use client";

import { useCallback, useRef, useState } from "react";

import { prepareUpload, UploadPrepareError } from "@/lib/client/prepare-upload";

/**
 * The verification screen: original form on the left, extracted elements on the
 * right (spec §4).
 *
 * Two presentation decisions here carry product weight.
 *
 * A REFUSAL IS NOT AN ERROR. "Not Detected — the box is empty" is a correct,
 * confident result. Rendering it in the same red as a failure teaches staff to
 * treat both as noise, and the whole value of refusing rather than guessing is
 * lost. Refusals are neutral and state their reason in plain words.
 *
 * A REFUSAL NEVER SHOWS A PERCENTAGE. There is no calibrated probability for a
 * non-event, and a number beside "Not Detected" is false precision that
 * undermines every real number on the screen.
 */

type Region = {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  found: boolean;
  confidence?: number;
  needsReview: boolean;
  reason?: "box_empty" | "below_threshold" | "geometry_unknown";
  detail?: string;
  warning?: string;
  lowResolution?: boolean;
  rotationDegrees?: number;
  width?: number;
  height?: number;
  box?: { x: number; y: number; width: number; height: number };
  dataUrl?: string;
};

type Result = {
  template: { id: string; name: string };
  page: { method: string; confidence: number; reason: string; skewDegrees: number };
  formPresence: { recognised: boolean; detail: string; textLines: number; rules: number };
  rectified: { width: number; height: number; pxPerMM: number; dataUrl: string };
  regions: Region[];
  fieldsWithoutGeometry: string[];
  timings: Record<string, number>;
};

/** Plain-language explanation of each refusal. Never jargon, never a code. */
const REASON_TEXT: Record<string, string> = {
  box_empty: "The box was located and is empty.",
  below_threshold: "Something was found here, but not clearly enough to crop.",
  geometry_unknown: "The form could not be aligned, so this region could not be located.",
};

const ACCEPTED = "image/jpeg,image/png,image/webp";

/**
 * Reads a JSON body without assuming there is one.
 *
 * Not every reply comes from this application. A request rejected by the
 * platform edge — an oversized body, a gateway timeout, a cold-start failure —
 * answers in plain text, and calling `.json()` on it throws. That throw used to
 * land in the same catch as a dropped connection and report "the upload did not
 * reach the server", which is a false diagnosis of a request that arrived
 * perfectly well and was refused on arrival.
 */
async function readJson(response: Response): Promise<{ error?: string } | null> {
  try {
    return (await response.json()) as { error?: string };
  } catch {
    return null;
  }
}

/**
 * What to say when the reply carried no message of ours.
 *
 * These are the edge's own failures, phrased as an instruction the person
 * holding the paper form can actually act on.
 */
function statusMessage(status: number): string {
  if (status === 413) {
    return "That photo was too large to upload. Photograph the form again at a lower resolution.";
  }
  if (status === 504 || status === 408) {
    return "The form took too long to process. Try again, or photograph it with the whole page in frame.";
  }
  if (status >= 500) {
    return "The server could not process the form. Please try again in a moment.";
  }
  return "The form could not be processed.";
}

export default function ScanWorkbench() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // A ref, not state: two clicks in the same tick both read the pre-render
  // value of a state flag and both pass. The state exists only to re-render.
  const inFlight = useRef(false);

  const submit = useCallback(async (file: File) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);

    try {
      // Resize BEFORE the request exists. The platform rejects an oversized body
      // at the edge, so there is no server-side handling that could rescue it.
      const prepared = await prepareUpload(file);

      const body = new FormData();
      body.append("image", prepared.file);

      let response: Response;
      try {
        response = await fetch("/api/extract", { method: "POST", body });
      } catch {
        // The ONLY genuine network failure. Everything below this point got a
        // reply from something, and blaming the operator's connection for a
        // reply we did receive sends them to go and restart a working router.
        setError("The upload did not reach the server. Check your connection and try again.");
        setResult(null);
        return;
      }

      const payload = await readJson(response);

      if (!response.ok) {
        setError(payload?.error ?? statusMessage(response.status));
        setResult(null);
        return;
      }
      if (!payload) {
        setError("The server's reply could not be read. Please try again.");
        setResult(null);
        return;
      }

      setResult(payload as Result);
    } catch (cause) {
      setError(
        cause instanceof UploadPrepareError
          ? cause.message
          : "The photo could not be prepared for upload. Please try again.",
      );
      setResult(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  const onFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void submit(file);
    },
    [submit],
  );

  /**
   * Loads one of the bundled sample forms.
   *
   * The UNFILLED sample is the one worth showing. Anyone can demo a detector on
   * a form that has everything pasted on it; the question a hospital actually
   * asks is what happens when the patient brought no photograph, and the answer
   * — three confident "Not Detected" results with reasons — is the product.
   */
  const useSample = useCallback(
    async (name: string) => {
      try {
        const response = await fetch(`/samples/${name}.jpg`);
        const blob = await response.blob();
        await submit(new File([blob], `${name}.jpg`, { type: "image/jpeg" }));
      } catch {
        setError("The sample form could not be loaded.");
      }
    },
    [submit],
  );

  if (busy) {
    return (
      <div className="pane">
        <div className="progress">
          <div className="spinner" aria-hidden="true" />
          <strong>Reading the form</strong>
          <span>Locating the page, then measuring each element&rsquo;s edges.</span>
        </div>
      </div>
    );
  }

  if (!result) {
    return (
      <>
        {error ? (
          <p className="notice error" role="alert" style={{ marginBottom: 18 }}>
            {error}
          </p>
        ) : null}

        <div
          className={`dropzone${dragging ? " is-over" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            onFiles(event.dataTransfer.files);
          }}
        >
          <h2>New Patient Registration Form</h2>
          <p>
            Drop a photo or scan of the filled-in form, or use your camera. The whole page should be
            in frame.
          </p>
          <div className="actions">
            {/* The label IS the button; the input is hidden but focusable.
                `capture="environment"` opens the rear camera on mobile, which
                is why next.config.ts must send Permissions-Policy camera=(self). */}
            <label className="button">
              Take a photo
              <input
                className="visually-hidden"
                type="file"
                accept={ACCEPTED}
                capture="environment"
                onChange={(event) => {
                  onFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <label className="button secondary">
              Choose a file
              <input
                className="visually-hidden"
                type="file"
                accept={ACCEPTED}
                onChange={(event) => {
                  onFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
          </div>

          <div className="samples">
            <span>No form to hand?</span>
            <button type="button" onClick={() => void useSample("filled-desk-photo")}>
              Filled form, photographed on a desk
            </button>
            <button type="button" onClick={() => void useSample("filled-photocopy")}>
              Photocopy
            </button>
            <button type="button" onClick={() => void useSample("unfilled")}>
              Unfilled — nothing pasted
            </button>
          </div>
        </div>
      </>
    );
  }

  const { rectified, regions, page } = result;
  const found = regions.filter((region) => region.found).length;
  const review = regions.filter((region) => region.needsReview).length;

  return (
    <>
      <div className="verify">
        <section className="pane" aria-label="Original form">
          <header>
            <h2>Original form</h2>
            <span className="chip mono">
              {rectified.width}&times;{rectified.height}
            </span>
          </header>
          <figure className="form-figure" style={{ margin: 0 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={rectified.dataUrl} alt="The uploaded form, aligned to the page" />
            {regions.map((region) =>
              region.box ? (
                <span
                  key={region.fieldId}
                  className={`overlay${region.found ? "" : " is-missing"}`}
                  style={{
                    left: `${(region.box.x / rectified.width) * 100}%`,
                    top: `${(region.box.y / rectified.height) * 100}%`,
                    width: `${(region.box.width / rectified.width) * 100}%`,
                    height: `${(region.box.height / rectified.height) * 100}%`,
                  }}
                >
                  <span>{region.label}</span>
                </span>
              ) : null,
            )}
          </figure>
          <div className="stats">
            <span>page: {page.method}</span>
            <span>alignment: {(page.confidence * 100).toFixed(0)}%</span>
            {page.skewDegrees ? <span>skew: {page.skewDegrees}&deg;</span> : null}
            <span>{rectified.pxPerMM.toFixed(2)} px/mm</span>
          </div>
        </section>

        <section className="pane" aria-label="Extracted elements">
          <header>
            <h2>Extracted elements</h2>
            <span className="chip">
              {found} of {regions.length} found
              {review > 0 ? ` · ${review} to review` : ""}
            </span>
          </header>
          <div className="pane-body">
            {/* Stated ONCE, above the fields, when the capture is not a form.
                Three fields each saying the same thing reads as three separate
                failures of the product; one sentence naming what was measured
                reads as what it is — the wrong photograph. */}
            {!result.formPresence.recognised ? (
              <p className="notice warn" role="alert" style={{ marginBottom: 16 }}>
                <strong>This does not look like the form.</strong> No fields were read, because{" "}
                {result.formPresence.detail}. Photograph the printed form with the whole page in
                frame.
              </p>
            ) : null}

            <div className="regions">
              {regions.map((region) => (
                <RegionCard
                  key={region.fieldId}
                  region={region}
                  // The banner above already gave the measurement. Repeating it
                  // on all three cards turns one problem into what reads as
                  // three, and buries the one instruction that matters.
                  suppressDetail={!result.formPresence.recognised}
                />
              ))}
            </div>

            {result.fieldsWithoutGeometry.length > 0 ? (
              <p className="notice info" style={{ marginTop: 16 }}>
                {result.fieldsWithoutGeometry.length} field
                {result.fieldsWithoutGeometry.length === 1 ? " has" : "s have"} no position recorded
                yet. Draw their boxes on a blank copy of this form to enable detection.
              </p>
            ) : null}
          </div>
          <div className="stats">
            {Object.entries(result.timings).map(([stage, ms]) => (
              <span key={stage}>
                {stage}: {ms}ms
              </span>
            ))}
          </div>
        </section>
      </div>

      <div className="actions" style={{ marginTop: 24, justifyContent: "flex-start" }}>
        <button className="button secondary" type="button" onClick={() => setResult(null)}>
          Scan another form
        </button>
      </div>
    </>
  );
}

function RegionCard({ region, suppressDetail = false }: { region: Region; suppressDetail?: boolean }) {
  return (
    <article className={`region${region.needsReview ? " needs-review" : ""}`}>
      <div className={`crop${region.found ? "" : " is-missing"}`}>
        {region.found && region.dataUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={region.dataUrl} alt={`Extracted ${region.label}`} />
        ) : (
          <span>Not Detected</span>
        )}
      </div>

      <div className="region-detail">
        <h3>{region.label}</h3>

        {region.found ? (
          <div className="region-meta">
            {/* Confidence appears ONLY on a found element. */}
            <span className={`chip ${region.needsReview ? "review" : "ok"}`}>
              {Math.round((region.confidence ?? 0) * 100)}%{region.needsReview ? " · review" : ""}
            </span>
            <span className="chip mono">
              {region.width}&times;{region.height}
            </span>
            {region.rotationDegrees && Math.abs(region.rotationDegrees) >= 0.5 ? (
              <span className="chip">straightened {Math.abs(region.rotationDegrees).toFixed(1)}&deg;</span>
            ) : null}
            {region.lowResolution ? <span className="chip review">low resolution</span> : null}
          </div>
        ) : (
          <>
            <p>{REASON_TEXT[region.reason ?? ""] ?? "This element could not be located."}</p>
            {region.detail && !suppressDetail ? (
              <p style={{ color: "var(--muted)", fontSize: 12 }}>{region.detail}</p>
            ) : null}
          </>
        )}

        {region.warning ? (
          <p className="notice warn" style={{ marginTop: 10 }}>
            {region.warning}
          </p>
        ) : null}
      </div>
    </article>
  );
}
