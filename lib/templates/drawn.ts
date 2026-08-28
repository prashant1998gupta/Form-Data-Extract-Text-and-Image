/**
 * The wire format for a form taught by drawing.
 *
 * WHY THIS IS ITS OWN MODULE. These types describe the contract between the
 * browser editor that produces a taught template and the server parser that
 * consumes one. They lived inside `app/TemplateEditor.tsx` for one commit, and
 * in that commit the editor emitted a FLAT box — `{ type, xMM, yMM, ... }` —
 * while `parseCustomTemplate` read a NESTED one. Eighteen unit tests passed,
 * because every one of them hand-built the shape the parser wanted rather than
 * the shape the editor actually sent. The two halves met for the first time in
 * a browser, where the server answered "a drawn region has no position" for
 * every save.
 *
 * A contract with two ends belongs in neither end. Both now import it from
 * here, and a test can build exactly what the editor builds — see
 * `tests/templates-custom.test.ts`, which type-checks the payload against
 * `DrawnTemplate` before handing it to the parser, so the compiler catches the
 * next divergence rather than a person clicking Save.
 *
 * `.ts`, not `.tsx`, deliberately: Node's type-stripping test runner cannot
 * parse JSX, so anything a test needs to import must stay clear of it.
 */

import type { PageSizeKey } from "../geometry/frames.ts";

/**
 * The three elements a person can draw. The handwriting reader (`lib/reader/`)
 * exists now, but a drawn text field also needs a label and a type, which the
 * editor does not collect yet — so taught templates stay image-only.
 */
export type DrawnElement = "photograph" | "signature" | "thumbImpression";

export interface DrawnBox {
  readonly type: DrawnElement;
  /**
   * Position on the page, in MILLIMETRES.
   *
   * Nested to match `FormField.box`, which is what the parser reads and what
   * the rest of the template system speaks. Millimetres rather than screen
   * pixels because the drawing surface is the RECTIFIED page: a millimetre is a
   * fixed number of pixels there by construction, so a box drawn on a phone
   * means the same thing on a desktop and on a scan taken next week. Storing
   * display pixels would bind the template to the screen it was drawn on.
   */
  readonly box: {
    readonly xMM: number;
    readonly yMM: number;
    readonly widthMM: number;
    readonly heightMM: number;
  };
}

export interface DrawnTemplate {
  readonly name: string;
  /** Key into `PAGE_SIZES`. Foolscap matters here — much of the target market prints on it. */
  readonly page: PageSizeKey;
  readonly fields: readonly DrawnBox[];
}
