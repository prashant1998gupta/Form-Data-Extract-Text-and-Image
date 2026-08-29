"use client";

import { useCallback, useRef, useState } from "react";

import { prepareUpload, UploadPrepareError } from "@/lib/client/prepare-upload";
import TemplateEditor, { type DrawnTemplate } from "./TemplateEditor";

/**
 * Taught forms live in localStorage.
 *
 * They are box coordinates in millimetres and a name — no patient data, nothing
 * from the scan itself — so this does not weaken the "nothing is stored"
 * promise the footnote makes about the images. It is deliberately interim:
 * templates belong in the database beside the records they describe, and will
 * move there with persistence. Until then, a form taught once on a device stays
 * taught on that device, which is what makes teaching it worth the effort.
 */
const TEMPLATE_STORE = "formlink.templates.v1";

function loadTemplates(): DrawnTemplate[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(TEMPLATE_STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as DrawnTemplate[]) : [];
  } catch {
    // A corrupt store must not take the whole screen down with it.
    return [];
  }
}

function storeTemplates(templates: readonly DrawnTemplate[]): void {
  try {
    localStorage.setItem(TEMPLATE_STORE, JSON.stringify(templates));
  } catch {
    // Private browsing, or a full quota. The template still works for this
    // scan; it just will not be there next time.
  }
}

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
  unverifiedTemplate?: boolean;
  rotationDegrees?: number;
  width?: number;
  height?: number;
  box?: { x: number; y: number; width: number; height: number };
  dataUrl?: string;
};

type TextField = {
  fieldId: string;
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  hint?: string;
  /** The transcription. `""` only with `blank: true`; `null` means it could not be read. */
  value: string | null;
  blank: boolean;
  notInOptions?: boolean;
  failure?: string;
  needsReview: boolean;
  box?: { x: number; y: number; width: number; height: number };
  /** The exact crop the model was shown — the evidence the operator reviews against. */
  evidence?: string;
};

type TextSection = {
  enabled: boolean;
  attempted: boolean;
  provider?: string;
  model?: string;
  skipped?: "no_text_fields" | "not_configured" | "misconfigured" | "not_a_form" | "not_registered" | "throttled";
  failure?: string;
  fields?: TextField[];
  ms?: number;
};

