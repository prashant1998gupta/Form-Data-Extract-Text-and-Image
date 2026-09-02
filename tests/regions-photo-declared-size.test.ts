import assert from "node:assert/strict";
import test from "node:test";

import { extractRegions } from "../lib/pipeline/extract-regions.ts";
import { parseCustomTemplate } from "../lib/templates/custom.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * A photograph that is not a passport photograph.
 *
 * THE BUG THIS PINS. A template taught by DRAWING never states a physical
 * photo size — the person drags a box round whatever is on their form and
 * presses save. The parser filled that silence with `passport35x45`, and the
 * detector then measured the quadrilateral it had found against 35x45 mm with
 * a 0.72-1.35 size window. On a hospital form carrying a 55x74 mm print that
 * arithmetic gives 1.57, so a photograph the detector had located correctly,
 * edge by edge, was refused as the wrong size — reported to the operator as
 * "Not Detected" with no crop at all.
 *
 * The person drew the box round the photo. The box IS the declared size, to
 * within the few millimetres a finger carries. Nothing else on a drawn
 * template can supply it, and guessing "passport" is a guess wearing a
 * declaration's clothes.
 */

const PX_PER_MM = 150 / 25.4;

function truthMM(rect: { x: number; y: number; width: number; height: number }) {
  return {
    xMM: rect.x / PX_PER_MM,
    yMM: rect.y / PX_PER_MM,
    widthMM: rect.width / PX_PER_MM,
    heightMM: rect.height / PX_PER_MM,
  };
}

async function extractDrawnPhoto(photoScale: number, errorMM = 2) {
  const { rgb, truth } = renderSyntheticForm({ photoScale, withThumb: false });
  assert.ok(truth.photo, "the fixture must paste a photograph");

  const box = truthMM(truth.photo);
  const template = parseCustomTemplate({
    name: "Taught form",
    page: "A4",
    fields: [
      {
        type: "photograph",
        // Drawn a little wide, as a finger on a phone always is.
        box: {
          xMM: box.xMM - errorMM * 0.5,
          yMM: box.yMM - errorMM * 0.5,
          widthMM: box.widthMM + errorMM,
          heightMM: box.heightMM + errorMM,
        },
      },
    ],
  });

  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const { result } = await extractRegions(bytes, { template });
  const photo = result.regions.find((r) => r.key === "patientPhotograph");
  assert.ok(photo);
  return photo;
}

// 1.0 is the passport case the suite already covers; the rest are the sizes a
// real hospital or school form actually carries.
for (const scale of [1, 1.3, 1.6]) {
  test(`a drawn box round a ${(35 * scale).toFixed(0)}x${(45 * scale).toFixed(0)} mm photograph extracts it`, async () => {
    const photo = await extractDrawnPhoto(scale);
    assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
  });
}

test("a drawn photo box does not silently claim passport dimensions", async () => {
  // The delivered crop must be the shape of the photograph on the paper, not
  // the shape of a passport print the person never mentioned.
  const photo = await extractDrawnPhoto(1.6);
  assert.equal(photo.found, true, photo.found ? "" : `refused: ${photo.detail}`);
  assert.ok(photo.width && photo.height);
  const aspect = photo.width / photo.height;
  assert.ok(Math.abs(aspect - 35 / 45) < 0.08, `crop aspect ${aspect.toFixed(3)} should follow the drawn box`);
  // 1.6x a 35 mm print is ~56 mm; at the delivered 300 dpi that is ~660 px.
  assert.ok(photo.width > 520, `crop is ${photo.width}px wide — it was cut to passport size`);
});
