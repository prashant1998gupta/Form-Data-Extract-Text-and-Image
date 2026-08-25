import assert from "node:assert/strict";
import test from "node:test";

import { extractRegions } from "../lib/pipeline/extract-regions.ts";
import { parseCustomTemplate } from "../lib/templates/custom.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * A form taught by drawing, end to end.
 *
 * THE CLAIM UNDER TEST. The extraction engine is good; it fails on an
 * unfamiliar form for exactly one reason, which is that it is measuring that
 * form against coordinates belonging to a different one. So a person drags
 * boxes over a photograph of their own form, once, and it works.
 *
 * The interesting half is that the boxes are ROUGH. A finger on a phone is
 * several millimetres out, and the registered prior is calibrated for a
 * homography accurate to a fraction of one — measured, it REFUSES a box 4 mm
 * out. Fields built by `parseCustomTemplate` carry `origin: "drawn"`, which
 * widens the prior, and that is what makes the difference between a feature
 * that works and one that silently refuses everything a person draws.
 */

const PX_PER_MM = 150 / 25.4;

/** Truth in millimetres, as the person drawing would see it. */
function truthMM(rect: { x: number; y: number; width: number; height: number }) {
  return {
    xMM: rect.x / PX_PER_MM,
    yMM: rect.y / PX_PER_MM,
    widthMM: rect.width / PX_PER_MM,
    heightMM: rect.height / PX_PER_MM,
  };
}

/** A hand-drawn box: the truth, offset and over-sized as a finger would. */
function asDrawn(box: ReturnType<typeof truthMM>, errorMM: number) {
  return {
    xMM: box.xMM - errorMM * 0.7,
    yMM: box.yMM - errorMM * 0.7,
    widthMM: box.widthMM + errorMM * 1.4,
    heightMM: box.heightMM + errorMM * 1.4,
  };
}

async function extractWithDrawn(errorMM: number) {
  const { rgb, truth } = renderSyntheticForm({});
  assert.ok(truth.photo && truth.signature);

  const template = parseCustomTemplate({
    name: "Taught form",
    page: "A4",
    fields: [
      { type: "photograph", box: asDrawn(truthMM(truth.photo), errorMM) },
      { type: "signature", box: asDrawn(truthMM(truth.signature), errorMM) },
    ],
  });

  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const { result } = await extractRegions(bytes, { template });
  return result;
}

for (const errorMM of [0, 3, 6]) {
  test(`boxes drawn ${errorMM} mm out still extract the photograph`, async () => {
    const result = await extractWithDrawn(errorMM);
    const photo = result.regions.find((r) => r.key === "patientPhotograph");
    assert.ok(photo);
    assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
  });
}

test("a taught template declares only what was drawn", async () => {
  // No thumb box was drawn, so no thumb is reported — not as "Not Detected",
  // which would assert something about a region nobody described, but as
  // absent from the result entirely.
  const result = await extractWithDrawn(0);
  assert.equal(result.regions.length, 2);
  assert.ok(!result.regions.some((r) => r.key === "thumbImpression"));
});

test("a taught template with no landmarks does not claim registration it lacks", async () => {
  // A drawn template declares no `printedBorder` and no `baselineMM`, so the
  // anchor check has nothing to verify. It must not therefore report the page
  // as unregistered and suppress every result — having no opinion is not the
  // same as a negative one.
  const result = await extractWithDrawn(0);
  assert.equal(result.registration.anchorsChecked, 0);
  assert.equal(result.registration.registered, true);
  for (const region of result.regions) {
    assert.notEqual(region.unverifiedTemplate, true, `${region.key} must not be flagged unverified`);
  }
});
