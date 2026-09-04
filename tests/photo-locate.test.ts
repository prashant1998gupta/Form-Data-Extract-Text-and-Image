import assert from "node:assert/strict";
import test from "node:test";

import type { PhotoDefinition } from "../lib/forms/definitions.ts";
import { locatePhoto, normalizeBox, type NormalizedBox } from "../lib/photo/locate-photo.ts";
import type { Rect, Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * The photograph, cut where the reader says it is.
 *
 * The reader's box is a hint. These pin what is done with it: a hint on the
 * print is measured to the print's own edges and delivered upright; a hint a
 * little off, or a little generous, still measures; a hint the detector
 * cannot measure is cut as it is and flagged; a hint on blank paper is
 * refused; and no hint means no photograph, in words.
 */

const PASSPORT: PhotoDefinition = {
  label: "Photograph",
  sizeMM: { widthMM: 35, heightMM: 45 },
  sizeTolerance: { min: 0.7, max: 1.4 },
};

/** A reader's box for a known rectangle, each edge moved by a fraction of the box's own size. */
function hintFor(photo: Rect, image: Rgb, edges: { left?: number; top?: number; right?: number; bottom?: number } = {}): NormalizedBox {
  return {
    x1: (photo.x + (edges.left ?? 0) * photo.width) / image.width,
    y1: (photo.y + (edges.top ?? 0) * photo.height) / image.height,
    x2: (photo.x + photo.width + (edges.right ?? 0) * photo.width) / image.width,
    y2: (photo.y + photo.height + (edges.bottom ?? 0) * photo.height) / image.height,
  };
}

test("a hint on the print is measured to its edges and delivered upright", async () => {
  const { rgb, truth } = renderSyntheticForm({ withThumb: false });
  assert.ok(truth.photo);
  const result = await locatePhoto(rgb, hintFor(truth.photo, rgb, { left: -0.04, top: 0.03, right: 0.05, bottom: -0.02 }), PASSPORT);
  assert.ok(result.found, result.found ? "" : result.detail);
  if (!result.found) return;
  assert.equal(result.method, "measured");
  const aspect = result.width / result.height;
  assert.ok(Math.abs(aspect - 35 / 45) < 0.08, `aspect ${aspect.toFixed(3)}`);
  assert.ok(result.png.length > 0);
});

test("a hint a few per cent off, or drawn generous, still measures the print inside it", async () => {
  const { rgb, truth } = renderSyntheticForm({ withThumb: false });
  assert.ok(truth.photo);
  const shifted = await locatePhoto(rgb, hintFor(truth.photo, rgb, { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 }), PASSPORT);
  assert.ok(shifted.found && shifted.method === "measured", shifted.found ? shifted.method : shifted.detail);
  const generous = await locatePhoto(rgb, hintFor(truth.photo, rgb, { left: -0.2, top: -0.2, right: 0.2, bottom: 0.2 }), PASSPORT);
  assert.ok(generous.found && generous.method === "measured", generous.found ? generous.method : generous.detail);
});

test("no hint means no photograph, in words", async () => {
  const { rgb } = renderSyntheticForm({ withThumb: false });
  const result = await locatePhoto(rgb, null, PASSPORT);
  assert.equal(result.found, false);
  if (!result.found) assert.equal(result.reason, "no_photo");
});

test("a hint on blank paper or printed text is refused, never delivered as a photograph", async () => {
  const { rgb } = renderSyntheticForm({ withPhoto: false, withThumb: false });
  // The empty photo frame, and a run of field rows.
  for (const box of [
    { x1: 0.76, y1: 0.1, x2: 0.93, y2: 0.25 },
    { x1: 0.1, y1: 0.35, x2: 0.27, y2: 0.5 },
  ]) {
    const result = await locatePhoto(rgb, box, PASSPORT);
    assert.equal(result.found, false, `delivered a "photograph" from ${JSON.stringify(box)}`);
    if (!result.found) assert.equal(result.reason, "empty_box");
  }
});

test("an implausible hint is refused in words", async () => {
  const { rgb } = renderSyntheticForm({ withThumb: false });
  const whole = await locatePhoto(rgb, { x1: 0, y1: 0, x2: 1, y2: 1 }, PASSPORT);
  assert.equal(whole.found, false);
  if (!whole.found) assert.equal(whole.reason, "implausible_box");
  const speck = await locatePhoto(rgb, { x1: 0.5, y1: 0.5, x2: 0.51, y2: 0.51 }, PASSPORT);
  assert.equal(speck.found, false);
  const strip = await locatePhoto(rgb, { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.15 }, PASSPORT);
  assert.equal(strip.found, false);
});

test("a photograph whose edges cannot be measured is still cut, and flagged", async () => {
  // A coloured disc on paper: plainly not blank, plainly no straight edges.
  const width = 600;
  const height = 800;
  const data = new Uint8ClampedArray(width * height * 3).fill(248);
  const cx = 300;
  const cy = 400;
  const radius = 120;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius) continue;
      const p = (y * width + x) * 3;
      data[p] = 60 + (x % 7) * 3;
      data[p + 1] = 90 + (y % 5) * 4;
      data[p + 2] = 150;
    }
  }
  const rgb: Rgb = { data, width, height, channels: 3 };
  const box = { x1: (cx - radius) / width, y1: (cy - radius) / height, x2: (cx + radius) / width, y2: (cy + radius) / height };
  const result = await locatePhoto(rgb, box, PASSPORT);
  assert.ok(result.found, result.found ? "" : result.detail);
  if (!result.found) return;
  assert.equal(result.method, "located");
  assert.equal(result.needsReview, true);
  assert.ok(result.confidence < 0.8);
  assert.ok(Math.abs(result.width - 2 * radius) < 20, `width ${result.width}`);
});

test("the reader's numbers are read in whatever scale it used", () => {
  // Thousandths, as asked.
  assert.deepEqual(normalizeBox([792, 30, 959, 181], 1414, 2000), { x1: 0.792, y1: 0.03, x2: 0.959, y2: 0.181 });
  // Fractions.
  const fractions = normalizeBox([0.5, 0.1, 0.75, 0.4], 1414, 2000)!;
  assert.ok(Math.abs(fractions.x1 - 0.5) < 1e-9 && Math.abs(fractions.y2 - 0.4) < 1e-9);
  // Pixels of the image it was shown.
  const pixels = normalizeBox([1131, 60, 1360, 400], 1414, 2000)!;
  assert.ok(Math.abs(pixels.x1 - 1131 / 1414) < 1e-9 && Math.abs(pixels.y2 - 400 / 2000) < 1e-9);
  // Reversed corners are put right; a degenerate box is no box.
  assert.deepEqual(normalizeBox([959, 181, 792, 30], 1414, 2000), { x1: 0.792, y1: 0.03, x2: 0.959, y2: 0.181 });
  assert.equal(normalizeBox([500, 500, 500, 600], 1414, 2000), null);
  assert.equal(normalizeBox([Number.NaN, 0, 1, 1], 1414, 2000), null);
});
