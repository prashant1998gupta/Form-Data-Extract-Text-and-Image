"use client";

import { useCallback, useRef, useState } from "react";

import { DRAWN_TEXT_TYPES, type DrawnBox, type DrawnElement, type DrawnTemplate, type DrawnTextField, type DrawnTextType } from "@/lib/templates/drawn";

/**
 * Teaching the app a form, by drawing on it.
 *
 * WHY THIS IS THE FIX. The extraction engine is good — it puts a pixel-tight
 * quadrilateral round a pasted photograph and delivers a signature as ink on
 * transparency. It fails on a real user's form for exactly one reason: it is
 * measuring that form against coordinates belonging to a different one. The
 * engine does not need to be smarter. It needs to be told where things are, and
 * the person holding the paper already knows.
 *
 * A FEW MILLIMETRES OUT IS FINE, and that is a measured claim rather than a
 * hope. A dragged box is a different kind of object from a registered one —
 * accurate to a few millimetres where a homography is accurate to a fraction of
 * one — and the photo detector is told so, which widens its prior. Measured on
 * the reference fixture, a box drawn up to 6 mm out still yields a crop at IoU
 * 0.988 against the photograph's true physical boundary.
 *
 * BUT NOT ARBITRARILY WIDE, and the copy says so rather than pretending
 * otherwise. A box drawn generously on every side pushes each declared edge
 * outward into whatever surrounds the element, and on a real form that is
 * usually other printed content: measured, the one edge that fails first is the
 * one with the form's own text just outside it, which stops being findable
 * about 5 mm out. Widening the search does not fix this — it makes the detector
 * find the text instead — and a sweep of asymmetric bands was erratic enough
 * that shipping any of them would have been tuning to a fixture rather than to
 * a cause. So the instruction is "close around", the failure is specific about
 * WHICH edge could not be measured, and drawing it again is one gesture.
 *
 * COORDINATES ARE STORED IN MILLIMETRES, never in pixels of this screen. The
 * page behind the drawing is the RECTIFIED page, so a millimetre is a fixed
 * number of pixels by construction and a box drawn on a phone means the same
 * thing on a desktop, on a flatbed scan, and on a photograph taken at a
 * different distance next week. Storing display pixels would silently bind the
 * template to the screen it happened to be drawn on.
 */

export type { DrawnTemplate };

const ELEMENTS = [
  // Not "passport photo": the box's own size is the size the detector is told,
  // so a 60 mm print is as welcome as a 35 mm one — what matters is drawing
  // close around whatever is there.
  { type: "photograph", label: "Photograph", hint: "the pasted photo, any size — draw close around it" },
  { type: "signature", label: "Signature", hint: "where the person signs" },
  { type: "thumbImpression", label: "Thumb", hint: "the inked thumb box" },
] as const;

/** What each drawable answer shape is called on screen. Order is the select's order. */
const TEXT_TYPE_LABELS: Readonly<Record<DrawnTextType, string>> = {
  shortText: "Short text",
  name: "Name",
  phone: "Phone number",
  email: "Email",
  number: "Number",
  date: "Date",
  age: "Age",
  address: "Address",
  longText: "Long text",
};

type ElementType = DrawnElement | "text";

/** The server's MAX_FIELDS, mirrored so the person learns of the bound at box 40, not at save time. */
const MAX_REGIONS = 40;

interface Props {
  /** The rectified page, as shown on the verify screen. */
  readonly pageDataUrl: string;
  /** Physical size of the page the boxes are measured against. */
  readonly pageMM: { readonly widthMM: number; readonly heightMM: number };
  readonly initialName?: string;
  /**
   * The taught template this capture was read with, when there is one. It
   * seeds the editor, because "Fix these boxes" that opened EMPTY was a trap:
   * saving replaces the stored template by name, so every taught field the
   * person did not redraw silently vanished — tolerable at three image boxes,
   * ruinous at thirty labelled text fields.
   */
  readonly initial?: DrawnTemplate | null;
  /** What the commit button says. The builder publishes; the scanner re-reads. */
  readonly saveLabel?: string;
  readonly onCancel: () => void;
  readonly onSave: (template: DrawnTemplate) => void;
}

