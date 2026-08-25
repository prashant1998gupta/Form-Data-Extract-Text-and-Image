import assert from "node:assert/strict";
import test from "node:test";

import { extractRegions } from "../lib/pipeline/extract-regions.ts";
import { HOSPITAL_TEMPLATE } from "../lib/templates/seed.ts";
import { allFields, imageFields, isImageField } from "../lib/templates/types.ts";
import { outSize, PHOTO_SIZES } from "../lib/geometry/frames.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * The whole deterministic pipeline, driven by a real template, from encoded
 * bytes to delivered crops.
 *
 * The unit tests exercise each detector against a hand-placed region. These
 * exercise the part that the unit tests cannot: that the template's MILLIMETRE
 * geometry survives decode, page localisation and rectification and still lands
 * on the right part of the page. Every coordinate bug in this project has lived
 * in that chain rather than inside a detector.
 */

async function run(options: SyntheticFormOptions) {
  const { rgb } = renderSyntheticForm(options);
  const png = await encodeRgbPng(rgb);
  const { result } = await extractRegions(new Uint8Array(png), { template: HOSPITAL_TEMPLATE });
  return result;
}

const byKey = (result: Awaited<ReturnType<typeof run>>, key: string) =>
  result.regions.find((region) => region.key === key)!;

test("a clean scan yields all three image elements", async () => {
  const result = await run({});
  for (const key of ["patientPhotograph", "patientSignature", "thumbImpression"]) {
    const region = byKey(result, key);
    assert.ok(region.found, `${key} not found: ${region.detail}`);
    assert.ok(region.png && region.png.length > 0, `${key} produced no image`);
  }
});

test("the photograph is delivered at exactly its declared physical size", async () => {
  // 35x45 mm at 300 dpi is 413x531. Not approximately — the whole point of
  // carrying millimetres through the pipeline is that this number is exact.
  const result = await run({});
  const photo = byKey(result, "patientPhotograph");
  assert.ok(photo.found);

  const expected = outSize(PHOTO_SIZES.passport35x45);
  assert.equal(photo.width, expected.width);
  assert.equal(photo.height, expected.height);
  assert.equal(photo.width, 413);
  assert.equal(photo.height, 531);
});

test("the page is rectified to the canonical raster whatever the capture", async () => {
  // A4 at 200 dpi is 1654x2339. Every downstream millimetre depends on it.
  for (const options of [{}, { desk: 110, shadow: 0.3 }, { skew: 4 }]) {
    const result = await run(options);
    assert.equal(result.rectifiedWidth, 1654, `width for ${JSON.stringify(options)}`);
    assert.equal(result.rectifiedHeight, 2339, `height for ${JSON.stringify(options)}`);
    assert.ok(Math.abs(result.pxPerMM - 7.874) < 0.001);
  }
});

test("a page photographed on a desk is perspective-corrected and still extracts", async () => {
  const result = await run({ desk: 110, shadow: 0.3, noise: 0.03 });
  assert.equal(result.page.method, "perspective", result.page.reason);
  const photo = byKey(result, "patientPhotograph");
  assert.ok(photo.found, `photo not found: ${photo.detail}`);
  assert.ok(photo.confidence! > 0.8, `confidence ${photo.confidence}`);
});

test("a skewed scan has its rotation undone before the template is applied", async () => {
  // The regression this guards: mapping a rotated page onto a square raster
  // without applying the measured skew. The image looks fine and every template
  // coordinate is off by its distance from the centre times the angle. At 4
  // degrees the photograph and thumb both failed while the signature — nearer
  // the centre, and searched in a padded region — still succeeded, which is the
  // hardest kind of failure to attribute.
  for (const skew of [4, -3]) {
    const result = await run({ skew });
    assert.equal(result.page.method, "skew", `skew ${skew}: ${result.page.reason}`);

    for (const key of ["patientPhotograph", "patientSignature", "thumbImpression"]) {
      const region = byKey(result, key);
      assert.ok(region.found, `at ${skew} degrees, ${key} was lost: ${region.detail}`);
    }
  }
});

test("an unfilled form refuses all three, and stores no image", async () => {
  const result = await run({ withPhoto: false, withSignature: false, withThumb: false });
  for (const key of ["patientPhotograph", "patientSignature", "thumbImpression"]) {
    const region = byKey(result, key);
    assert.ok(!region.found, `${key} should not have been found on an unfilled form`);
    assert.equal(region.png, undefined, `${key} must not carry an image when not found`);
    assert.equal(region.confidence, undefined, "a refusal must not carry a confidence number");
    assert.ok(region.reason, `${key} must state why`);
    assert.equal(region.needsReview, true);
  }
});

test("a partially filled form finds what is there and refuses the rest", async () => {
  const result = await run({ withPhoto: false, withThumb: false });
  assert.ok(byKey(result, "patientSignature").found, "the signature is present and must be found");
  assert.ok(!byKey(result, "patientPhotograph").found, "no photo was pasted");
  assert.ok(!byKey(result, "thumbImpression").found, "no thumb was pressed");
});

