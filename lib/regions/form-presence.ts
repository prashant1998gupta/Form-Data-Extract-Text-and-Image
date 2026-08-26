/**
 * Is this page the printed form at all?
 *
 * WHY THIS IS NECESSARY, in one measured example. Posting a plain blue
 * rectangle — no paper, no print, no form — to the running deployment returned:
 *
 *   page:  method "full-frame", confidence 0.9, "page fills the frame and is square"
 *   photo: Not Detected — "the photo box was located and is empty"
 *   sig:   Not Detected — "the signature area contains no ink"
 *   thumb: Not Detected — "the thumb box contains no ink"
 *
 * Every one of those sentences is a lie about a page that does not exist. The
 * detectors were not wrong: addressed at 160.2 mm, 30.3 mm of a blue rectangle
 * there is indeed no photograph. They were asked the wrong question, because
 * nothing upstream ever established that the coordinates meant anything.
 *
 * That matters more here than the missing crop would. This product's entire
 * claim is that "Not Detected" is an ASSERTED CONCLUSION with a stated reason,
 * never a shrug — which is what makes it safe for staff to trust a refusal and
 * move on. "The box was located and is empty" said about a page with no box on
 * it spends exactly that trust. A refusal that is confidently wrong is the same
 * failure as a crop that is confidently wrong, one step earlier.
 *
 * WHAT IS ACTUALLY CHECKED. Not identity — this does not verify that the page
 * is THE hospital form rather than some other form. Full identity needs a
 * stored reference render and the anchor matching of
 * `docs/02-architecture.md` Stage 4, which is not built. A WEAKER identity check
 * is: `template-anchors.ts` verifies that the template's own declared printed
 * landmarks are where it says they are, needs no reference render, and runs
 * immediately after this gate. This module answers only the prior question. It checks the far weaker, far cheaper claim that the page
 * carries PRINTED STRUCTURE: lines of set type, or long printed rules. That is
 * enough to separate a form from a wall, a hand, a blank sheet or a screenshot,
 * which is the failure actually reachable from the upload button.
 *
 * SO THE BAR IS DELIBERATELY ON THE FLOOR. Three lines of type or three rules.
 * Every printed form clears it, including a faint photocopy of one; a wrong
 * refusal here would reject a real patient's real form, which is far worse than
 * the confident-wrong-refusal this exists to prevent. The unfilled sample form
 * must still pass and still report three honest empty boxes — that case is the
 * product, and this gate must not touch it.
 */

import { printedTextRuns } from "../ink/text-lines.ts";
import { connectedComponents } from "../vision/components.ts";
import type { Mask } from "../vision/types.ts";

export interface FormPresenceOptions {
  /** Ink with printed rules removed and speckle filtered — `ScanChannels.ink`. */
  readonly ink: Mask;
  /** The long printed runs that were removed — `ScanChannels.rules`. */
  readonly rules: Mask;
  readonly pxPerMM: number;
}

export interface FormPresence {
  /** Whether the page carries enough printed structure to address by template. */
  readonly recognised: boolean;
  /** Plain-language account of what was measured. Shown to the operator on a refusal. */
  readonly detail: string;
  readonly textLines: number;
  readonly rules: number;
}

/**
 * Thresholds.
 *
 * Counts rather than fractions, because the question is structural. A fraction
 * of set pixels says nothing useful: a photocopy's rules are three times as
 * thick as a laser print's and a page's ink coverage varies by an order of
 * magnitude with how much was written on it, while "there are at least three
 * lines of type on this page" is the same claim on every capture of every form.
 */
const MIN_TEXT_LINES = 3;
const MIN_RULES = 3;

/**
 * Form labels are larger than the captions `printedCaptionLabels` hunts.
 *
 * "Patient Name" on a registration form is set at 3-4 mm, where the 2.5 mm cap
 * used for caption REMOVAL is deliberately tight — deleting a hand-printed name
 * by mistake is a serious error, so that path only takes what is unambiguously
 * small type. Nothing is deleted here, so the bound can be relaxed to cover the
 * body type a form is actually labelled in.
 */
const LABEL_GLYPH_HEIGHT_MM = 5;
const LABEL_GLYPH_WIDTH_MM = 6;

/** A printed rule survives `extractRules` as a long thin run; below this it is speckle. */
const MIN_RULE_AREA_MM2 = 3;

export function assessFormPresence(options: FormPresenceOptions): FormPresence {
  const { ink, rules, pxPerMM } = options;

  const glyphMinArea = Math.max(2, Math.round(0.15 * pxPerMM * pxPerMM));
  const components = connectedComponents(ink, glyphMinArea).components;
  const textLines = printedTextRuns(components, {
    pxPerMM,
    maxGlyphHeightMM: LABEL_GLYPH_HEIGHT_MM,
    maxGlyphWidthMM: LABEL_GLYPH_WIDTH_MM,
    // Four, not the caption path's five: "Age" plus its colon is a short label,
    // and a form's shortest labels are exactly the ones a five-glyph minimum
    // would miss.
    minGlyphs: 4,
    minSpanMM: 8,
  }).length;

  const ruleMinArea = Math.max(4, Math.round(MIN_RULE_AREA_MM2 * pxPerMM * pxPerMM));
  const ruleCount = connectedComponents(rules, ruleMinArea).components.length;

  const recognised = textLines >= MIN_TEXT_LINES || ruleCount >= MIN_RULES;

  return {
    recognised,
    detail: recognised
      ? `${textLines} lines of printed text and ${ruleCount} printed rules were found`
      : describeAbsence(textLines, ruleCount),
    textLines,
    rules: ruleCount,
  };
}

/**
 * The refusal message.
 *
 * Says what was looked for and what was there, because the operator's next
 * action depends on which it is: a page with nothing printed on it is the wrong
 * photograph, while a page with some print is probably the right form badly
 * captured, and those want different responses.
 */
function describeAbsence(textLines: number, ruleCount: number): string {
  if (textLines === 0 && ruleCount === 0) {
    return "no printed text or ruled lines were found anywhere on this image, so it does not appear to be a form";
  }
  return `only ${textLines} line${textLines === 1 ? "" : "s"} of printed text and ${ruleCount} printed rule${ruleCount === 1 ? "" : "s"} were found, which is too little printed structure to locate this form's fields`;
}