type Result = {
  template: { id: string; name: string; page: { widthMM: number; heightMM: number } };
  page: { method: string; confidence: number; reason: string; skewDegrees: number };
  formPresence: { recognised: boolean; detail: string; textLines: number; rules: number };
  registration: { registered: boolean; detail: string; anchorsFound: number; anchorsChecked: number };
  rectified: { width: number; height: number; pxPerMM: number; dataUrl: string };
  regions: Region[];
  fieldsWithoutGeometry: string[];
  text?: TextSection;
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
  // The operator's corrections to the transcribed values, keyed by fieldId.
  // Held here rather than in the inputs' DOM for two reasons that both bit:
  // an uncontrolled input keeps the PREVIOUS scan's value when a new result
  // renders (defaultValue only applies on mount), and a round trip through the
  // template editor unmounts the cards, silently reverting a corrected value
  // to the misreading the operator already fixed — on the one screen whose
  // whole job is to be believed. Cleared whenever a new result arrives.
  const [textEdits, setTextEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [templates, setTemplates] = useState<DrawnTemplate[]>([]);
  // The bytes that produced the current result, kept so the same capture can be
  // re-read against a template the operator has just drawn. Re-photographing
  // the form to apply a template drawn on that very photograph would be a
  // strange thing to ask.
  const lastFile = useRef<File | null>(null);
  const loaded = useRef(false);
  if (!loaded.current && typeof window !== "undefined") {
    loaded.current = true;
    setTemplates(loadTemplates());
  }

  // A ref, not state: two clicks in the same tick both read the pre-render
  // value of a state flag and both pass. The state exists only to re-render.
  const inFlight = useRef(false);

  const submit = useCallback(async (file: File, template?: DrawnTemplate) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);

    try {
      // Resize BEFORE the request exists. The platform rejects an oversized body
      // at the edge, so there is no server-side handling that could rescue it.
      const prepared = await prepareUpload(file);

      lastFile.current = file;

      const body = new FormData();
      body.append("image", prepared.file);
      if (template) body.append("template", JSON.stringify(template));

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
      setTextEdits({});
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

  const saveTemplate = useCallback(
    (drawn: DrawnTemplate) => {
      // Replace by name, so re-teaching a form corrects it rather than
      // accumulating near-duplicates the operator then has to choose between.
      const next = [drawn, ...templates.filter((t) => t.name !== drawn.name)].slice(0, 20);
      setTemplates(next);
      storeTemplates(next);
      setEditing(false);
      const file = lastFile.current;
      if (file) void submit(file, drawn);
    },
    [templates, submit],
  );

  if (editing && result) {
    return (
      <TemplateEditor
        pageDataUrl={result.rectified.dataUrl}
        pageMM={result.template.page}
        initialName={result.registration.registered ? result.template.name : ""}
        onCancel={() => setEditing(false)}
        onSave={saveTemplate}
      />
    );
  }

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
            {/* Text-field overlays are dashed and unlabelled: eight captioned
                boxes on top of three captioned boxes turns the page into a
                diagram of itself. The card list on the right names each one,
                and the box here just shows where its evidence was cut. No
                title tooltip either — .overlay has pointer-events: none, so a
                title here would be an affordance that can never fire. */}
            {(result.text?.fields ?? []).map((field) =>
              field.box ? (
                <span
                  key={field.fieldId}
                  className="overlay is-text"
                  style={{
                    left: `${(field.box.x / rectified.width) * 100}%`,
                    top: `${(field.box.y / rectified.height) * 100}%`,
                    width: `${(field.box.width / rectified.width) * 100}%`,
                    height: `${(field.box.height / rectified.height) * 100}%`,
                  }}
                />
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
            ) : !result.registration.registered ? (
              /* The page IS a form, but not demonstrably THIS one. Anything found
                 below is real; what is not established is which field it belongs
                 to. Saying so once, plainly, is the difference between an
                 operator checking the crops and an operator trusting a label
                 that was never earned. */
              <p className="notice warn" role="alert" style={{ marginBottom: 16 }}>
                {/* An em dash, not a full stop: `registration.detail` begins
                    lower-case ("only 1 of 3 ..."), so a period here reads as a
                    typo on the one screen whose whole job is to be believed. */}
                <strong>This may not be the {result.template.name}</strong> &mdash;{" "}
                {result.registration.detail}. The images below are shown as{" "}
                <strong>unconfirmed candidates</strong> — check each one before using it, because
                nothing here confirms which field it belongs to.
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

            {result.text && result.text.skipped !== "no_text_fields" && result.text.skipped !== "not_a_form" ? (
              <TextFieldsSection
                text={result.text}
                edits={textEdits}
                onEdit={(fieldId, value) => setTextEdits((current) => ({ ...current, [fieldId]: value }))}
              />
            ) : null}

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

      <div className="actions" style={{ marginTop: 24, justifyContent: "flex-start", flexWrap: "wrap" }}>
        {/* The escape hatch from every wrong answer on this screen. If the
            crops are wrong, they are wrong because the template describes a
            different form — and the person looking at them can fix that in
            three drags. Offered always, not only on a failure: a crop can be
            subtly wrong on a form that registered perfectly well. */}
        <button className="button" type="button" onClick={() => setEditing(true)}>
          {result.registration.registered ? "Fix these boxes" : "Teach this form"}
        </button>
        <button className="button secondary" type="button" onClick={() => setResult(null)}>
          Scan another form
        </button>
      </div>

      {/* Re-read the SAME capture as a form taught earlier. Offered here rather
          than on the upload screen because it only makes sense once there is a
          capture to re-read and a visible answer to disagree with. */}
      {templates.length > 0 ? (
        <div className="samples" style={{ marginTop: 14 }}>
          <span>Read this as</span>
          {templates.map((template) => (
            <button
              key={template.name}
              type="button"
              onClick={() => {
                const file = lastFile.current;
                if (file) void submit(file, template);
              }}
            >
              {template.name}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * The handwritten fields, read by a vision model and presented for review.
 *
 * Three presentation rules, inherited from the image cards and enforced with
 * the same seriousness:
 *
 * EVERY VALUE IS EDITABLE AND MARKED FOR REVIEW. The model proposes; the
 * operator disposes. There is no confidence number that buys a value out of
 * review, because no number on this screen may be a model's opinion of itself.
 *
 * BLANK AND UNREADABLE ARE DIFFERENT ANSWERS. "Read as blank" says nothing is
 * written there — a positive claim. "Could not be read" says go and look at
 * the paper. Collapsing them would launder uncertainty into fact.
 *
 * THE EVIDENCE IS THE MODEL'S OWN INPUT. The strip under each value is
 * byte-for-byte the crop the model was shown, so the operator verifies the
 * value against exactly what produced it.
 */
function TextFieldsSection({
  text,
  edits,
  onEdit,
}: {
  text: TextSection;
  edits: Record<string, string>;
  onEdit: (fieldId: string, value: string) => void;
}) {
  // The page-level states outrank the configuration states: on an unregistered
  // page the honest message is about the page, whatever the server env holds.
  const notice =
    text.skipped === "not_registered" ? (
      <p className="notice warn" role="alert">
        Not read. The page could not be confirmed as this template, and a value read from the wrong
        form would land under the wrong label — the one mistake this screen exists to prevent.
      </p>
    ) : text.skipped === "misconfigured" ? (
      <p className="notice warn" role="alert">
        Not read — the reader is configured wrongly on the server. Check{" "}
        <code>FORMLINK_TEXT_PROVIDER</code> against the API keys that are actually set; the server
        log names the exact problem.
      </p>
    ) : text.skipped === "throttled" ? (
      <p className="notice warn" role="alert">
        Not read — this server has hit its reading limit for the minute. The crops above are
        unaffected; scan again shortly.
      </p>
    ) : !text.enabled ? (
      <p className="notice info" role="status">
        Not read — no AI key is configured. Set <code>GROQ_API_KEY</code> (free at
        console.groq.com/keys) or <code>ANTHROPIC_API_KEY</code> in the server&rsquo;s environment
        — locally that is <code>.env.local</code>; on a host, its environment-variable settings —
        to have these fields transcribed for review.
      </p>
    ) : text.failure ? (
      <p className="notice warn" role="alert">
        <strong>The fields could not be read</strong> &mdash; {text.failure}. The extracted images
        above are unaffected.
      </p>
    ) : null;

  const readerName = text.provider === "groq" ? "Groq" : text.provider === "anthropic" ? "Claude" : text.provider;

  return (
    <div className="text-fields">
      <div className="text-fields-head">
        <h3 className="text-fields-title">Handwritten fields</h3>
        {text.attempted && text.provider ? (
          <span className="chip" title={text.model}>
            read by {readerName} · review each one
          </span>
        ) : null}
      </div>

      {notice ??
        (
          <div className="text-field-list">
            {(text.fields ?? []).map((field) => (
              <TextFieldCard key={field.fieldId} field={field} edit={edits[field.fieldId]} onEdit={onEdit} />
            ))}
          </div>
        )}
    </div>
  );
}

function TextFieldCard({
  field,
  edit,
  onEdit,
}: {
  field: TextField;
  edit: string | undefined;
  onEdit: (fieldId: string, value: string) => void;
}) {
  const inputId = `text-field-${field.fieldId}`;
  const hasInput = !field.failure && field.value !== null;
  // Everything the operator must weigh alongside the value — the blank claim,
  // the option mismatch, the hint — is wired to the input via aria-describedby,
  // not merely placed nearby: the review flow is tabbing input to input, and a
  // flag only the eye can find is a flag a screen reader never gets.
  const blankId = field.blank ? `${inputId}-blank` : undefined;
  const optionsId = field.notInOptions ? `${inputId}-options` : undefined;
  const hintId = field.hint ? `${inputId}-hint` : undefined;
  const describedBy = [blankId, optionsId, hintId].filter(Boolean).join(" ") || undefined;

  return (
    <article className="text-field needs-review">
      <div className="text-field-head">
        {/* A label may only point at a control that exists; in the failure and
            unreadable states there is no input, so the name is a plain span. */}
        {hasInput ? (
          <label className="text-field-name" htmlFor={inputId}>
            {field.label}
            {field.required ? " *" : ""}
          </label>
        ) : (
          <span className="text-field-name">
            {field.label}
            {field.required ? " *" : ""}
          </span>
        )}
        {field.blank ? (
          <span className="chip" id={blankId}>
            read as blank
          </span>
        ) : null}
        {field.notInOptions ? (
          <span className="chip review" id={optionsId}>
            not among the printed choices
          </span>
        ) : null}
      </div>

      {field.failure ? (
        <p className="text-field-note">{field.failure}.</p>
      ) : field.value === null ? (
        /* No percentage, ever: there is no calibrated probability for "I could
           not read this", and false precision here would spend the trust every
           other number on this screen depends on. */
        <p className="text-field-note">Could not be read &mdash; check the paper.</p>
      ) : (
        <input
          id={inputId}
          type="text"
          value={edit ?? field.value}
          onChange={(event) => onEdit(field.fieldId, event.target.value)}
          spellCheck={false}
          aria-required={field.required || undefined}
          aria-describedby={describedBy}
        />
      )}

      {field.evidence ? (
        <figure className="text-field-evidence">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={field.evidence} alt={`What was written in ${field.label}`} />
        </figure>
      ) : null}

      {field.hint ? (
        <p className="text-field-note" id={hintId}>
          {field.hint}
        </p>
      ) : null}
    </article>
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
        {/* An unverified crop is NOT presented under the field's name as though
            it were that field. The reported failure delivered a photograph of a
            table headed "Patient Signature" at 92% — the crop was real, the
            label was the lie. */}
        <h3>{region.unverifiedTemplate ? `Unconfirmed — possibly ${region.label}` : region.label}</h3>

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