test("the thumb is always flagged for review, however it scores", async () => {
  const result = await run({});
  const thumb = byKey(result, "thumbImpression");
  assert.ok(thumb.found);
  assert.equal(thumb.needsReview, true, "a thumb crop is always confirmed by a human");
  assert.ok(thumb.confidence! <= 0.7, `confidence ${thumb.confidence} exceeds the cap`);
});

test("the greyscale branch caps the photograph's confidence", async () => {
  const result = await run({ photocopy: true, monochromePhoto: true });
  const photo = byKey(result, "patientPhotograph");
  assert.ok(photo.found, photo.detail);
  assert.ok(photo.confidence! <= 0.72, `photocopy confidence ${photo.confidence} must be capped`);
  assert.equal(photo.needsReview, true);
});

test("only image fields produce regions", async () => {
  const result = await run({});
  assert.equal(result.regions.length, imageFields(HOSPITAL_TEMPLATE).length);
  for (const region of result.regions) {
    assert.ok(isImageField(region.type), `${region.key} is ${region.type}, not an image field`);
  }
});

test("the seeded template declares geometry for every image field", async () => {
  // A template without geometry falls back to whole-page search, which is much
  // worse. The seeded one is the demo, so it must be complete.
  const result = await run({});
  assert.deepEqual(result.fieldsWithoutGeometry, []);
  for (const field of imageFields(HOSPITAL_TEMPLATE)) {
    assert.ok(field.box, `${field.key} has no box`);
  }
});

test("the seeded template's photo field declares its physical size", async () => {
  // Never guessed at detection time — a guessed size lets the detector accept
  // whatever it found and rationalise the dimensions afterwards.
  const photo = allFields(HOSPITAL_TEMPLATE).find((f) => f.type === "photograph")!;
  assert.equal(photo.photoSize, "passport35x45");
  assert.ok(photo.printedBorder, "the printed box is recorded separately from the pasted photo");
});

test("one field's geometry does not change another field's result", async () => {
  // Fields must be independent. They were not: the tone-flattening kernel was
  // derived from the largest declared image region with the relationship
  // INVERTED, so adding a wide signature box shrank the kernel, flattened
  // harder, desaturated the page enough to trip the greyscale branch, and
  // capped the PHOTOGRAPH's confidence at 0.72 — on a photo whose own detection
  // scored 0.994. Nothing about the photograph had changed.
  //
  // This compares the same scan analysed with only the photo field declared
  // against all three declared. The photo's verdict must not move.
  const { rgb } = renderSyntheticForm({ desk: 100, shadow: 0.3, noise: 0.03 });

  const { prepareChannels } = await import("../lib/ink/normalize.ts");
  const { detectPhoto } = await import("../lib/regions/photo.ts");
  const { detectPageQuad } = await import("../lib/vision/page.ts");
  const { warpQuadRgb } = await import("../lib/vision/warp-rgb.ts");
  const { toGray } = await import("../lib/vision/gray.ts");
  const { ctsSize, mmToCts, CTS_PX_PER_MM, A4 } = await import("../lib/geometry/frames.ts");

  const detection = detectPageQuad(toGray(rgb));
  const cts = ctsSize(A4);
  const rectified = warpQuadRgb(rgb, detection.quad, cts.width, cts.height);

  const fields = allFields(HOSPITAL_TEMPLATE);
  const photoField = fields.find((f) => f.type === "photograph")!;
  const expected = mmToCts(photoField.box!);
  const everyImageRegion = fields.filter((f) => isImageField(f.type)).map((f) => mmToCts(f.box!));

  const scoreWith = (regions: typeof everyImageRegion) => {
    const channels = prepareChannels(rectified, { pxPerMM: CTS_PX_PER_MM, imageRegions: regions });
    return detectPhoto({
      lab: channels.lab,
      texture: channels.texture,
      ink: channels.ink,
      paper: channels.paper,
      expected,
      sizeMM: { widthMM: 35, heightMM: 45 },
      pxPerMM: CTS_PX_PER_MM,
      printedBorder: mmToCts(photoField.printedBorder!),
      pageSaturatedFraction: channels.saturatedFraction,
    });
  };

  const alone = scoreWith([expected]);
  const together = scoreWith(everyImageRegion);

  assert.equal(alone.found, together.found, "declaring other fields changed whether the photo was found");
  if (alone.found && together.found) {
    assert.equal(alone.greyscale, together.greyscale, "declaring other fields flipped the greyscale branch");
    assert.ok(
      Math.abs(alone.confidence - together.confidence) < 0.05,
      `photo confidence moved from ${alone.confidence.toFixed(3)} to ${together.confidence.toFixed(3)} ` +
        "purely because other fields were declared",
    );
  }
});

test("extraction reports its own timings", async () => {
  const result = await run({});
  for (const stage of ["decode", "page", "normalise", "detect"]) {
    assert.ok(typeof result.timings[stage] === "number", `missing timing for ${stage}`);
  }
});
