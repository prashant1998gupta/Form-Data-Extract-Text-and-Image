import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { verifyTemplateAnchors } from "../lib/regions/template-anchors.ts";
import { extractRegions } from "../lib/pipeline/extract-regions.ts";
import { HOSPITAL_TEMPLATE } from "../lib/templates/seed.ts";
import type { FormTemplate } from "../lib/templates/types.ts";
import { encodeRgbPng } from "../lib/vision/io.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * Template IDENTITY, which is a different question from template presence.
 *
 * `form-presence.ts` asks "is this a printed form at all" — a question a school
 * certificate, a bank mandate and a takeaway menu all answer yes to. That gate
 * could never have caught the failure that reached a user: a DIFFERENT form
 * measured against the hospital template's coordinates, where the signature box
 * lands on a table of handwritten entries and the detector faithfully reports
 * the handwriting it was pointed at.
 *
 * The check needs no stored reference render, because the template already
 * declares where its printed furniture is — `printedBorder` rectangles and the
 * signature's `baselineMM`. Those are assertions about ink that must be on any
 * genuine copy of the form, blank or filled. So: go and look.
 */

const PX_PER_MM = 150 / 25.4;

/** The same template, with its landmarks declared somewhere the form has none. */
function relocatedTemplate(): FormTemplate {
  return {
    ...HOSPITAL_TEMPLATE,
    sections: HOSPITAL_TEMPLATE.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => ({
        ...field,
        printedBorder: field.printedBorder
          ? { ...field.printedBorder, xMM: 20, yMM: 150 }
          : undefined,
        baselineMM: field.baselineMM === undefined ? undefined : 160,
      })),
    })),
  };
}

function anchorsFor(template: FormTemplate) {
  const { rgb } = renderSyntheticForm({});
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [] });
  return verifyTemplateAnchors({ inkWithRules: channels.inkWithRules, template, pxPerMM: PX_PER_MM });
}

test("the seeded template's landmarks are found on the form it describes", () => {
  const registration = anchorsFor(HOSPITAL_TEMPLATE);
  assert.equal(registration.registered, true, registration.detail);
  assert.ok(
    registration.anchorsFound >= 2,
    `expected most landmarks found, got ${registration.anchorsFound}/${registration.anchorsChecked}`,
  );
});

test("landmarks declared where the form has none do not register", () => {
  // Standing in for "this is a different form": same page, same printing, but
  // the template's assertions about where its furniture sits are false.
  const registration = anchorsFor(relocatedTemplate());
  assert.equal(registration.registered, false, registration.detail);
  assert.match(registration.detail, /landmarks/);
});

test("an unfilled form still registers — the printed layer is what is measured", () => {
  // The landmarks are PRINTED furniture, so they must be found on a blank form
  // exactly as on a filled one. If this regresses, the product demo starts
  // reporting its three honest refusals as "not this form".
  const { rgb } = renderSyntheticForm({ withPhoto: false, withSignature: false, withThumb: false });
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [] });
  const registration = verifyTemplateAnchors({
    inkWithRules: channels.inkWithRules,
    template: HOSPITAL_TEMPLATE,
    pxPerMM: PX_PER_MM,
  });
  assert.equal(registration.registered, true, registration.detail);
});

// ---------------------------------------------------------------------------
// The asymmetry: positive claims survive, negative claims do not
// ---------------------------------------------------------------------------

test("without registration, absence is never asserted and crops lose their labels", async () => {
  const { rgb } = renderSyntheticForm({});
  const bytes = new Uint8Array(await encodeRgbPng(rgb));

  const trusted = await extractRegions(bytes, { template: HOSPITAL_TEMPLATE });
  const untrusted = await extractRegions(bytes, { template: relocatedTemplate() });

  assert.equal(trusted.result.registration.registered, true);
  assert.equal(untrusted.result.registration.registered, false);

  for (const region of untrusted.result.regions) {
    if (region.found) {
      // A POSITIVE finding survives: something really is there, and the
      // operator should see it. What is removed is the claim that it is this
      // field — the reported failure delivered a photograph of a table headed
      // "Patient Signature" at 92%.
      assert.equal(region.unverifiedTemplate, true, `${region.key} must be flagged unverified`);
      assert.equal(region.needsReview, true, `${region.key} must be forced to review`);
    } else {
      // A NEGATIVE finding does not survive. "The box is empty" is a claim
      // about a LOCATION, and the location is exactly what is not established.
      assert.equal(
        region.reason,
        "geometry_unknown",
        `${region.key} must not assert a located box when the template is unverified`,
      );
      assert.notEqual(region.reason, "box_empty");
    }
  }
});

test("with registration, nothing is downgraded", async () => {
  // The other direction, and the one that protects the product: a genuine form
  // measured against its own template keeps every claim it earned.
  const { rgb } = renderSyntheticForm({});
  const bytes = new Uint8Array(await encodeRgbPng(rgb));
  const { result } = await extractRegions(bytes, { template: HOSPITAL_TEMPLATE });

  assert.equal(result.registration.registered, true);
  for (const region of result.regions) {
    assert.notEqual(region.unverifiedTemplate, true, `${region.key} must not be flagged`);
  }
  assert.ok(
    result.regions.some((r) => r.found),
    "the filled form must still produce crops",
  );
});
