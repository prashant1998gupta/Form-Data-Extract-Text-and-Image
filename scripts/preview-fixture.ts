/**
 * Renders the synthetic form fixtures to PNG so a human can look at them.
 *
 * The detector tests assert IoU against the generator's ground truth, which is
 * only meaningful if the generator actually produces something form-shaped.
 * This exists so that claim can be checked by eye rather than assumed.
 *
 *   node --experimental-strip-types scripts/preview-fixture.ts
 *
 * Output lands in tests/fixtures/generated/ (gitignored).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "../tests/helpers/synthetic-form.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "..", "tests", "fixtures", "generated");

const variants: { name: string; options: SyntheticFormOptions }[] = [
  { name: "01-clean-scan", options: {} },
  { name: "02-desk-photo", options: { desk: 110, shadow: 0.28, noise: 0.03 } },
  { name: "03-skewed", options: { desk: 90, skew: 4.5, shadow: 0.2 } },
  { name: "04-photocopy", options: { photocopy: true, monochromePhoto: true, noise: 0.04 } },
  { name: "05-glare", options: { desk: 80, glare: true, shadow: 0.35 } },
  { name: "06-crooked-photo", options: { photoRotation: 6 } },
  { name: "07-nothing-pasted", options: { withPhoto: false, withSignature: false, withThumb: false } },
  { name: "08-signature-only", options: { withPhoto: false, withThumb: false } },
];

await mkdir(outputDir, { recursive: true });

for (const variant of variants) {
  const { rgb, truth } = renderSyntheticForm(variant.options);
  const png = await encodeRgbPng(rgb);
  await writeFile(join(outputDir, `${variant.name}.png`), png);
  const describe = (name: string, box: { x: number; y: number; width: number; height: number } | null) =>
    box ? `${name} ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}` : `${name} —`;
  console.log(
    `${variant.name.padEnd(22)} ${rgb.width}x${rgb.height}  ` +
      `${describe("photo", truth.photo)}  ${describe("sig", truth.signature)}  ${describe("thumb", truth.thumb)}  ` +
      `fields ${truth.fields.length}`,
  );
}

console.log(`\nWrote ${variants.length} fixtures to ${outputDir}`);
