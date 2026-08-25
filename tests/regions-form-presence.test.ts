import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { assessFormPresence } from "../lib/regions/form-presence.ts";
import { rgbFrom, type Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * The gate that decides whether a capture is a printed form at all.
 *
 * The failure it exists to stop is not a missing crop. It is a REFUSAL THAT IS
 * CONFIDENTLY WRONG: posting a plain rectangle to the running deployment used
 * to return "the photo box was located and is empty", which is a specific,
 * confident, false statement about a page that was never photographed. Absence
 * is only meaningful once presence has been established.
 *
 * Both directions are asserted, and the second matters more. A gate that
 * refuses a real patient's real form is a worse product than the bug it fixes,
 * so every genuine form here — including the degraded ones — must pass with
 * room to spare, and the unfilled form must still reach its detectors and still
 * report its three honest empty boxes.
 */

const PX_PER_MM = 150 / 25.4;

function presence(options: SyntheticFormOptions) {
  const { rgb } = renderSyntheticForm(options);
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM });
  return assessFormPresence({ ink: channels.ink, rules: channels.rules, pxPerMM: PX_PER_MM });
}

/** A uniform field of colour: a wall, a desk, a lens cap. No paper, no print. */
function flatColour(red: number, green: number, blue: number): Rgb {
  const width = 1240;
  const height = 1754;
  const data = new Uint8ClampedArray(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 3] = red;
    data[i * 3 + 1] = green;
    data[i * 3 + 2] = blue;
  }
  return rgbFrom(data, width, height, 3);
}

test("a filled form is recognised, with margin over the threshold", () => {
  const result = presence({});
  assert.equal(result.recognised, true);
  // The bar is three of either. A real form clears it several times over, and
  // that margin is what makes the gate safe to apply to a degraded capture.
  assert.ok(result.textLines >= 8, `expected many lines of type, got ${result.textLines}`);
  assert.ok(result.rules >= 6, `expected many printed rules, got ${result.rules}`);
});

test("an UNFILLED form is still recognised — the printed layer is what is measured", () => {
  // The single most important passing case. The unfilled form is the product
  // demo: three confident Not Detected results with reasons. If this gate
  // mistook "nothing written on it" for "not a form", it would replace three
  // correct answers with three apologies.
  const result = presence({ withPhoto: false, withSignature: false, withThumb: false });
  assert.equal(result.recognised, true);
  assert.ok(result.textLines >= 8, `expected printed labels to survive, got ${result.textLines}`);
});

test("a photocopy is recognised despite its collapsed dynamic range", () => {
  const result = presence({ photocopy: true, noise: 0.05 });
  assert.equal(result.recognised, true);
});

test("a shadowed, skewed, noisy capture is recognised", () => {
  const result = presence({ shadow: 0.6, skew: 4, noise: 0.05, desk: 60 });
  assert.equal(result.recognised, true);
});

test("a flat colour field is NOT recognised as a form", () => {
  const channels = prepareChannels(flatColour(58, 110, 165), { pxPerMM: PX_PER_MM });
  const result = assessFormPresence({ ink: channels.ink, rules: channels.rules, pxPerMM: PX_PER_MM });

  assert.equal(result.recognised, false);
  assert.equal(result.textLines, 0);
  assert.equal(result.rules, 0);
  // The reason is stated, not implied. The operator's next action depends on
  // knowing that nothing printed was found, rather than on a bare failure.
  assert.match(result.detail, /does not appear to be a form/);
});

test("blank paper is NOT recognised as a form", () => {
  // Subtler than a coloured rectangle and more likely in practice — a staff
  // member photographs the back of the sheet. It is white, it is paper, it is
  // page-shaped, and it carries no printed structure whatsoever. Reporting
  // "the box was located and is empty" about the back of a page is exactly the
  // confident-wrong refusal this gate exists to prevent.
  const channels = prepareChannels(flatColour(246, 245, 242), { pxPerMM: PX_PER_MM });
  const result = assessFormPresence({ ink: channels.ink, rules: channels.rules, pxPerMM: PX_PER_MM });

  assert.equal(result.recognised, false);
});
