import assert from "node:assert/strict";
import test from "node:test";

import type { PhotoDefinition } from "../lib/forms/definitions.ts";
import { cropPhoto, rectifyCapture } from "../lib/photo/crop-photo.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * The photograph pipeline end to end, from encoded bytes to a delivered
 * crop, driven by the synthetic form's known geometry.
 *
 * The detector's own tests exercise it against a hand-placed region. These
 * exercise what those cannot: that millimetre geometry survives decode, page
 * localisation and rectification and still lands on the right part of the
 * page. Every coordinate bug in this project has lived in that chain.
 */

/** The synthetic form's photo frame — the geometry the generator renders. */
const SYNTHETIC_PHOTO: PhotoDefinition = {
  label: "Patient photograph",
  box: { xMM: 160.2, yMM: 29.8, widthMM: 36, heightMM: 46 },
  printedBorder: { xMM: 160.2, yMM: 30.3, widthMM: 35, heightMM: 45 },
  sizeMM: { widthMM: 35, heightMM: 45 },
  sizeTolerance: { min: 0.72, max: 1.35 },
};

const PX_PER_MM = 150 / 25.4;

function specAround(photo: { x: number; y: number; width: number; height: number }, sizeMM: PhotoDefinition["sizeMM"]): PhotoDefinition {
  return {
    label: "Photograph",
    box: {
      xMM: photo.x / PX_PER_MM - 1,
      yMM: photo.y / PX_PER_MM - 1,
      widthMM: photo.width / PX_PER_MM + 2,
      heightMM: photo.height / PX_PER_MM + 2,
    },
    printedBorder: {
      xMM: photo.x / PX_PER_MM,
      yMM: photo.y / PX_PER_MM,
      widthMM: photo.width / PX_PER_MM,
      heightMM: photo.height / PX_PER_MM,
    },
    sizeMM,
    sizeTolerance: { min: 0.7, max: 1.4 },
  };
}

async function run(options: SyntheticFormOptions, placement: "exact" | "loose" = "exact") {
  const { rgb, truth } = renderSyntheticForm(options);
  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const capture = await rectifyCapture(bytes);
  const report = await cropPhoto(capture, SYNTHETIC_PHOTO, { placement });
  return { capture, report, truth };
}

test("a clean scan yields the photograph at about its physical size", async () => {
  const { report } = await run({});
  const photo = report.photo;
  assert.ok(photo.found, photo.found ? "" : photo.detail);
  if (!photo.found) return;
  assert.ok(photo.png.length > 0);
  // 35x45 mm at 300 dpi is 413x531; the crop is delivered at the MEASURED
  // size, so a couple of per cent either way is the honest expectation.
  assert.ok(Math.abs(photo.width - 413) < 20, `width ${photo.width}`);
  assert.ok(Math.abs(photo.height - 531) < 24, `height ${photo.height}`);
  assert.ok(photo.confidence > 0.8, `confidence ${photo.confidence}`);
});

test("the page is rectified to the canonical raster whatever the capture", async () => {
  for (const options of [{}, { desk: 110, shadow: 0.3 }, { skew: 4 }]) {
    const { capture } = await run(options);
    assert.equal(capture.rectified.width, 1654, `width for ${JSON.stringify(options)}`);
    assert.equal(capture.rectified.height, 2339, `height for ${JSON.stringify(options)}`);
    assert.ok(Math.abs(capture.pxPerMM - 7.874) < 0.001);
  }
});

test("a page photographed on a desk is perspective-corrected and still yields the photograph", async () => {
  const { capture, report } = await run({ desk: 110, shadow: 0.3, noise: 0.03 });
  assert.equal(capture.page.method, "perspective", capture.page.reason);
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
  if (report.photo.found) assert.ok(report.photo.confidence > 0.8, `confidence ${report.photo.confidence}`);
});

test("a skewed scan has its rotation undone before the frame is addressed", async () => {
  for (const skew of [4, -3]) {
    const { capture, report } = await run({ skew });
    assert.equal(capture.page.method, "skew", `skew ${skew}: ${capture.page.reason}`);
    assert.ok(report.photo.found, `at ${skew} degrees the photograph was lost: ${report.photo.found ? "" : report.photo.detail}`);
  }
});

