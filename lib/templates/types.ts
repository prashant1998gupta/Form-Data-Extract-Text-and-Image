/**
 * Form templates.
 *
 * A template is the organization's paper form, described once: the page size,
 * the sections, and every writable field with its position in MILLIMETRES on
 * that page. It is what turns "find a photograph somewhere in this image" into
 * "measure the four edges of the rectangle at 160.2 mm, 30.3 mm" — which is a
 * different and far more tractable problem.
 *
 * Positions are optional. A form can be published with no geometry at all, in
 * which case extraction REFUSES that field with `geometry_unknown`, lists its
 * key in `fieldsWithoutGeometry`, and says so on screen. There is no whole-page
 * fallback and no detector runs — an earlier version of this comment promised
 * one, which would be a safety regression if anyone built it on the strength of
 * the comment: a detector searching the whole page has no prior at all, and
 * every refusal it made would be unanchored.
 *
 * Geometry arrives from the admin drawing boxes over the form
 * (`lib/templates/custom.ts`), or later from staff correcting crops.
 *
 * The seventeen field types come from the spec. They are a closed set on
 * purpose: the extraction path branches on them, and a free-text "type" would
 * mean an unhandled branch silently doing nothing.
 */

import type { PageSizeMM, PhotoSizeKey, RectMM } from "../geometry/frames.ts";

export type FieldType =
  | "shortText"
  | "longText"
  | "name"
  | "phone"
  | "email"
  | "number"
  | "date"
  | "age"
  | "address"
  | "dropdown"
  | "checkbox"
  | "radio"
  | "photograph"
  | "signature"
  | "thumbImpression"
  | "document"
  | "custom";

/** The three types that produce a cropped image rather than a value. */
export const IMAGE_FIELD_TYPES = ["photograph", "signature", "thumbImpression"] as const;
export type ImageFieldType = (typeof IMAGE_FIELD_TYPES)[number];

export function isImageField(type: FieldType): type is ImageFieldType {
  return (IMAGE_FIELD_TYPES as readonly string[]).includes(type);
}

/**
 * Fields whose value must never be presented as settled, however high the
 * confidence.
 *
 * These are the ones where a plausible wrong answer causes real harm and where
 * a reader cannot spot the error by eye. A misread blood group is one short
 * stroke — `B+` against `B-` — that a photocopy loses and two independent
 * passes will happily agree on. A wrong phone number is not obviously wrong to
 * anybody checking. So they always show for review, always with the evidence
 * crop beside them.
 */
export const ALWAYS_REVIEW_TYPES: readonly FieldType[] = ["phone", "name"];
export const ALWAYS_REVIEW_KEYS: readonly string[] = [
  "bloodGroup",
  "blood_group",
  "disease",
  "doctor",
  "allergies",
  "aadhaar",
];

export interface FormField {
  readonly id: string;
  /** Stable machine key, e.g. `patientName`. */
  readonly key: string;
  /** What the printed label says, e.g. "Patient Name". */
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  /** Options for dropdown, checkbox and radio. */
  readonly options?: readonly string[];
  /**
   * Where the answer goes on the page, in millimetres. Absent until the
   * template has geometry.
   */
  readonly box?: RectMM;
  /**
   * The pre-printed rectangle a photo or thumb is meant to sit inside, when the
   * form has one. Distinct from `box` because the printed border and the thing
   * pasted over it are different objects, and confusing them is how a detector
   * ends up cropping an empty box.
   */
  readonly printedBorder?: RectMM;
  /** For signature fields: the y of the printed rule, in millimetres. */
  readonly baselineMM?: number;
  /** For photograph fields: the declared physical size. Never guessed. */
  readonly photoSize?: PhotoSizeKey;
  /** Free-text hint shown to staff on the verify screen. */
  readonly hint?: string;
  /**
   * Where this field's geometry came from.
   *
   * `registered` (the default) means the box was mapped through a homography
   * and is accurate to a fraction of a millimetre. `drawn` means a person
   * dragged it, and is accurate to a few millimetres — a different kind of
   * claim, which the photo detector must be told about or it will refuse
   * perfectly good boxes. See `REGION_PARAMS.photo.drawnPrior*`.
   */
  readonly origin?: "registered" | "drawn";
}

export interface FormSection {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly FormField[];
}

export interface FormTemplate {
  readonly id: string;
  readonly name: string;
  readonly page: PageSizeMM;
  readonly sections: readonly FormSection[];
  /**
   * Whether this template carries geometry for its fields. There is NO
   * whole-page fallback — this file's own header says why a detector with no
   * prior would be a safety regression — so a field without a box is refused
   * with `geometry_unknown` and listed in `fieldsWithoutGeometry`, and the UI
   * says so. (An earlier version of this comment promised the fallback the
   * header forbids.) Nothing branches on this flag today; it is carried for
   * the builder, which will publish templates before they have geometry.
   */
  readonly hasGeometry: boolean;
}

/** Every field across all sections, in reading order. */
export function allFields(template: FormTemplate): FormField[] {
  return template.sections.flatMap((section) => section.fields);
}

export function findField(template: FormTemplate, key: string): FormField | undefined {
  return allFields(template).find((field) => field.key === key);
}

/** Image fields only — the ones that produce a crop. */
export function imageFields(template: FormTemplate): FormField[] {
  return allFields(template).filter((field) => isImageField(field.type));
}

/** Whether a field must always be shown for review regardless of confidence. */
export function alwaysReview(field: FormField): boolean {
  return ALWAYS_REVIEW_TYPES.includes(field.type) || ALWAYS_REVIEW_KEYS.includes(field.key);
}
