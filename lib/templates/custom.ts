/**
 * Templates taught by a person, and the validation that lets one be trusted.
 *
 * WHY THIS EXISTS. The extraction engine is good — the test suite says so — and it
 * fails on a real user's form for exactly one reason: it is measuring that form
 * against coordinates belonging to a different one. The engine does not need to
 * be smarter. It needs to be told where things are.
 *
 * So a person drags three boxes over a photograph of their own form, once, and
 * every later scan of that form works. That is the spec's Approach B reduced to
 * the part that carries the value (spec §4.2: "The main part is passport-size
 * photograph and signature extraction"), and it needs no model, no API key and
 * no per-scan cost.
 *
 * THE BOXES ARE NOT REGISTRATION. A dragged box is accurate to a few
 * millimetres where a homography is accurate to a fraction of one, and the
 * photo detector must be told which kind it is holding — hence `origin:
 * "drawn"` on every field built here. Measured, the registered prior refuses a
 * box 4 mm out; the drawn prior recovers one 6 mm out at IoU 0.988.
 *
 * ============================ TRUST BOUNDARY ============================
 *
 * A template arrives from the BROWSER, so it is untrusted input, and every
 * field below is attacker-controlled. Two things are at stake and only one of
 * them is obvious.
 *
 * The obvious one is resource exhaustion: a box declared 10 000 mm wide, or a
 * template with 100 000 fields, turns one request into an out-of-memory kill on
 * a shared serverless function.
 *
 * The subtler one is that these coordinates decide WHERE A CROP IS CUT. This
 * endpoint returns crops of the uploaded image, so a template is a request to
 * read a chosen region of the very bytes the caller just supplied. That is not
 * a data-exfiltration path — the caller cannot learn anything it did not
 * already send — but it does mean coordinates must be clamped to the page
 * rather than trusted, so no arithmetic downstream can be pushed out of range.
 *
 * So: parse, do not cast. Nothing here is `as FormTemplate`.
 */

import { A4, PAGE_SIZES, type PageSizeMM, type RectMM } from "../geometry/frames.ts";
import { DRAWN_TEXT_TYPES, type DrawnTextType } from "./drawn.ts";
import { isImageField, type FieldType, type FormField, type FormTemplate } from "./types.ts";

/** Bounds. Generous for real forms, far below anything that threatens the function. */
const MAX_FIELDS = 40;
const MAX_NAME_LENGTH = 120;
const MAX_LABEL_LENGTH = 60;
const MIN_BOX_MM = 4;

export class TemplateError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
  }
}

/** The three image types a taught template may declare. Text fields arrive separately, with a label and a type. */
const DRAWABLE: readonly FieldType[] = ["photograph", "signature", "thumbImpression"];

const LABELS: Readonly<Record<string, string>> = {
  photograph: "Patient Photograph",
  signature: "Patient Signature",
  thumbImpression: "Thumb Impression",
};

/**
 * Parses and validates a template supplied by the browser.
 *
 * Throws `TemplateError` with an operator-readable message rather than
 * returning null, because every failure here has a specific cause the person
 * who drew the boxes can act on.
 */
