/**
 * End-to-end region extraction on the synthetic corpus, with no model calls.
 *
 *   node --experimental-strip-types scripts/demo-extract.ts
 *
 * Renders a form, runs the full deterministic pipeline over it, and writes the
 * delivered crops to disk alongside a report. Every number printed is measured
 * against the generator's ground truth, so the output is checkable rather than
 * merely impressive.
 *
 * The last two variants have nothing pasted on them. They are the important
 * ones: a detector that finds photographs reliably AND finds one in an empty
 * printed box is not usable in a hospital, and the empty case is the one a demo
 * never shows.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectPhoto } from "../lib/regions/photo.ts";
import { detectSignature } from "../lib/regions/signature.ts";
import { detectThumb } from "../lib/regions/thumb.ts";
import { flattenOntoWhite, renderPhotoCrop, renderSignatureCrop } from "../lib/regions/postprocess.ts";
import { encodeRgbPng, encodeRgbaPng } from "../lib/vision/io.ts";
import { boundsOf, containment, iou, quadPoints, type Rect } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "../tests/helpers/synthetic-form.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outputDir = join(here, "..", "tests", "fixtures", "generated", "extracted");

/** The generator renders at 150 dpi. */
const PX_PER_MM = 150 / 25.4;
const PASSPORT = { widthMM: 35, heightMM: 45 };

const variants: { name: string; options: SyntheticFormOptions }[] = [
  { name: "01-clean", options: {} },
  { name: "02-shadow", options: { shadow: 0.35, noise: 0.04 } },
  { name: "03-photocopy", options: { photocopy: true, monochromePhoto: true, noise: 0.03 } },
  { name: "04-glare", options: { glare: true, shadow: 0.25 } },
  { name: "05-crooked-photo", options: { photoRotation: 6 } },
  { name: "06-nothing-pasted", options: { withPhoto: false, withSignature: false, withThumb: false } },
  { name: "07-signature-only", options: { withPhoto: false, withThumb: false } },
  // Added because the README quoted numbers for both conditions while this
  // script measured neither. A published accuracy figure that no command
  // reproduces is indistinguishable from one that was made up, and this file is
  // the thing the README points at when it says "measurements, not estimates".
  { name: "08-skewed-page", options: { skew: 4.5, shadow: 0.2 } },
];

await mkdir(outputDir, { recursive: true });

const rows: string[] = [];

for (const variant of variants) {
  const { rgb, truth } = renderSyntheticForm(variant.options);

  // Registration is simulated: the template's boxes as a real pipeline would
  // report them after fitting a homography — close, but not exact. Feeding the
  // detectors the ground truth would test a situation that never occurs.
  const photoBox: Rect = jitter(truth.photo ?? { x: 940, y: 173, width: 213, height: 272 });
  const signatureBox: Rect = { x: 96, y: 1330, width: 470, height: 130 };
  const thumbBox: Rect = { x: 880, y: 1380, width: 180, height: 220 };

  const channels = prepareChannels(rgb, {
    pxPerMM: PX_PER_MM,
    imageRegions: [photoBox, signatureBox, thumbBox],
  });

  // ---- photograph ---------------------------------------------------------
  const photo = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected: photoBox,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  let photoCell = "";
  if (photo.found) {
    const crop = renderPhotoCrop(rgb, photo.quad, PASSPORT, PX_PER_MM);
    await writeFile(join(outputDir, `${variant.name}-photo.png`), await encodeRgbPng(crop.image));
    const overlap = truth.photo ? iou(boundsOf(quadPoints(photo.quad)), truth.photo) : NaN;
    photoCell =
      `${crop.width}x${crop.height} @${crop.effectiveDpi}dpi  conf ${photo.confidence.toFixed(2)}` +
      `  rot ${photo.rotationDegrees.toFixed(1)}deg` +
      (Number.isNaN(overlap) ? "  [FALSE POSITIVE]" : `  IoU ${overlap.toFixed(3)}`) +
      (crop.lowResolution ? "  low-res" : "");
  } else {
    photoCell = `Not Detected (${photo.reason})`;
    if (truth.photo) photoCell += "  [MISS]";
  }

  // ---- signature ----------------------------------------------------------
  const signature = detectSignature({
    ink: channels.ink,
    roi: signatureBox,
    pxPerMM: PX_PER_MM,
    baselineY: 1444,
  });

  let signatureCell = "";
  if (signature.found) {
    const crop = renderSignatureCrop(rgb, signature.mask, signature.bounds, PX_PER_MM);
    await writeFile(join(outputDir, `${variant.name}-signature.png`), await encodeRgbaPng(crop.rgba, crop.width, crop.height));
    await writeFile(
      join(outputDir, `${variant.name}-signature-flat.png`),
      await encodeRgbPng(flattenOntoWhite(crop.rgba, crop.width, crop.height)),
    );
    const held = truth.signature ? containment(truth.signature, signature.bounds) : NaN;
    const ink = crop.inkColour;
    signatureCell =
      `${crop.width}x${crop.height}  conf ${signature.confidence.toFixed(2)}` +
      `  ink rgb(${ink[0]},${ink[1]},${ink[2]})` +
      (Number.isNaN(held) ? "  [FALSE POSITIVE]" : `  contains ${held.toFixed(3)}`);
  } else {
    signatureCell = `Not Detected (${signature.reason})`;
    if (truth.signature) signatureCell += "  [MISS]";
  }

  // ---- thumb impression ---------------------------------------------------
  const thumb = detectThumb({ ink: channels.ink, rgb, roi: thumbBox, pxPerMM: PX_PER_MM });
  let thumbCell = "";
  if (thumb.found) {
    const crop = renderSignatureCrop(rgb, thumb.mask, thumb.bounds, PX_PER_MM);
    await writeFile(join(outputDir, `${variant.name}-thumb.png`), await encodeRgbaPng(crop.rgba, crop.width, crop.height));
    const held = truth.thumb ? containment(truth.thumb, thumb.bounds) : NaN;
    thumbCell =
      `${crop.width}x${crop.height}  conf ${thumb.confidence.toFixed(2)} (capped)  always-review` +
      (Number.isNaN(held) ? "  [FALSE POSITIVE]" : `  contains ${held.toFixed(3)}`);
  } else {
    thumbCell = `Not Detected (${thumb.reason})`;
    if (thumb.wrongBoxWarning) thumbCell += `  WARNING: ${thumb.wrongBoxWarning}`;
    if (truth.thumb) thumbCell += "  [MISS]";
  }

  rows.push(`${variant.name.padEnd(20)} photo: ${photoCell}`);
  rows.push(`${" ".repeat(20)} sig:   ${signatureCell}`);
  rows.push(`${" ".repeat(20)} thumb: ${thumbCell}`);
  rows.push("");
}

console.log("");
console.log("Region extraction — deterministic pipeline, zero model calls");
console.log("=".repeat(78));
console.log("");
for (const row of rows) console.log(row);
console.log(`Crops written to ${outputDir}`);

/**
 * Perturbs a box the way registration residue would: a couple of millimetres of
 * offset and a few percent of scale error.
 */
function jitter(rect: Rect): Rect {
  const dx = 4;
  const dy = -3;
  const scale = 0.97;
  return {
    x: rect.x + dx + (rect.width * (1 - scale)) / 2,
    y: rect.y + dy + (rect.height * (1 - scale)) / 2,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}
