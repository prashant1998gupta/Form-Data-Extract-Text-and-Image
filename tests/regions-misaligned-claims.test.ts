import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectPhoto } from "../lib/regions/photo.ts";
import { detectThumb } from "../lib/regions/thumb.ts";
import { REGION_PARAMS } from "../lib/regions/params.ts";
import type { Rect, Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * What a detector is allowed to CLAIM when it has been pointed somewhere wrong.
 *
 * Registration will sometimes be wrong — a fold, a shadow, a form that is not
 * the template. When it is, a detector is looking at a patch of page nobody
 * meant it to look at, and the only safe behaviour is to make a SMALL claim.
 * These tests pin the two places where the code made large ones.
 *
 * Both failures were observed on the deployed product, on a real certificate
 * whose page had been mis-rectified: a photograph plainly present on the paper
 * reported as "the box was located and is empty", and a fragment of printed
 * paragraph delivered under the label "Thumb Impression".
 */

const PX_PER_MM = 150 / 25.4;
const PASSPORT = { widthMM: 35, heightMM: 45 };

/** Paints a filled dark bar — the shape a run of printed text collapses to. */
function paintBar(rgb: Rgb, rect: Rect, tone = 55): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (x < 0 || y < 0 || x >= rgb.width || y >= rgb.height) continue;
      const p = (y * rgb.width + x) * rgb.channels;
      rgb.data[p] = tone;
      rgb.data[p + 1] = tone;
      rgb.data[p + 2] = tone + 10;
    }
  }
}

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

// ---------------------------------------------------------------------------
// Thumb: the shape gate is conjunctive
// ---------------------------------------------------------------------------

test("a mark far wider than tall is refused, not capped to 70%", () => {
  // Aspect ~2.7, the shape a band of printed text collapses to under the
  // detector's 2.5mm closing. The weighted sum alone scored this 0.72 -- above
  // the 0.55 acceptance floor -- and `Math.min(0.72, cap)` then printed exactly
  // 0.70, the SAME number a textbook impression prints. The cap made total
  // shape failure indistinguishable from ordinary uncertainty.
  const { rgb } = renderSyntheticForm({ withThumb: false });
  const roi: Rect = { x: 880, y: 1380, width: 180, height: 220 };
  paintBar(rgb, { x: 900, y: 1440, width: 140, height: 52 });

  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [roi] });
  const detection = detectThumb({ ink: channels.ink, rgb, roi, pxPerMM: PX_PER_MM });

  assert.equal(detection.found, false, "a 2.7:1 bar is not a thumb impression");
});

test("the hard shape bands are wider than the scoring plateaus", () => {
  // The invariant that keeps the conjunctive gate from eating real impressions.
  // A dragged or rolled thumb sits outside the scoring plateau and should lose
  // CONFIDENCE; only a mark outside the hard band loses its crop entirely. If
  // these ever meet, every imperfect impression is refused outright.
  const T = REGION_PARAMS.thumb;
  assert.ok(T.hardAspectRange.min < T.aspectRange.min, "hard aspect floor must sit below the plateau");
  assert.ok(T.hardAspectRange.max > T.aspectRange.max, "hard aspect ceiling must sit above the plateau");
  assert.ok(T.hardFillRange.min < T.fillRange.min, "hard fill floor must sit below the plateau");
  assert.ok(T.hardFillRange.max > T.fillRange.max, "hard fill ceiling must sit above the plateau");
});

test("a real thumb impression still passes the conjunctive gate", () => {
  const { rgb } = renderSyntheticForm({});
  const roi: Rect = { x: 880, y: 1380, width: 180, height: 220 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [roi] });
  const detection = detectThumb({ ink: channels.ink, rgb, roi, pxPerMM: PX_PER_MM });

  assert.equal(detection.found, true, detection.found ? "" : `refused: ${detection.detail}`);
  if (!detection.found) return;
  const { aspect, fillRatio } = detection.features;
  const T = REGION_PARAMS.thumb;
  assert.ok(
    aspect >= T.hardAspectRange.min && aspect <= T.hardAspectRange.max,
    `a real impression must clear the hard aspect band, got ${aspect.toFixed(2)}`,
  );
  assert.ok(
    fillRatio >= T.hardFillRange.min && fillRatio <= T.hardFillRange.max,
    `a real impression must clear the hard fill band, got ${fillRatio.toFixed(2)}`,
  );
});