export default function TemplateEditor({ pageDataUrl, pageMM, initialName, initial, saveLabel, onCancel, onSave }: Props) {
  const [name, setName] = useState(initial?.name ?? initialName ?? "");
  const [active, setActive] = useState<ElementType>("photograph");
  const [boxes, setBoxes] = useState<Record<string, DrawnBox>>(() => {
    const seeded: Record<string, DrawnBox> = {};
    for (const field of initial?.fields ?? []) seeded[field.type] = field;
    return seeded;
  });
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  // Text fields taught by drawing. A drawn text box is not committed until it
  // has a label — an unlabelled answer area is a value with nowhere to land.
  const [textFields, setTextFields] = useState<DrawnTextField[]>(() => [...(initial?.textFields ?? [])]);
  const [pendingBox, setPendingBox] = useState<DrawnTextField["box"] | null>(null);
  const [pendingLabel, setPendingLabel] = useState("");
  const [pendingType, setPendingType] = useState<DrawnTextType>("shortText");

  const surface = useRef<HTMLDivElement | null>(null);

  /** Pointer position as a 0..1 fraction of the page, clamped to it. */
  const fractionAt = useCallback((event: { clientX: number; clientY: number }) => {
    const element = surface.current;
    if (!element) return { fx: 0, fy: 0 };
    const rect = element.getBoundingClientRect();
    return {
      fx: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))),
      fy: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Capture so a drag that leaves the image still finishes here, and so a
      // touch drag does not turn into a page scroll halfway through.
      event.currentTarget.setPointerCapture(event.pointerId);
      const { fx, fy } = fractionAt(event);
      setDrag({ x0: fx, y0: fy, x1: fx, y1: fy });
    },
    [fractionAt],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const { fx, fy } = fractionAt(event);
      setDrag({ ...drag, x1: fx, y1: fy });
    },
    [drag, fractionAt],
  );

  const onPointerUp = useCallback(() => {
    if (!drag) return;
    const xMM = Math.min(drag.x0, drag.x1) * pageMM.widthMM;
    const yMM = Math.min(drag.y0, drag.y1) * pageMM.heightMM;
    const widthMM = Math.abs(drag.x1 - drag.x0) * pageMM.widthMM;
    const heightMM = Math.abs(drag.y1 - drag.y0) * pageMM.heightMM;
    setDrag(null);

    // A tap is not a box. Below this the person is scrolling or mis-touched,
    // and turning that into a 2 mm region produces a baffling refusal later.
    if (widthMM < 5 || heightMM < 5) return;

    if (active === "text") {
      // The box waits for its label. Drawing again replaces it — redrawing is
      // cheaper than a resize handle, on a phone especially.
      setPendingBox({ xMM, yMM, widthMM, heightMM });
      return;
    }

    setBoxes((current) => ({ ...current, [active]: { type: active, box: { xMM, yMM, widthMM, heightMM } } }));

    // Advance to the next element that has no box yet, so the common path is
    // three drags with no button presses in between.
    const next = ELEMENTS.find((e) => e.type !== active && !boxes[e.type]);
    if (next) setActive(next.type);
  }, [drag, pageMM, active, boxes]);

  const addTextField = useCallback(() => {
    const label = pendingLabel.replace(/\s+/g, " ").trim();
    if (!pendingBox || !label) return;
    // The same one-name-one-field rule the server enforces, caught where the
    // person can still fix it instead of at save time.
    if (textFields.some((field) => field.label.toLowerCase() === label.toLowerCase())) return;
    setTextFields((current) => [...current, { label, textType: pendingType, box: pendingBox }]);
    setPendingBox(null);
    setPendingLabel("");
  }, [pendingBox, pendingLabel, pendingType, textFields]);

  const duplicateLabel =
    pendingLabel.trim().length > 0 &&
    textFields.some((field) => field.label.toLowerCase() === pendingLabel.replace(/\s+/g, " ").trim().toLowerCase());

  const drawn = Object.values(boxes);
  const atRegionLimit = drawn.length + textFields.length >= MAX_REGIONS;
  // A pending text box blocks Save rather than being silently dropped: the
  // person typed a label for it, and losing it on Save would be losing work
  // that was one click from committed.
  const canSave = (drawn.length > 0 || textFields.length > 0) && name.trim().length > 0 && !pendingBox;

  return (
    <div className="pane" style={{ padding: 18 }}>
      {/* `display: block` overrides the `.pane header` flex row from globals.css,
          which otherwise squeezes the heading into a narrow column beside the
          paragraph on a phone — the device this screen is most used on. */}
      <header style={{ marginBottom: 12, display: "block" }}>
        <h2 style={{ margin: 0 }}>Teach this form</h2>
        <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 14 }}>
          Drag a box <strong>close around</strong> each element below — just outside its edges. The
          exact edges are then measured from the paper, not from your box, so a few millimetres out
          is fine. A box drawn far too wide cannot be used, and will say so.
        </p>
      </header>

      <label style={{ display: "block", marginBottom: 12 }}>
        <span style={{ display: "block", fontSize: 13, marginBottom: 4 }}>Form name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. JNV Study Certificate"
          maxLength={120}
          style={{
            width: "100%",
            maxWidth: 380,
            padding: "8px 10px",
            font: "inherit",
            border: "1px solid var(--line, #d8d4cc)",
            borderRadius: 8,
            background: "var(--card, #fff)",
            color: "inherit",
          }}
        />
      </label>

      <div className="actions" style={{ justifyContent: "flex-start", marginBottom: 12, flexWrap: "wrap" }}>
        {ELEMENTS.map((element) => (
          <button
            key={element.type}
            type="button"
            className={`button${active === element.type ? "" : " secondary"}`}
            onClick={() => setActive(element.type)}
            aria-pressed={active === element.type}
          >
            {boxes[element.type] ? "✓ " : ""}
            {element.label}
          </button>
        ))}
        <button
          type="button"
          className={`button${active === "text" ? "" : " secondary"}`}
          onClick={() => setActive("text")}
          aria-pressed={active === "text"}
        >
          {textFields.length > 0 ? `✓ ${textFields.length} ` : "+ "}Text field
        </button>
      </div>

      <p style={{ margin: "0 0 10px", fontSize: 13, color: "var(--muted)" }}>
        {active === "text" ? (
          <>
            Drag a box around <strong>one handwritten answer area</strong> — the space where the
            value is written, not its printed label — then name it. Add as many as the form has.
            They are read by the AI reader when a key is configured.
          </>
        ) : (
          <>
            Now drag a box closely around <strong>{ELEMENTS.find((e) => e.type === active)?.hint}</strong>.
            Not on the form? Skip it — only the boxes you draw are extracted.
          </>
        )}
      </p>

      {pendingBox ? (
        <div
          className="actions"
          style={{ justifyContent: "flex-start", marginBottom: 10, flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <input
            type="text"
            value={pendingLabel}
            onChange={(event) => setPendingLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addTextField();
            }}
            placeholder='Label as printed, e.g. "Mobile Number"'
            maxLength={60}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            style={{
              padding: "8px 10px",
              font: "inherit",
              border: "1px solid var(--line, #d8d4cc)",
              borderRadius: 8,
              background: "var(--card, #fff)",
              color: "inherit",
              minWidth: 220,
            }}
            aria-label="Field label"
          />
          <select
            value={pendingType}
            onChange={(event) => setPendingType(event.target.value as DrawnTextType)}
            aria-label="Answer type"
            style={{
              padding: "8px 10px",
              font: "inherit",
              border: "1px solid var(--line, #d8d4cc)",
              borderRadius: 8,
              background: "var(--card, #fff)",
              color: "inherit",
            }}
          >
            {DRAWN_TEXT_TYPES.map((type) => (
              <option key={type} value={type}>
                {TEXT_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            onClick={addTextField}
            disabled={!pendingLabel.trim() || duplicateLabel || atRegionLimit}
          >
            Add field
          </button>
          <button
            type="button"
            className="button secondary"
            onClick={() => {
              setPendingBox(null);
              setPendingLabel("");
            }}
          >
            Discard box
          </button>
          {duplicateLabel ? (
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              A field with this label already exists.
            </span>
          ) : atRegionLimit ? (
            <span style={{ fontSize: 13, color: "var(--muted)" }}>
              A form may declare at most {MAX_REGIONS} regions.
            </span>
          ) : null}
        </div>
      ) : null}

      <div
        ref={surface}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        style={{
          position: "relative",
          // Without this a touch drag scrolls the page instead of drawing, which
          // makes the editor unusable on the device most staff will hold.
          touchAction: "none",
          cursor: "crosshair",
          userSelect: "none",
          border: "1px solid var(--line, #d8d4cc)",
          borderRadius: 10,
          overflow: "hidden",
          maxWidth: 560,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={pageDataUrl}
          alt="The form, aligned to the page. Drag to mark each element."
          draggable={false}
          style={{ display: "block", width: "100%", pointerEvents: "none" }}
        />

        {drawn.map((box) => (
          <span
            key={box.type}
            style={{
              position: "absolute",
              left: `${(box.box.xMM / pageMM.widthMM) * 100}%`,
              top: `${(box.box.yMM / pageMM.heightMM) * 100}%`,
              width: `${(box.box.widthMM / pageMM.widthMM) * 100}%`,
              height: `${(box.box.heightMM / pageMM.heightMM) * 100}%`,
              border: "2px solid #1f7a5a",
              background: "rgba(31,122,90,0.12)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: -2,
                left: -2,
                background: "#1f7a5a",
                color: "#fff",
                fontSize: 11,
                padding: "1px 5px",
                borderRadius: "4px 0 4px 0",
                whiteSpace: "nowrap",
              }}
            >
              {ELEMENTS.find((e) => e.type === box.type)?.label}
            </span>
          </span>
        ))}

        {textFields.map((field) => (
          <span
            key={field.label}
            style={{
              position: "absolute",
              left: `${(field.box.xMM / pageMM.widthMM) * 100}%`,
              top: `${(field.box.yMM / pageMM.heightMM) * 100}%`,
              width: `${(field.box.widthMM / pageMM.widthMM) * 100}%`,
              height: `${(field.box.heightMM / pageMM.heightMM) * 100}%`,
              border: "2px dashed #1d4ed8",
              background: "rgba(29,78,216,0.08)",
              pointerEvents: "none",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: -2,
                left: -2,
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                background: "#1d4ed8",
                color: "#fff",
                fontSize: 11,
                padding: "1px 5px",
                borderRadius: "4px 0 4px 0",
                whiteSpace: "nowrap",
                // The one interactive part of an otherwise inert overlay: the
                // remove button must be clickable through the drawing surface.
                pointerEvents: "auto",
              }}
            >
              {field.label}
              <button
                type="button"
                aria-label={`Remove the ${field.label} field`}
                onClick={() => setTextFields((current) => current.filter((f) => f.label !== field.label))}
                onPointerDown={(event) => event.stopPropagation()}
                style={{
                  border: "none",
                  background: "transparent",
                  color: "#fff",
                  cursor: "pointer",
                  font: "inherit",
                  padding: 0,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </span>
          </span>
        ))}

        {pendingBox ? (
          <span
            style={{
              position: "absolute",
              left: `${(pendingBox.xMM / pageMM.widthMM) * 100}%`,
              top: `${(pendingBox.yMM / pageMM.heightMM) * 100}%`,
              width: `${(pendingBox.widthMM / pageMM.widthMM) * 100}%`,
              height: `${(pendingBox.heightMM / pageMM.heightMM) * 100}%`,
              border: "2px dashed #1d4ed8",
              background: "rgba(29,78,216,0.14)",
              pointerEvents: "none",
            }}
          />
        ) : null}

        {drag ? (
          <span
            style={{
              position: "absolute",
              left: `${Math.min(drag.x0, drag.x1) * 100}%`,
              top: `${Math.min(drag.y0, drag.y1) * 100}%`,
              width: `${Math.abs(drag.x1 - drag.x0) * 100}%`,
              height: `${Math.abs(drag.y1 - drag.y0) * 100}%`,
              border: "2px dashed #c2410c",
              background: "rgba(194,65,12,0.10)",
              pointerEvents: "none",
            }}
          />
        ) : null}
      </div>

      <div className="actions" style={{ justifyContent: "flex-start", marginTop: 16, flexWrap: "wrap" }}>
        <button
          className="button"
          type="button"
          disabled={!canSave}
          onClick={() =>
            onSave({
              name: name.trim(),
              page: "A4",
              fields: drawn,
              textFields,
            })
          }
        >
          {saveLabel ?? "Save and read this form"}
        </button>
        {drawn.length > 0 || textFields.length > 0 ? (
          <button
            className="button secondary"
            type="button"
            onClick={() => {
              setBoxes({});
              setTextFields([]);
              setPendingBox(null);
              setPendingLabel("");
            }}
          >
            Clear boxes
          </button>
        ) : null}
        <button className="button secondary" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      {!canSave ? (
        <p style={{ marginTop: 10, fontSize: 13, color: "var(--muted)" }}>
          {pendingBox
            ? "Add or discard the pending text field"
            : drawn.length === 0 && textFields.length === 0
              ? "Draw at least one box"
              : "Give the form a name"}{" "}
          to save it.
        </p>
      ) : null}
    </div>
  );
}
