import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectSignature, type SignatureDetection } from "../lib/regions/signature.ts";
import { containment, iou, type Rect } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * Signature detection against known ground truth.
 *
 * The measure that matters for a signature is NOT IoU against a box. A
 * signature is ink, not a rectangle, and a crop is good when it contains all of
 * the ink and not much else. So the tests assert CONTAINMENT of the true ink
 * extent plus a bound on excess area — a crop that swallows the printed label
 * and the adjacent date fails even if its IoU looks respectable.
 *
 * The negative cases are the point. A detector that finds signatures and also
 * "finds" one in an empty box, or crops the thumb impression into the signature
 * field, is worse than no detector.
 */

const PX_PER_MM = 150 / 25.4;

function detect(options: SyntheticFormOptions, roiOverride?: Rect): { detection: SignatureDetection; truth: Rect | null } {
  const { rgb, truth } = renderSyntheticForm(options);

  // The template's signature box as registration would report it. Generous, as
  // a real one is: signatures habitually overflow their printed box.
  const roi: Rect = roiOverride ?? { x: 96, y: 1330, width: 470, height: 130 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [roi] });

  const detection = detectSignature({
    ink: channels.ink,
    roi,
    pxPerMM: PX_PER_MM,
    baselineY: 1459,
  });

  return { detection, truth: truth.signature };
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test("a signature written across its printed rule is found whole", () => {
  // The rule runs the full width of the box and the signature crosses it. Under
  // naive component analysis the signature merges with the rule and becomes a
  // 470 px wide blob; the rule removal upstream is what prevents that.
  const { detection, truth } = detect({});
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);

  const held = containment(truth!, detection.bounds);
  // 0.95 is the measured level with continuous ink. A flourish crossing its
  // rule is the case that regressed to 0.73 when the printed caption stole the
  // tail, so this number is the guard on that.
  assert.ok(held > 0.95, `only ${(held * 100).toFixed(0)}% of the true signature ink is inside the crop`);
});

test("the crop is tight — it does not swallow the whole search region", () => {
  const { detection, truth } = detect({});
  assert.ok(detection.found);

  const truthArea = truth!.width * truth!.height;
  const cropArea = detection.bounds.width * detection.bounds.height;
  assert.ok(
    cropArea < truthArea * 1.25,
    `crop is ${(cropArea / truthArea).toFixed(2)}x the signature's own extent — it has taken in neighbouring content`,
  );
});

test("a faint photocopied signature is still found", () => {
  const { detection, truth } = detect({ photocopy: true, noise: 0.03 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);
  const held = containment(truth!, detection.bounds);
  assert.ok(held > 0.95, `containment ${held.toFixed(2)} on a photocopy`);
});

test("a shadowed capture does not lose the signature", () => {
  const { detection, truth } = detect({ shadow: 0.35, noise: 0.04 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);
  const held = containment(truth!, detection.bounds);
  assert.ok(held > 0.95, `containment ${held.toFixed(2)} under shadow`);
});

test("the reported features describe a signature, not something else", () => {
  const { detection } = detect({});
  assert.ok(detection.found);
  const f = detection.features;

  // These are the properties that DEFINE a signature for this detector. If a
  // future change makes it accept things with different properties, the
  // detector has stopped meaning what it says.
  assert.ok(f.solidity < 0.7, `solidity ${f.solidity.toFixed(2)} — a signature is an open scrawl, not a blob`);
  assert.ok(f.aspect > 1.4, `aspect ${f.aspect.toFixed(2)} — a signature is wider than it is tall`);
  assert.ok(f.printedTextLikelihood < 0.45, `printed-text likelihood ${f.printedTextLikelihood.toFixed(2)}`);
  assert.ok(f.inkAreaMM2 > 25, `ink area ${f.inkAreaMM2.toFixed(0)} mm2`);
});

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

test("an empty signature line yields Not Detected, not an empty crop", () => {
  const { detection } = detect({ withSignature: false });
  assert.ok(!detection.found, "an unsigned form must not produce a signature crop");
  assert.ok(
    detection.reason === "box_empty" || detection.reason === "below_threshold",
    `unexpected reason ${detection.reason}`,
  );
});

test("a thumb impression is identified as such, not cropped as a signature", () => {
  // Point the signature detector at the thumb box. The mark is inky, roughly
  // the right size, and in a box — everything except the right shape.
  const { detection } = detect({ withSignature: false }, { x: 880, y: 1380, width: 180, height: 200 });
  assert.ok(!detection.found, "a thumb impression must not be accepted as a signature");
  if (detection.features) {
    assert.ok(
      detection.features.solidity > 0.5,
      `expected a solid mark, got solidity ${detection.features.solidity.toFixed(2)}`,
    );
  }
});

test("blank paper produces no signature", () => {
  const { detection } = detect({ withSignature: false, withThumb: false }, { x: 200, y: 900, width: 400, height: 120 });
  assert.ok(!detection.found);
  assert.equal(detection.reason, "box_empty");
});

test("printed text in the signature box is rejected as printed", () => {
  // A row of printed labels. Wide, short, inky, in the right place — and not a
  // signature. This is the confusion that shape features alone cannot resolve.
  const { detection } = detect({ withSignature: false }, { x: 96, y: 250, width: 300, height: 60 });
  assert.ok(!detection.found, "printed text must not be accepted as a signature");
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("a refusal explains itself and never carries a mask", () => {
  const { detection } = detect({ withSignature: false });
  assert.ok(!detection.found);
  assert.ok(detection.detail.length > 0);
  assert.ok(!("mask" in detection), "a refusal must not carry an image");
});

test("detection is deterministic", () => {
  const first = detect({});
  const second = detect({});
  assert.equal(first.detection.found, second.detection.found);
  if (first.detection.found && second.detection.found) {
    assert.deepEqual(first.detection.bounds, second.detection.bounds);
  }
});

test("a signature and its own box overlap substantially", () => {
  // Sanity on the fixture itself: if the generator ever stops putting the
  // signature where these tests look for it, every result above is vacuous.
  const { truth } = detect({});
  const roi: Rect = { x: 96, y: 1330, width: 470, height: 130 };
  assert.ok(iou(truth!, roi) > 0.2, "the fixture's signature must lie in the region under test");
});
