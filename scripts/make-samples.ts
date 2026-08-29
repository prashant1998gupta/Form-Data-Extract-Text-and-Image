/**
 * Regenerates the bundled sample forms in public/samples/ from the synthetic
 * generator, so what the demo ships is exactly what the test suite exercises.
 *
 *   node --experimental-strip-types scripts/make-samples.ts
 *
 * Three captures, chosen to be the three conversations a hospital actually
 * has: a phone photo on a desk (the modal capture), a photocopy (the modal
 * degradation), and an unfilled form (the modal disappointment — and the case
 * a detector must refuse rather than invent).
 *
 * The handwriting on the filled samples is LEGIBLE and its values are the
 * generator's `FIELD_VALUES` ground truth, so a demo run with an AI key can be
 * checked against a known answer — a sample that manufactures its own
 * illegibility cannot demonstrate reading.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeRgbJpeg } from "../lib/vision/io.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "../tests/helpers/synthetic-form.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "..", "public", "samples");

const samples: { name: string; options: SyntheticFormOptions }[] = [
  { name: "filled-desk-photo", options: { desk: 110, shadow: 0.28, noise: 0.03 } },
  { name: "filled-photocopy", options: { photocopy: true, monochromePhoto: true, noise: 0.04 } },
  { name: "unfilled", options: { withPhoto: false, withSignature: false, withThumb: false } },
];

for (const sample of samples) {
  const { rgb, truth } = renderSyntheticForm(sample.options);
  const jpeg = await encodeRgbJpeg(rgb, undefined, 85);
  await writeFile(join(outputDir, `${sample.name}.jpg`), jpeg);
  console.log(`${sample.name}.jpg  ${rgb.width}x${rgb.height}  ${(jpeg.length / 1024).toFixed(0)} KB  fields ${truth.fields.length}`);
}
