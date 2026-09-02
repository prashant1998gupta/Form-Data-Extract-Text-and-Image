import assert from "node:assert/strict";
import test from "node:test";

import { extractRegions } from "../lib/pipeline/extract-regions.ts";
import { parseCustomTemplate } from "../lib/templates/custom.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * A photograph whose boundary is faint on some sides.
 *
 * THE INPUT. `regions/photo.ts` opens by naming this as the most common real
 * capture there is: a person on a near-white studio backdrop, printed on white
 * photo paper, pasted onto white form paper. Two or three sides of it step by
 * a strong, unmistakable amount; the remaining one or two step by a handful of
 * grey levels, because on that side the backdrop happens to be as light as the
 * paper.
 *
 * THE BUG THIS PINS. The candidate-step floor and the acceptance floor
 * disagreed by a factor of 2.5. `detectPhoto` asked `edgeStepProfile` for
 * steps of at least `minResponseSigma * 2.5` — 7.5 sigma — and then judged
 * whatever came back against `minResponseSigma`, 3 sigma. So the acceptance
 * floor was unreachable: a real 5-sigma boundary was not scored badly, it was
 * never generated, and the edge came back "could not be measured". Any edge
 * that fails means no quadrilateral, which means no crop and no suggestion —
 * "Not Detected · 2 of 4 edges could not be measured (left, bottom)" over a
 * photograph plainly present on the paper.
 *
 * WHAT THE FIX MAY NOT DO. It may not substitute the template's own edge for
 * one it could not measure — that is how a detector starts returning the
 * printed box every time and calling it a photograph, and the whole file is
 * built around refusing it. The relaxed pass measures the same pixels against
 * the floor the code always claimed to use, and a detection that needed it is
 * marked: lower confidence, and sent to a human.
 */

const PX_PER_MM = 150 / 25.4;

async function extractPale(options: { photoScale?: number } = {}) {
  const { rgb, truth } = renderSyntheticForm({
    photoBackdrop: "pale",
    withThumb: false,
    ...options,
  });
  assert.ok(truth.photo);

  const box = {
    xMM: truth.photo.x / PX_PER_MM - 1,
    yMM: truth.photo.y / PX_PER_MM - 1,
    widthMM: truth.photo.width / PX_PER_MM + 2,
    heightMM: truth.photo.height / PX_PER_MM + 2,
  };
  const template = parseCustomTemplate({
    name: "Taught form",
    page: "A4",
    fields: [{ type: "photograph", box }],
  });

  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const { result } = await extractRegions(bytes, { template });
  const photo = result.regions.find((r) => r.key === "patientPhotograph");
  assert.ok(photo);
  return photo;
}

test("a photograph on a pale backdrop is extracted, not reported unmeasurable", async () => {
  const photo = await extractPale();
  assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
});

test("a photograph found on faint edges is offered for review, not asserted", async () => {
  // The crop is real and the operator should see it. What must not happen is
  // it arriving at the confidence a four-strong-edge measurement earns.
  const photo = await extractPale();
  assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
  assert.equal(photo.needsReview, true, "a faint-edge detection must reach a human");
  assert.ok(photo.confidence !== undefined && photo.confidence < 0.8, `confidence ${photo.confidence} is too assured`);
});

test("a large photograph on a pale backdrop is extracted too", async () => {
  // The two failures the user actually hit, together: a hospital-sized print
  // with a faint boundary.
  const photo = await extractPale({ photoScale: 1.6 });
  assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
});
