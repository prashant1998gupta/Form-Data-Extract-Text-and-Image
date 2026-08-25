/**
 * Is this page actually the form the template describes?
 *
 * THE GAP THIS CLOSES. `form-presence.ts` asks "is this a printed form at all",
 * which a school certificate, a bank mandate and a takeaway menu all answer
 * yes to. It was never able to catch the failure that actually reached a user:
 * a different form measured against the hospital template's coordinates, where
 * the signature box lands on a table of handwritten entries and the detector
 * faithfully reports the handwriting it was pointed at. Presence was
 * established; IDENTITY never was.
 *
 * WHAT IS CHECKED, AND WHY IT NEEDS NO REFERENCE RENDER. The template already
 * declares where its PRINTED furniture is: `printedBorder` rectangles around
 * the photo and thumb boxes, and `baselineMM` for the signature rule. Those are
 * assertions about ink that must be on the paper of any genuine copy of this
 * form, blank or filled. So the test is simply: go and look. If the template
 * says there is a printed rectangle at 160.2 mm, 30.3 mm and there is no ink
 * there, this is not that form — and no coordinate derived from the template
 * means anything on this page.
 *
 * `extractRules` already describes printed rules as "a stable skeleton that
 * survives being written on, which makes them excellent registration anchors —
 * far more reliable than text, which changes on every filled copy". This is
 * that idea, cashed in.
 *
 * WHAT THIS IS NOT. It is not the anchor-atlas registration of
 * `docs/02-architecture.md` Stage 4, which mines many anchors from a stored
 * reference render and solves for a homography. It cannot correct a
 * misalignment; it can only notice one. That is enough for the decision it
 * gates, which is binary: may template coordinates be trusted on this page?
 *
 * THE ASYMMETRY THIS ENABLES, which is the whole point. A POSITIVE claim —
 * "there is a pasted photograph here" — is about pixels that were examined and
 * survives without knowing what form this is. A NEGATIVE claim — "the photo box
 * is empty" — is about a LOCATION, and is meaningless unless the location is
 * known. So when anchors do not verify, the pipeline may still look, but it may
 * no longer assert absence, and it may no longer attach a field's name to what
 * it finds.
 */

import { allFields, type FormTemplate } from "../templates/types.ts";
import type { RectMM } from "../geometry/frames.ts";
import type { Mask, Rect } from "../vision/types.ts";

export interface AnchorReport {
  /** The field whose declared furniture this is. */
  readonly key: string;
  readonly kind: "printedBorder" | "baseline";
  readonly found: boolean;
  /** 0..1 — the fraction of the declared outline that carries ink. */
  readonly support: number;
}

export interface TemplateRegistration {
  /** Whether template coordinates may be trusted on this page. */
  readonly registered: boolean;
  readonly anchorsFound: number;
  readonly anchorsChecked: number;
  readonly reports: readonly AnchorReport[];
  /** Plain-language account, shown to the operator on a refusal. */
  readonly detail: string;
}

/**
 * Registration error this tolerates, in millimetres.
 *
 * Generous on purpose. The page warp is derived from the sheet's outline, so a
 * few millimetres of drift is normal on a handheld capture and is exactly the
 * error the detectors are built to absorb. This gate is looking for a form that
 * is WRONG, not one that is slightly off, and the two are separated by tens of
 * millimetres rather than by two.
 */
const TOLERANCE_MM = 3;

/** A declared edge counts as present when this much of its length carries ink. */
const SIDE_SUPPORT = 0.55;

/** A declared rectangle counts as present when at least this many sides are. */
const SIDES_FOR_BORDER = 3;

/**
 * How much of the declared furniture must be found.
 *
 * A fraction rather than a count, because a template may declare any number of
 * anchors — the seeded hospital form declares three, a richer one would declare
 * more. Two of three passes; one of three does not.
 */
const REGISTERED_FRACTION = 0.6;

export interface AnchorOptions {
  /**
   * Ink INCLUDING printed rules — `ScanChannels.inkWithRules`. The speckle-
   * filtered `ink` mask has had the rules removed, which is precisely the
   * furniture being looked for here.
   */
  readonly inkWithRules: Mask;
  readonly template: FormTemplate;
  readonly pxPerMM: number;
}

