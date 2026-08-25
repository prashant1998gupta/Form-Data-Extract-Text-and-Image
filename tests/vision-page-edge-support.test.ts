import assert from "node:assert/strict";
import test from "node:test";

import { detectPageQuad } from "../lib/vision/page.ts";
import { toGray } from "../lib/vision/gray.ts";
import type { Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * The page quad must be backed by evidence that it IS the page.
 *
 * THE BUG THIS LOCKS OUT, measured on the deployed product. A user photographed
 * a real certificate; the app reported `perspective`, high confidence, "four
 * page corners located" — and had silently cropped the top 15 % of the sheet.
 * Every template coordinate was then displaced by up to 42 mm, which is how a
 * photograph plainly present on the paper was reported as "the box was located
 * and is empty", and how the signature crop came back as a picture of a table.
 *
 * THE MECHANISM. `detectPageQuad` takes the largest bright connected component
 * and calls its hull the page. A full-bleed dark band across the sheet — a
 * heavy rule under a printed header, a fold, a scanner-lid shadow — survives
 * the `close(bright, 5)` once it is thicker than ~4.2 mm on A4, severs the
 * bright mask in two, and the larger fragment wins. `validateQuad` cannot
 * notice, because it is not given the image: it takes a quad and two integers,
 * so every question it can ask is about SHAPE, and the shape of a page and the
 * shape of most-of-a-page are the same.
 *
 * THE DISCRIMINATOR. A real page edge has paper on one side and not-paper on
 * the other. An ink line has paper on both sides. That separates the cases by a
 * mile rather than by a tuned threshold — 4 of 4 supported edges on a genuine
 * desk photo against 1 of 4 on every severed variant.
 *
 * Both directions are asserted. A gate that refuses a real desk photo would be
 * a worse product than the bug, so the genuine captures are pinned too.
 */

/** Paints a full-bleed horizontal band, as a fold or a heavy printed rule does. */
function paintBand(rgb: Rgb, atFraction: number, thicknessMM: number, tone: number): void {
  // The generator renders A4 at 150 dpi, so a millimetre is this many pixels.
  const pxPerMM = 150 / 25.4;
  const y0 = Math.round(rgb.height * atFraction);
  const y1 = Math.min(rgb.height, y0 + Math.round(thicknessMM * pxPerMM));
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < rgb.width; x += 1) {
      const p = (y * rgb.width + x) * rgb.channels;
      rgb.data[p] = tone;
      rgb.data[p + 1] = tone;
      rgb.data[p + 2] = tone;
    }
  }
}

function detectWithBand(options: SyntheticFormOptions, thicknessMM: number, tone = 20) {
  const { rgb } = renderSyntheticForm(options);
  paintBand(rgb, 0.14, thicknessMM, tone);
  return detectPageQuad(toGray(rgb));
}

// ---------------------------------------------------------------------------
// The failure
// ---------------------------------------------------------------------------

for (const thicknessMM of [5, 8, 15]) {
  test(`a ${thicknessMM}mm band across the sheet does not become a page edge`, () => {
    const detection = detectWithBand({}, thicknessMM);

    // The critical assertion. Before the edge-support gate this returned
    // `perspective` at confidence 1.00 and warped 85 % of the sheet onto the
    // full A4 raster, stretching every template coordinate by 1.18x.
    assert.notEqual(
      detection.method,
      "perspective",
      "a band across the page must not be accepted as the page boundary",
    );
    assert.match(detection.reason, /background/, "the refusal must say what was actually missing");
  });
}

test("a soft shadow band is refused too, not just a hard black one", () => {
  // Grey 160 on paper near 248. Softer than a printed rule and far more common:
  // this is a scanner lid not quite closed, or a hand shadow across the sheet.
  const detection = detectWithBand({}, 8, 160);
  assert.notEqual(detection.method, "perspective");
});

test("a thin band is absorbed and does not disturb detection", () => {
  // Below the ~4.2mm that `close(bright, 5)` bridges. This is the control: it
  // confirms the gate is responding to severed pages rather than to any dark
  // horizontal line, of which a form has many.
  const detection = detectWithBand({}, 3);
  assert.equal(detection.method, "full-frame");
  assert.match(detection.reason, /fills the frame/);
});

// ---------------------------------------------------------------------------
// The captures that must keep working
// ---------------------------------------------------------------------------

test("a genuine desk photo still gets a perspective correction", () => {
  const { rgb } = renderSyntheticForm({ desk: 110, shadow: 0.28, noise: 0.03 });
  const detection = detectPageQuad(toGray(rgb));

  assert.equal(detection.method, "perspective");
  assert.match(detection.reason, /4 of 4 edges/, "all four edges sit against the desk");
  assert.ok(detection.confidence > 0.8, `expected high confidence, got ${detection.confidence}`);
});

test("a skewed desk photo still gets a perspective correction", () => {
  const { rgb } = renderSyntheticForm({ desk: 90, skew: 4.5, shadow: 0.2 });
  const detection = detectPageQuad(toGray(rgb));
  assert.equal(detection.method, "perspective");
});

test("a full-frame scan is untouched — it never reaches the edge gate", () => {
  // A scan has no background to be supported BY, which is exactly why it takes
  // the fills-the-frame branch long before edge support is considered. If this
  // regresses, every flatbed scan starts being refused.
  const { rgb } = renderSyntheticForm({});
  const detection = detectPageQuad(toGray(rgb));
  assert.equal(detection.method, "full-frame");
});

test("confidence carries the edge evidence, not just the quad's shape", () => {
  // The old formula was `0.6 + 0.4 * shape`, a pure shape score with a 0.6
  // FLOOR — so anything that passed the shape checks started above the ~0.5 at
  // which registration is supposed to refuse. It could not go low, whatever the
  // image showed.
  const good = detectPageQuad(toGray(renderSyntheticForm({ desk: 110, shadow: 0.28 }).rgb));
  const severed = detectWithBand({}, 8);
  assert.ok(
    good.confidence > severed.confidence,
    `a supported quad must outrank an unsupported one (${good.confidence} vs ${severed.confidence})`,
  );
});
