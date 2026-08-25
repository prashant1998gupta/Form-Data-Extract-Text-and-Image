import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectPhoto } from "../lib/regions/photo.ts";
import { renderPhotoCrop, type PhotoSource } from "../lib/regions/postprocess.ts";
import { warpQuadRgb } from "../lib/vision/warp-rgb.ts";
import type { Matrix3, Quad, Rect, Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * Delivering the photograph from the ORIGINAL capture rather than the analysis
 * copy.
 *
 * Detection necessarily runs on the rectified page, which is 200 DPI of paper
 * by construction. The passport photograph is delivered at 300 DPI, so a crop
 * sampled from the rectified page is always a 1.5x upscale — of detail the
 * phone genuinely captured and the pipeline then threw away. `io.ts` carried a
 * full-resolution crop function and a documented note calling it "the whole
 * reason DecodedImage.scale is carried around", and nothing ever called it.
 *
 * The risk in fixing that is a MISALIGNED crop, not a missing one: two
 * homographies now compose (output pixel to rectified page, rectified page to
 * original capture), and getting the order or the direction wrong yields a
 * plausible portrait of slightly the wrong part of the form. So the assertion
 * here is not "it produced an image" — it is that the finer sampling lands in
 * the SAME PLACE as the sampling it replaces.
 */

const PX_PER_MM = 150 / 25.4;
const PASSPORT = { widthMM: 35, heightMM: 45 };

/**
 * A synthetic "original capture": the same page at twice the linear resolution.
 *
 * Standing in for the real thing, where the original is finer than the
 * rectified page because the phone captured more pixels than analysis needs.
 * The transform is stated exactly rather than rounded to 2, because a half-pixel
 * drift is precisely the class of error this test exists to catch.
 */
function doubleResolution(image: Rgb): { finer: Rgb; transform: Matrix3; pxPerMM: number } {
  const width = image.width * 2;
  const height = image.height * 2;
  const frame: Quad = {
    tl: { x: 0, y: 0 },
    tr: { x: image.width - 1, y: 0 },
    br: { x: image.width - 1, y: image.height - 1 },
    bl: { x: 0, y: image.height - 1 },
  };
  const finer = warpQuadRgb(image, frame, width, height);

  // `warpQuadRgb` maps its destination corners onto `frame`, so the forward map
  // — page pixel to finer pixel — is the inverse of that, exactly.
  const scaleX = (width - 1) / (image.width - 1);
  const scaleY = (height - 1) / (image.height - 1);
  const transform: Matrix3 = [scaleX, 0, 0, 0, scaleY, 0, 0, 0, 1];

  return { finer, transform, pxPerMM: PX_PER_MM * scaleX };
}

function detectOn(rgb: Rgb, expected: Rect) {
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [expected] });
  return detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });
}

/** Mean absolute difference per channel between two same-sized images. */
function meanAbsDifference(a: Rgb, b: Rgb): number {
  assert.equal(a.width, b.width);
  assert.equal(a.height, b.height);
  let total = 0;
  for (let i = 0; i < a.data.length; i += 1) total += Math.abs(a.data[i]! - b.data[i]!);
  return total / a.data.length;
}

test("a crop sampled from finer pixels lands in the same place as one from the page", () => {
  const { rgb, truth } = renderSyntheticForm({});
  assert.ok(truth.photo, "the fixture must have pasted a photo");

  const detection = detectOn(rgb, truth.photo);
  assert.equal(detection.found, true);
  if (!detection.found) return;

  // 200 DPI, not the delivered 300. At the fixture's 150 DPI the honest-upscale
  // limit caps a 300 DPI request from the page but not from the finer source,
  // and two crops of different sizes cannot be compared pixel for pixel. 200
  // DPI is within reach of both, which isolates ALIGNMENT from the resolution
  // question the next test covers.
  const comparableDpi = 200;
  const baseline = renderPhotoCrop(rgb, detection.quad, PASSPORT, PX_PER_MM, comparableDpi);

  const { finer, transform, pxPerMM } = doubleResolution(rgb);
  const source: PhotoSource = { image: finer, transform, pxPerMM };
  const viaFiner = renderPhotoCrop(rgb, detection.quad, PASSPORT, PX_PER_MM, comparableDpi, source);

  assert.equal(baseline.lowResolution, false, "the comparison must not be against a capped crop");
  assert.equal(viaFiner.width, baseline.width);
  assert.equal(viaFiner.height, baseline.height);

  // The two crops are not bit-identical and should not be: one resamples the
  // page, the other resamples a finer rendering of it. But a MISALIGNMENT of
  // even a millimetre moves a hard photo edge across many pixels and would push
  // this well into double digits. Same content, same place.
  const difference = meanAbsDifference(viaFiner.image, baseline.image);
  assert.ok(difference < 6, `crops disagree by ${difference.toFixed(2)} levels — the transform is misaligned`);
});

test("finer pixels remove the upscale that would otherwise cap confidence", () => {
  // At 150 DPI the fixture's photo is ~207 px on its short edge, against a
  // 413 px target: a 2.0x upscale, past the honest limit, so the crop is
  // delivered small and the field's confidence is capped. Given a source with
  // twice the detail, the same target needs no upscaling at all and the cap is
  // not applied — which is the entire point of sampling the original.
  const { rgb, truth } = renderSyntheticForm({});
  assert.ok(truth.photo);

  const detection = detectOn(rgb, truth.photo);
  assert.equal(detection.found, true);
  if (!detection.found) return;

  const baseline = renderPhotoCrop(rgb, detection.quad, PASSPORT, PX_PER_MM);
  assert.equal(baseline.lowResolution, true, "the 150 DPI page cannot honestly reach 300 DPI");

  const { finer, transform, pxPerMM } = doubleResolution(rgb);
  const viaFiner = renderPhotoCrop(rgb, detection.quad, PASSPORT, PX_PER_MM, 300, {
    image: finer,
    transform,
    pxPerMM,
  });

  assert.equal(viaFiner.lowResolution, false);
  assert.equal(viaFiner.width, 413);
  assert.equal(viaFiner.height, 531);
  assert.ok(
    viaFiner.width > baseline.width,
    `finer source should deliver a larger crop, got ${viaFiner.width} against ${baseline.width}`,
  );
});
