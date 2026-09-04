import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectPhoto } from "../lib/regions/photo.ts";
import type { Rect } from "../lib/vision/types.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * What a detector is allowed to CLAIM when it has been pointed somewhere wrong.
 *
 * Registration will sometimes be wrong — a fold, a shadow, a form that is not
 * the template. When it is, a detector is looking at a patch of page nobody
 * meant it to look at, and the only safe behaviour is to make a SMALL claim.
 * These tests pin the place where the code made a large one.
 *
 * The failure was observed on the deployed product, on a real certificate
 * whose page had been mis-rectified: a photograph plainly present on the paper
 * reported as "the box was located and is empty".
 */

const PX_PER_MM = 150 / 25.4;
const PASSPORT = { widthMM: 35, heightMM: 45 };

// ---------------------------------------------------------------------------
// Photograph: emptiness may only be asserted from a boundary that was found
// ---------------------------------------------------------------------------

test("a photo box whose edges cannot be measured is never called empty", () => {
  // Point the detector at dense printed body text, which is what a displaced
  // template prior lands on. No side carries a sustained step, so the boundary
  // cannot be fitted -- and that is precisely the state in which the old code
  // called `assessEmptiness` on the PRIOR RECTANGLE and promoted its refusal to
  // "the photo box was located and is empty".
  const { rgb } = renderSyntheticForm({ withPhoto: false });
  const displaced: Rect = { x: 120, y: 300, width: 213, height: 272 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [displaced] });

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected: displaced,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  assert.equal(detection.found, false);
  if (detection.found) return;

  if (detection.failedClause === "boundary") {
    // THE ASSERTION. A refusal must not simultaneously report that the outline
    // could not be measured and that the box was located.
    assert.notEqual(
      detection.reason,
      "box_empty",
      "an unmeasurable boundary cannot support a claim that the box is empty",
    );
    assert.doesNotMatch(
      detection.detail ?? "",
      /located and is empty/,
      "the wording must not claim location when none was established",
    );
  }
});

test("a genuinely empty printed photo box is still confidently reported empty", () => {
  // The other direction, and the one that matters commercially: this is the
  // product demo. The box is present, its four printed edges ARE measurable, so
  // the strong claim is earned and must survive.
  const { rgb, truth } = renderSyntheticForm({ withPhoto: false });
  void truth;
  const box: Rect = { x: 943 - 3, y: 176 - 3, width: 213, height: 272 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [box] });

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected: box,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  assert.equal(detection.found, false);
  if (detection.found) return;
  assert.equal(detection.reason, "box_empty", "the empty-box demo must keep its confident refusal");
});
