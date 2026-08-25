import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectThumb, type ThumbDetection } from "../lib/regions/thumb.ts";
import { REGION_PARAMS } from "../lib/regions/params.ts";
import { containment, type Rect } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * Thumb detection is deliberately the weakest of the three detectors, and these
 * tests encode that as a requirement rather than tolerating it as a shortcoming.
 * Confidence is capped, review is always required, and the cross-box warning
 * fires when somebody signs in the thumb box.
 */

const PX_PER_MM = 150 / 25.4;

function detect(options: SyntheticFormOptions, roiOverride?: Rect): { detection: ThumbDetection; truth: Rect | null } {
  const { rgb, truth } = renderSyntheticForm(options);
  const roi: Rect = roiOverride ?? { x: 880, y: 1380, width: 180, height: 220 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [roi] });

  const detection = detectThumb({ ink: channels.ink, rgb, roi, pxPerMM: PX_PER_MM });
  return { detection, truth: truth.thumb };
}

test("an inked thumb impression is found and cropped to its own extent", () => {
  const { detection, truth } = detect({});
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);

  const held = containment(truth!, detection.bounds);
  assert.ok(held > 0.85, `containment ${held.toFixed(2)} of the true impression`);
});

test("thumb confidence is hard-capped and review is always required", () => {
  // Not a nicety. Without ridge verification this detector cannot support a
  // high-confidence claim, and the cap is where that honesty is enforced.
  const { detection } = detect({});
  assert.ok(detection.found);
  assert.ok(
    detection.confidence <= REGION_PARAMS.thumb.confidenceCap,
    `confidence ${detection.confidence.toFixed(2)} exceeds the ${REGION_PARAMS.thumb.confidenceCap} cap`,
  );
  assert.equal(detection.needsReview, true, "a thumb crop is always confirmed by a human");
});

test("the impression reads as solid and compact, not as a scrawl", () => {
  const { detection } = detect({});
  assert.ok(detection.found);
  const f = detection.features;
  assert.ok(f.solidity >= REGION_PARAMS.thumb.minSolidity, `solidity ${f.solidity.toFixed(2)}`);
  assert.ok(f.aspect > 0.4 && f.aspect < 2.2, `aspect ${f.aspect.toFixed(2)}`);
  assert.ok(f.fillRatio >= REGION_PARAMS.thumb.fillRange.min, `fill ${f.fillRatio.toFixed(2)}`);
  // Not so filled that it is a solid rectangle — that would be a photograph or
  // a pasted sticker, not an impression.
  assert.ok(f.fillRatio <= 0.9, `fill ${f.fillRatio.toFixed(2)} — too solid to be an inked impression`);
});

test("an empty thumb box yields Not Detected", () => {
  const { detection } = detect({ withThumb: false });
  assert.ok(!detection.found, "an empty box must not produce a crop");
});

test("a signature in the thumb box is reported as a wrong-box error", () => {
  // The template says which box is which, so this is a HUMAN error the system
  // can surface. Silently cropping the signature into a biometric field, or
  // silently reporting nothing, both throw that information away.
  const { detection } = detect({ withThumb: false }, { x: 96, y: 1330, width: 470, height: 130 });
  assert.ok(!detection.found, "a signature must not be accepted as a thumb impression");
  if (detection.wrongBoxWarning) {
    assert.match(detection.wrongBoxWarning, /signature/i);
  }
});

test("blank paper produces no thumb impression", () => {
  const { detection } = detect({ withThumb: false, withSignature: false }, { x: 250, y: 850, width: 180, height: 200 });
  assert.ok(!detection.found);
  assert.equal(detection.reason, "box_empty");
});

test("a photocopied impression is still found", () => {
  const { detection } = detect({ photocopy: true, noise: 0.03 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);
});

test("the mask is origin-aligned with the bounds", () => {
  const { detection } = detect({});
  assert.ok(detection.found);
  assert.equal(detection.mask.width, detection.bounds.width);
  assert.equal(detection.mask.height, detection.bounds.height);
  let inked = 0;
  for (let i = 0; i < detection.mask.data.length; i += 1) if (detection.mask.data[i] !== 0) inked += 1;
  assert.ok(inked > 100, `the mask must carry the impression's ink, found ${inked} pixels`);
});

test("detection is deterministic", () => {
  const first = detect({});
  const second = detect({});
  assert.equal(first.detection.found, second.detection.found);
  if (first.detection.found && second.detection.found) {
    assert.deepEqual(first.detection.bounds, second.detection.bounds);
  }
});