test("an unfilled form is refused with a reason, and carries no image", async () => {
  const { report } = await run({ withPhoto: false, withSignature: false, withThumb: false });
  assert.equal(report.formPresence.recognised, true, "a blank printed form is still a form");
  assert.equal(report.photo.found, false);
  if (report.photo.found) return;
  assert.ok(report.photo.reason);
  assert.ok(report.photo.detail);
});

test("the loose placement used for real forms still finds a print pasted where the form says", async () => {
  const { report } = await run({}, "loose");
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
});

test("a print pasted a few millimetres off the frame is still found under loose placement", async () => {
  const { rgb } = renderSyntheticForm({ withThumb: false });
  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const capture = await rectifyCapture(bytes);
  // Declare the frame 4 mm away from where the print actually is.
  const shifted: PhotoDefinition = {
    ...SYNTHETIC_PHOTO,
    box: { ...SYNTHETIC_PHOTO.box, xMM: SYNTHETIC_PHOTO.box.xMM - 4, yMM: SYNTHETIC_PHOTO.box.yMM + 4 },
    printedBorder: {
      ...SYNTHETIC_PHOTO.printedBorder,
      xMM: SYNTHETIC_PHOTO.printedBorder.xMM - 4,
      yMM: SYNTHETIC_PHOTO.printedBorder.yMM + 4,
    },
  };
  const report = await cropPhoto(capture, shifted, { placement: "loose" });
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
});

test("a photocopied, greyscale photograph is found but capped and sent for review", async () => {
  const { report } = await run({ photocopy: true, monochromePhoto: true });
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
  if (!report.photo.found) return;
  assert.ok(report.photo.confidence <= 0.72, `photocopy confidence ${report.photo.confidence} must be capped`);
  assert.equal(report.photo.needsReview, true);
});

test("a capture that is not a form yields no photograph and says why", async () => {
  // A plain mid-grey rectangle: no print, no rules, no form.
  const width = 1240;
  const height = 1754;
  const data = new Uint8ClampedArray(width * height * 3).fill(120);
  const bytes = new Uint8Array(await encodeRgbPng({ data, width, height, channels: 3 }));
  const capture = await rectifyCapture(bytes);
  const report = await cropPhoto(capture, SYNTHETIC_PHOTO);
  assert.equal(report.formPresence.recognised, false);
  assert.equal(report.photo.found, false);
  if (!report.photo.found) assert.equal(report.photo.reason, "not_a_form");
});

test("a larger print than the passport default is extracted at its own size", async () => {
  // Hospital and school forms routinely carry a 50-60 mm print. The crop is
  // the shape of the photograph on the paper, not of a passport print.
  const { rgb, truth } = renderSyntheticForm({ photoScale: 1.6, withThumb: false });
  assert.ok(truth.photo);
  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const capture = await rectifyCapture(bytes);
  const report = await cropPhoto(capture, specAround(truth.photo, { widthMM: 56, heightMM: 72 }));
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
  if (!report.photo.found) return;
  const aspect = report.photo.width / report.photo.height;
  assert.ok(Math.abs(aspect - 35 / 45) < 0.08, `crop aspect ${aspect.toFixed(3)}`);
  assert.ok(report.photo.width > 520, `crop is ${report.photo.width}px wide — it was cut to passport size`);
});

test("a photograph on a pale backdrop is extracted and offered for review", async () => {
  // The most common real input: a person on a near-white studio backdrop,
  // printed on white paper, pasted onto white paper. Two sides step strongly;
  // the others by a handful of grey levels.
  const { rgb, truth } = renderSyntheticForm({ photoBackdrop: "pale", withThumb: false });
  assert.ok(truth.photo);
  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const capture = await rectifyCapture(bytes);
  const report = await cropPhoto(capture, specAround(truth.photo, { widthMM: 35, heightMM: 45 }));
  assert.ok(report.photo.found, report.photo.found ? "" : report.photo.detail);
  if (!report.photo.found) return;
  assert.equal(report.photo.needsReview, true, "a faint-edge detection must reach a human");
  assert.ok(report.photo.confidence < 0.8, `confidence ${report.photo.confidence} is too assured`);
});

test("the pipeline reports its own timings", async () => {
  const { capture, report } = await run({});
  for (const stage of ["decode", "page"]) assert.ok(typeof capture.timings[stage] === "number", stage);
  for (const stage of ["normalise", "detect"]) assert.ok(typeof report.timings[stage] === "number", stage);
});
