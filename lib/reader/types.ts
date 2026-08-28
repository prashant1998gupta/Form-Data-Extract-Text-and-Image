/**
 * The handwritten-text reader — the half of the product the image pipeline
 * cannot do.
 *
 * Everything else in this repository measures; this module READS, and reading
 * handwriting is the one problem here that genuinely needs a vision model. So
 * the model is held to the narrowest possible contract, stated once here and
 * enforced in code rather than in a prompt:
 *
 *   THE MODEL SUPPLIES VALUES. IT NEVER SUPPLIES GEOMETRY.
 *
 * Which field is being read, and which pixels it is read from, are decided by
 * the template and the registration — deterministically, before any model is
 * addressed. Each field is sent as its own crop in its own request, so a value
 * cannot land under the wrong label by the model miscounting regions: the
 * mapping from answer to field is structural, not the model's opinion.
 *
 * The verify screen then shows the operator EXACTLY the crop the model saw,
 * beside the value it produced. That is the whole trust story: the human
 * reviews the same evidence the machine read, and nothing is a record until a
 * person says so.
 *
 * Three product rules carry over from the image pipeline unchanged:
 *   - Every model-read value requires review. No exceptions, no threshold.
 *   - A value that could not be read is reported as such, with no percentage —
 *     there is no calibrated probability for "I could not read this".
 *   - No number shown anywhere is a model's opinion of itself.
 */

import type { FieldType, FormField, FormTemplate } from "../templates/types.ts";
import { allFields, isImageField } from "../templates/types.ts";

/**
 * Field types the reader can answer for.
 *
 * Everything except the three image types and `document`: a document is a
 * pasted or stapled page, which is a crop, not a transcription.
 */
export function isReadableField(type: FieldType): boolean {
  return type !== "document" && !isImageField(type);
}

/** The text fields extraction should read — declared, readable, and placed. */
export function readableFields(template: FormTemplate): FormField[] {
  return allFields(template).filter((field) => isReadableField(field.type) && field.box);
}

/**
 * One field's reading, exactly as it should reach the verify screen.
 *
 * The `value` / `blank` split is deliberate and asymmetric, mirroring the
 * region detectors' box_empty / below_threshold split:
 *
 *   value: "…", blank: false   — handwriting was read. Review it.
 *   value: "",  blank: true    — the model asserts the area is EMPTY. That is
 *                                a positive claim about examined pixels.
 *   value: null                — something may be there but could not be read
 *                                with fair certainty. A weaker claim, and the
 *                                two must never be conflated: "blank" tells the
 *                                operator nothing is missing, "unread" tells
 *                                them to go and look at the paper.
 */
export interface FieldReading {
  readonly fieldId: string;
  readonly key: string;
  readonly label: string;
  readonly type: FieldType;
  readonly required?: boolean;
  readonly options?: readonly string[];
  readonly hint?: string;
  /** The transcription. `""` only ever appears with `blank: true`. */
  readonly value: string | null;
  readonly blank: boolean;
  /**
   * For dropdown / radio / checkbox: the handwriting did not match any declared
   * option. The raw transcription is kept in `value` — replacing what the
   * paper says with the nearest option would be a guess wearing a value's
   * clothes — and the mismatch is flagged for the operator instead.
   */
  readonly notInOptions?: boolean;
  /**
   * This field's request failed (timeout, rate limit, provider error) — an
   * operational fault, phrased for the operator. Distinct from `value: null`,
   * which is a successful call that reported the handwriting unreadable.
   */
  readonly failure?: string;
  /** JPEG bytes of the exact crop the model was shown. Absent on failure paths that never cropped. */
  readonly evidenceJpeg?: Buffer;
  /** Where that crop was taken, in rectified-page pixels. For the overlay. */
  readonly regionInPage?: { x: number; y: number; width: number; height: number };
}
