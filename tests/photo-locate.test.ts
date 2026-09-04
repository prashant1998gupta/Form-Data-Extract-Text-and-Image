import assert from "node:assert/strict";
import test from "node:test";

import type { PhotoDefinition } from "../lib/forms/definitions.ts";
import { canvasBoxToImage, locatePhoto, normalizeBox, type NormalizedBox } from "../lib/photo/locate-photo.ts";
import { encodeRgbJpegSquare } from "../lib/vision/io.ts";
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

/** Overlap of the delivered crop's source rectangle with the print on the paper. */
function overlapWithPrint(result: Awaited<ReturnType<typeof locatePhoto>>, photo: Rect): number {
  if (!result.found) return 0;
  const a = result.sourceRect;
  const x1 = Math.max(a.x, photo.x);
  const y1 = Math.max(a.y, photo.y);
  const x2 = Math.min(a.x + a.width, photo.x + photo.width);
  const y2 = Math.min(a.y + a.height, photo.y + photo.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.width * a.height + photo.width * photo.height - inter);
}

test("a hint a few per cent off, or drawn generous, still delivers the print inside it", async () => {
  const { rgb, truth } = renderSyntheticForm({ withThumb: false });
  assert.ok(truth.photo);
  // Measured or cut, what is delivered must be the print: a crop that misses
  // a quarter of it, or takes in as much paper again, is not.
  for (const [label, edges] of [
    ["shifted", { left: 0.08, top: 0.08, right: 0.08, bottom: 0.08 }],
    ["generous", { left: -0.1, top: -0.1, right: 0.1, bottom: 0.1 }],
  ] as const) {
    const result = await locatePhoto(rgb, hintFor(truth.photo, rgb, edges), PASSPORT);
    assert.ok(result.found, `${label}: ${result.found ? "" : result.detail}`);
    const overlap = overlapWithPrint(result, truth.photo);
    assert.ok(overlap >= 0.7, `${label}: the crop overlaps the print by only ${overlap.toFixed(2)} (${result.found ? result.method : ""})`);
  }
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
    if (!result.found) assert.equal(result.reason, "not_found");
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

test("a hint half a print-width off — the reader's real precision — still finds the print by searching", async () => {
  const { rgb, truth } = renderSyntheticForm({ withThumb: false });
  assert.ok(truth.photo);
  // Left by half a width: the worst the model has done on a square canvas.
  const left = await locatePhoto(rgb, hintFor(truth.photo, rgb, { left: -0.5, right: -0.5 }), PASSPORT);
  assert.ok(left.found, left.found ? "" : left.detail);
  const overlapLeft = overlapWithPrint(left, truth.photo);
  assert.ok(overlapLeft >= 0.7, `left: overlap ${overlapLeft.toFixed(2)}`);
  // Down and slightly small.
  const down = await locatePhoto(rgb, hintFor(truth.photo, rgb, { top: 0.6, bottom: 0.45 }), PASSPORT);
  assert.ok(down.found, down.found ? "" : down.detail);
  const overlapDown = overlapWithPrint(down, truth.photo);
  assert.ok(overlapDown >= 0.7, `down: overlap ${overlapDown.toFixed(2)}`);
});

test("a hint with nothing photograph-like within reach finds nothing, in words", async () => {
  const { rgb, truth } = renderSyntheticForm({ withThumb: false });
  assert.ok(truth.photo);
  const far = await locatePhoto(rgb, hintFor(truth.photo, rgb, { left: -3.2, right: -3.2 }), PASSPORT);
  assert.equal(far.found, false);
  if (!far.found) assert.equal(far.reason, "not_found");
});

test("a picture that is not the shape of the form's print is cut as it is, and flagged", async () => {
  // A landscape picture on a form that expects a portrait print: the detector
  // may fit it, but a 3:2 fit is refused against a 35x45 declaration, and the
  // block it plainly is gets cut for a person to judge.
  const width = 700;
  const height = 700;
  const data = new Uint8ClampedArray(width * height * 3).fill(248);
  const left = 200;
  const top = 250;
  const pictureWidth = 300;
  const pictureHeight = 200;
  for (let y = top; y < top + pictureHeight; y += 1) {
    for (let x = left; x < left + pictureWidth; x += 1) {
      const shade = 40 + ((x - left) / pictureWidth) * 150 + ((y - top) / pictureHeight) * 30;
      const p = (y * width + x) * 3;
      data[p] = shade;
      data[p + 1] = shade * 0.9;
      data[p + 2] = shade * 0.8 + 30;
    }
  }
  const rgb: Rgb = { data, width, height, channels: 3 };
  const box = { x1: left / width, y1: top / height, x2: (left + pictureWidth) / width, y2: (top + pictureHeight) / height };
  const result = await locatePhoto(rgb, box, PASSPORT);
  assert.ok(result.found, result.found ? "" : result.detail);
  if (!result.found) return;
  assert.equal(result.method, "located");
  assert.equal(result.needsReview, true);
  assert.ok(result.confidence < 0.8);
  assert.ok(result.sourceRect.width >= pictureWidth * 0.5, `cut is ${result.sourceRect.width} px wide`);
});

test("a box on the square canvas is restated in the capture's own fractions", () => {
  // A 1414x2000 capture at the top-left of a 2000 square: x stretches by 2000/1414, y is unchanged.
  const box = canvasBoxToImage({ x1: 0.56, y1: 0.03, x2: 0.678, y2: 0.181 }, 1414, 2000, 2000)!;
  assert.ok(Math.abs(box.x1 - 0.792) < 0.002 && Math.abs(box.x2 - 0.959) < 0.002, `${box.x1} ${box.x2}`);
  assert.ok(Math.abs(box.y1 - 0.03) < 1e-9 && Math.abs(box.y2 - 0.181) < 1e-9);
  // Entirely in the padding: nothing to cut.
  assert.equal(canvasBoxToImage({ x1: 0.8, y1: 0.1, x2: 0.95, y2: 0.3 }, 1414, 2000, 2000), null);
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

test("the square canvas scales a small capture up to fill its long side, so the box has one meaning", async () => {
  const width = 110;
  const height = 150;
  const data = new Uint8ClampedArray(width * height * 3).fill(200);
  const canvas = await encodeRgbJpegSquare({ data, width, height, channels: 3 }, 600, 80);
  assert.equal(canvas.edge, 600);
  assert.equal(canvas.height, 600, "the long side fills the canvas");
  assert.equal(canvas.width, Math.round((110 / 150) * 600));
  // And a large one is brought down to it.
  const big = new Uint8ClampedArray(900 * 1200 * 3).fill(200);
  const down = await encodeRgbJpegSquare({ data: big, width: 900, height: 1200, channels: 3 }, 600, 80);
  assert.equal(down.height, 600);
  assert.equal(down.width, 450);
});