export function parseCustomTemplate(raw: unknown): FormTemplate {
  if (typeof raw !== "object" || raw === null) {
    throw new TemplateError("The form layout could not be read.", "template_invalid");
  }
  const source = raw as Record<string, unknown>;

  const name = typeof source.name === "string" && source.name.trim() ? source.name.trim() : "Untitled form";
  if (name.length > MAX_NAME_LENGTH) {
    throw new TemplateError("That form name is too long.", "template_name_too_long");
  }

  const page = parsePage(source.page);

  if (!Array.isArray(source.fields)) {
    throw new TemplateError("The form layout has no fields.", "template_no_fields");
  }
  if (source.fields.length > MAX_FIELDS) {
    throw new TemplateError(`A form may declare at most ${MAX_FIELDS} regions.`, "template_too_many_fields");
  }

  const fields: FormField[] = [];
  const seen = new Set<string>();

  for (const entry of source.fields) {
    const field = parseField(entry, page);
    // One box per element. Two "Patient Photograph" boxes is not a richer
    // template, it is an ambiguity the verify screen cannot present.
    if (seen.has(field.type)) {
      throw new TemplateError(`This form declares two ${LABELS[field.type] ?? field.type} boxes.`, "template_duplicate_field");
    }
    seen.add(field.type);
    fields.push(field);
  }

  const textFields = parseTextFields(source.textFields, page);
  if (fields.length + textFields.length > MAX_FIELDS) {
    throw new TemplateError(`A form may declare at most ${MAX_FIELDS} regions.`, "template_too_many_fields");
  }
  // A form with only text fields is legitimate — plenty of real forms have no
  // photo, signature or thumb box. What is not legitimate is nothing at all.
  if (fields.length + textFields.length === 0) {
    throw new TemplateError("Draw at least one box before saving this form.", "template_no_fields");
  }

  return {
    id: `custom-${hash(name)}`,
    name,
    page,
    hasGeometry: true,
    sections: [{ id: "drawn", title: "Documents", fields: [...textFields, ...fields] }],
  };
}

/**
 * The drawn TEXT fields, validated to the same standard as the boxes.
 *
 * The label deserves particular suspicion: it is quoted verbatim into the
 * prompt the handwriting reader sends (`lib/reader/prompt.ts`), so it is a
 * browser-supplied string headed for a model. The cap and the control-char
 * strip bound it; what remains is, at absolute worst, a label that reads like
 * an instruction — and the reader's own contract treats even the handwriting
 * as content, so a hostile label buys nothing a hostile pen stroke does not.
 */
function parseTextFields(raw: unknown, page: PageSizeMM): FormField[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new TemplateError("The form layout's text fields could not be read.", "template_bad_text_fields");
  }
  // Bounded BEFORE any per-entry work, exactly as `source.fields` is: the
  // label dedupe below is quadratic in the worst case, and an unauthenticated
  // request must not get to choose how much CPU that costs.
  if (raw.length > MAX_FIELDS) {
    throw new TemplateError(`A form may declare at most ${MAX_FIELDS} regions.`, "template_too_many_fields");
  }

  const fields: FormField[] = [];
  const seenLabels = new Set<string>();
  const seenKeys = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      throw new TemplateError("One of the drawn text fields could not be read.", "template_bad_text_field");
    }
    const source = entry as Record<string, unknown>;

    const label =
      typeof source.label === "string"
        ? // eslint-disable-next-line no-control-regex
          source.label.replace(/[\u0000-\u001F\u007F]/g, "").replace(/\s+/g, " ").trim()
        : "";
    if (!label) {
      throw new TemplateError("A drawn text field needs a label.", "template_text_field_no_label");
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw new TemplateError(`A field label may be at most ${MAX_LABEL_LENGTH} characters.`, "template_label_too_long");
    }
    const labelKey = label.toLowerCase();
    if (seenLabels.has(labelKey)) {
      // Two fields with one name is an ambiguity the verify screen cannot
      // present — the operator could not say which value belongs where.
      throw new TemplateError(`This form declares two fields labelled "${label}".`, "template_duplicate_label");
    }
    seenLabels.add(labelKey);

    const textType = source.textType;
    if (typeof textType !== "string" || !(DRAWN_TEXT_TYPES as readonly string[]).includes(textType)) {
      throw new TemplateError(`The field "${label}" has an unknown answer type.`, "template_bad_text_type");
    }

    const box = parseBox(source.box, page);

    // A stable machine key from the label; the model never sees it, so it only
    // has to be a unique identifier, not a faithful one.
    let key = labelKey.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field";
    while (seenKeys.has(key)) key = `${key}_`;
    seenKeys.add(key);

    fields.push({
      id: `drawn-text-${key}`,
      key,
      label,
      type: textType as DrawnTextType,
      box,
      origin: "drawn",
    });
  }

  return fields;
}