export function verifyTemplateAnchors(options: AnchorOptions): TemplateRegistration {
  const { inkWithRules, template, pxPerMM } = options;
  const tolerance = Math.max(2, Math.round(TOLERANCE_MM * pxPerMM));
  const reports: AnchorReport[] = [];

  for (const field of allFields(template)) {
    if (field.printedBorder) {
      const rect = toPixels(field.printedBorder, pxPerMM);
      const sides = [
        // top, bottom, left, right — each as a segment plus its scan axis.
        segmentSupport(inkWithRules, rect.x, rect.y, rect.x + rect.width, rect.y, "vertical", tolerance),
        segmentSupport(inkWithRules, rect.x, rect.y + rect.height, rect.x + rect.width, rect.y + rect.height, "vertical", tolerance),
        segmentSupport(inkWithRules, rect.x, rect.y, rect.x, rect.y + rect.height, "horizontal", tolerance),
        segmentSupport(inkWithRules, rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + rect.height, "horizontal", tolerance),
      ];
      const present = sides.filter((s) => s >= SIDE_SUPPORT).length;
      reports.push({
        key: field.key,
        kind: "printedBorder",
        found: present >= SIDES_FOR_BORDER,
        support: present / 4,
      });
    }

    if (field.baselineMM !== undefined && field.box) {
      // The printed rule a signature is written on. Declared as a y in
      // millimetres, spanning the field's own box.
      const box = toPixels(field.box, pxPerMM);
      const y = Math.round(field.baselineMM * pxPerMM);
      const support = segmentSupport(inkWithRules, box.x, y, box.x + box.width, y, "vertical", tolerance);
      reports.push({
        key: field.key,
        kind: "baseline",
        found: support >= SIDE_SUPPORT,
        support,
      });
    }
  }

  const checked = reports.length;
  const found = reports.filter((r) => r.found).length;

  // A template that declares no printed furniture cannot be verified this way.
  // Saying "unregistered" would refuse every such form outright; saying
  // "registered" would assert something never measured. The honest answer is
  // that this gate has no opinion, and the caller keeps its previous behaviour.
  if (checked === 0) {
    return {
      registered: true,
      anchorsFound: 0,
      anchorsChecked: 0,
      reports,
      detail: "this template declares no printed landmarks, so its alignment could not be checked",
    };
  }

  const registered = found / checked >= REGISTERED_FRACTION;
  const missing = reports.filter((r) => !r.found).map((r) => describe(r));

  return {
    registered,
    anchorsFound: found,
    anchorsChecked: checked,
    reports,
    detail: registered
      ? `${found} of ${checked} of this form's printed landmarks were found where the template expects them`
      : `only ${found} of ${checked} of this form's printed landmarks are where the template expects them — ${missing.join("; ")}`,
  };
}

/**
 * Millimetres to pixels at the CALLER'S resolution.
 *
 * Not `mmToCts`. That helper always converts at the Canonical Template Space's
 * fixed 7.874 px/mm, which is correct only when the mask being searched is the
 * rectified CTS raster. This function accepts a `pxPerMM` and must honour it —
 * using the constant instead silently misplaced every landmark by the ratio
 * between the two resolutions, which a test at 150 dpi caught as two of three
 * landmarks vanishing from a form that plainly has them.
 */
function toPixels(rect: RectMM, pxPerMM: number): Rect {
  return {
    x: Math.round(rect.xMM * pxPerMM),
    y: Math.round(rect.yMM * pxPerMM),
    width: Math.round(rect.widthMM * pxPerMM),
    height: Math.round(rect.heightMM * pxPerMM),
  };
}

function describe(report: AnchorReport): string {
  return report.kind === "baseline"
    ? `no printed rule under ${report.key}`
    : `no printed box around ${report.key}`;
}

/**
 * What fraction of a declared straight segment carries ink within `tolerance`.
 *
 * `scan` is the direction to search for the line, PERPENDICULAR to it: a
 * horizontal rule may sit a little above or below where the template says, so
 * the search runs vertically. Sampling only the exact declared pixel row would
 * make this a test of registration precision rather than of the form's
 * identity, and would fail on every real capture.
 */
function segmentSupport(
  mask: Mask,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  scan: "horizontal" | "vertical",
  tolerance: number,
): number {
  const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0)));
  let hits = 0;
  let sampled = 0;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const px = Math.round(x0 + (x1 - x0) * t);
    const py = Math.round(y0 + (y1 - y0) * t);

    let hit = false;
    for (let d = -tolerance; d <= tolerance && !hit; d += 1) {
      const sx = scan === "horizontal" ? px + d : px;
      const sy = scan === "vertical" ? py + d : py;
      if (sx < 0 || sy < 0 || sx >= mask.width || sy >= mask.height) continue;
      if (mask.data[sy * mask.width + sx] !== 0) hit = true;
    }

    // Samples that fall entirely outside the raster are not evidence either
    // way, so they are excluded rather than counted as misses — a field near
    // the page edge would otherwise be unverifiable by construction.
    if (px >= -tolerance && py >= -tolerance && px < mask.width + tolerance && py < mask.height + tolerance) {
      sampled += 1;
      if (hit) hits += 1;
    }
  }

  return sampled === 0 ? 0 : hits / sampled;
}
