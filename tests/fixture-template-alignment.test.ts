import assert from "node:assert/strict";
import test from "node:test";

import { FIELD_VALUES, renderSyntheticForm } from "./helpers/synthetic-form.ts";
import { HOSPITAL_TEMPLATE } from "../lib/templates/seed.ts";
import { allFields, isImageField } from "../lib/templates/types.ts";

/**
 * The fixture and the template must agree about where the answers are.
 *
 * THE BUG THIS PINS. For a long time the generator flowed its field rows one
 * row above the seed template's declared boxes, and nothing noticed: the
 * handwriting was unreadable scrawl, so a crop of "Patient Name" containing
 * the AGE row's ink was indistinguishable from a correct one. The moment the
 * handwriting became legible, that misalignment became the exact catastrophe
 * this product is built to refuse — a real value under a wrong label, served
 * as evidence. Alignment is now measured, not assumed.
 *
 * The tolerance is the reader's own: `evidenceRect` pads a declared box by
 * 2.5 mm, so ink within box ± 2.5 mm is ink the reader's crop captures.
 */

const PAD_MM = 2.5;

test("every handwritten value's ink lands inside its template box, as the reader will crop it", () => {
  const { rgb, truth } = renderSyntheticForm({});
  const mmX = rgb.width / HOSPITAL_TEMPLATE.page.widthMM;
  const mmY = rgb.height / HOSPITAL_TEMPLATE.page.heightMM;

  const declared = allFields(HOSPITAL_TEMPLATE).filter((field) => !isImageField(field.type) && field.box);
  assert.equal(truth.fields.length, declared.length, "one fixture row per declared text field");

  truth.fields.forEach((ink, index) => {
    const field = declared[index];
    assert.equal(ink.label, field.label, `row ${index} is the field the template declares there`);

    const box = field.box!;
    const inkTopMM = ink.box.y / mmY;
    const inkBottomMM = (ink.box.y + ink.box.height) / mmY;
    const inkLeftMM = ink.box.x / mmX;

    assert.ok(
      inkTopMM >= box.yMM - PAD_MM && inkBottomMM <= box.yMM + box.heightMM + PAD_MM,
      `${field.label}: ink spans ${inkTopMM.toFixed(1)}..${inkBottomMM.toFixed(1)} mm but the box is ` +
        `${box.yMM}..${box.yMM + box.heightMM} mm (±${PAD_MM}) — the reader would crop another row's answer`,
    );
    assert.ok(
      inkLeftMM >= box.xMM - PAD_MM,
      `${field.label}: ink starts at ${inkLeftMM.toFixed(1)} mm, left of the box at ${box.xMM} mm (±${PAD_MM}) — ` +
        `the crop would guillotine the first letters`,
    );
  });
});

test("the fixture writes exactly the ground-truth values, and ink was actually laid for each", () => {
  const { truth } = renderSyntheticForm({});
  for (const field of truth.fields) {
    assert.equal(field.value, FIELD_VALUES[field.label], `${field.label} writes its declared value`);
    assert.ok(field.box.width > 10 && field.box.height > 5, `${field.label} laid real ink, not an empty box`);
  }
});

test("alignment survives the desk-photo variant the bundled sample is generated from", () => {
  // The page is inset by the desk margin here, so this catches any future
  // drift between page-relative and frame-relative arithmetic.
  const { truth } = renderSyntheticForm({ desk: 110, shadow: 0.28, noise: 0.03 });
  const page = truth.page;
  const mmY = page.height / HOSPITAL_TEMPLATE.page.heightMM;
  const declared = allFields(HOSPITAL_TEMPLATE).filter((field) => !isImageField(field.type) && field.box);

  truth.fields.forEach((ink, index) => {
    const box = declared[index].box!;
    const inkTopMM = (ink.box.y - page.y) / mmY;
    const inkBottomMM = (ink.box.y + ink.box.height - page.y) / mmY;
    assert.ok(
      inkTopMM >= box.yMM - PAD_MM && inkBottomMM <= box.yMM + box.heightMM + PAD_MM,
      `${declared[index].label}: ink ${inkTopMM.toFixed(1)}..${inkBottomMM.toFixed(1)} mm vs box ` +
        `${box.yMM}..${box.yMM + box.heightMM} mm on the desk capture`,
    );
  });
});