function parsePage(raw: unknown): PageSizeMM {
  if (typeof raw !== "string") return A4;
  const known = (PAGE_SIZES as Record<string, PageSizeMM | undefined>)[raw];
  if (!known) {
    throw new TemplateError(`Unknown page size "${raw}".`, "template_bad_page");
  }
  return known;
}

function parseField(raw: unknown, page: PageSizeMM): FormField {
  if (typeof raw !== "object" || raw === null) {
    throw new TemplateError("One of the drawn regions could not be read.", "template_bad_field");
  }
  const source = raw as Record<string, unknown>;

  const type = source.type;
  if (typeof type !== "string" || !DRAWABLE.includes(type as FieldType)) {
    throw new TemplateError(
      "A drawn region must be a photograph, a signature or a thumb impression.",
      "template_bad_field_type",
    );
  }
  const fieldType = type as FieldType;
  // Belt and braces: `DRAWABLE` and `isImageField` are maintained separately,
  // and a text field reaching the image path would address a detector that
  // cannot answer for it.
  if (!isImageField(fieldType)) {
    throw new TemplateError("That region type cannot be extracted as an image.", "template_bad_field_type");
  }

  const box = parseBox(source.box, page);

  return {
    id: `drawn-${fieldType}`,
    key: fieldType === "photograph" ? "patientPhotograph" : fieldType === "signature" ? "patientSignature" : "thumbImpression",
    label: LABELS[fieldType] ?? fieldType,
    type: fieldType,
    box,
    // The whole point: this geometry came from a finger, and the detector must
    // widen its prior accordingly or it will refuse boxes that are perfectly
    // usable.
    origin: "drawn",
    ...(fieldType === "photograph" ? { photoSize: "passport35x45" as const } : {}),
  };
}

/**
 * Validates one rectangle, in millimetres, and CLAMPS it to the page.
 *
 * Clamped rather than rejected when it overhangs: a person drawing near the
 * edge of the sheet will routinely overshoot by a millimetre or two, and
 * refusing that is a worse product than trimming it. Rejection is reserved for
 * boxes that are not rectangles at all.
 */
function parseBox(raw: unknown, page: PageSizeMM): RectMM {
  if (typeof raw !== "object" || raw === null) {
    throw new TemplateError("A drawn region has no position.", "template_bad_box");
  }
  const source = raw as Record<string, unknown>;

  const xMM = finite(source.xMM, "xMM");
  const yMM = finite(source.yMM, "yMM");
  const widthMM = finite(source.widthMM, "widthMM");
  const heightMM = finite(source.heightMM, "heightMM");

  if (widthMM < MIN_BOX_MM || heightMM < MIN_BOX_MM) {
    throw new TemplateError(
      `A drawn region must be at least ${MIN_BOX_MM} mm on each side — that one is ${widthMM.toFixed(0)}x${heightMM.toFixed(0)} mm.`,
      "template_box_too_small",
    );
  }

  const x = clamp(xMM, 0, page.widthMM);
  const y = clamp(yMM, 0, page.heightMM);
  const width = clamp(widthMM, MIN_BOX_MM, page.widthMM - x);
  const height = clamp(heightMM, MIN_BOX_MM, page.heightMM - y);

  if (width < MIN_BOX_MM || height < MIN_BOX_MM) {
    throw new TemplateError("A drawn region falls outside the page.", "template_box_off_page");
  }

  return { xMM: x, yMM: y, widthMM: width, heightMM: height };
}

/**
 * A finite number, or a refusal.
 *
 * NaN and Infinity are the interesting cases and they are why this is a
 * function rather than a `typeof === "number"` check. `JSON.parse` will not
 * produce them, but a hand-built body can, and NaN propagates silently through
 * every comparison that follows: `NaN < MIN` is false, so a NaN width would
 * pass a naive floor check and then index a summed-area table with a
 * non-integer, which this codebase has already been bitten by once.
 */
function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TemplateError(`A drawn region has an invalid ${field}.`, "template_bad_box");
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Stable id from the name. Not security-relevant — it only has to be a valid identifier. */
function hash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
