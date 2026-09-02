import assert from "node:assert/strict";
import test from "node:test";

import { parseCustomTemplate, TemplateError } from "../lib/templates/custom.ts";
import type { DrawnTemplate } from "../lib/templates/drawn.ts";
import { allFields } from "../lib/templates/types.ts";

/**
 * Parsing a form taught by a person.
 *
 * This is a TRUST BOUNDARY. The template arrives from the browser, so every
 * field is attacker-controlled, and these coordinates decide where a crop is cut
 * out of the uploaded image. The bar is therefore "parse, do not cast": nothing
 * in the module under test is `as FormTemplate`, and these tests exist to keep
 * it that way.
 *
 * The NaN cases are the ones worth staring at. `JSON.parse` will not produce a
 * NaN, but a hand-built request body can, and NaN propagates silently through
 * every comparison that follows — `NaN < MIN` is false, so a naive floor check
 * PASSES a NaN and hands it downstream. This codebase has already been bitten
 * by exactly that once: a fractional rectangle indexed a summed-area table at a
 * non-integer, read `undefined`, produced NaN, and skipped a safety gate,
 * turning an empty photo box into a stored crop.
 */

function valid() {
  return {
    name: "JNV Study Certificate",
    page: "A4",
    fields: [
      { type: "photograph", box: { xMM: 150, yMM: 25, widthMM: 35, heightMM: 45 } },
      { type: "signature", box: { xMM: 20, yMM: 250, widthMM: 70, heightMM: 20 } },
    ],
  };
}

test("a well-formed taught template parses", () => {
  const template = parseCustomTemplate(valid());
  assert.equal(template.name, "JNV Study Certificate");
  assert.equal(template.hasGeometry, true);
  assert.equal(allFields(template).length, 2);
});

test("every drawn field is marked as drawn, not registered", () => {
  // Load-bearing, not cosmetic. The photo detector widens its prior for a drawn
  // box; without this flag it applies the registered prior, which is measured to
  // REFUSE a box 4 mm out. A template taught by dragging would appear simply not
  // to work, with no error explaining why.
  const template = parseCustomTemplate(valid());
  for (const field of allFields(template)) {
    assert.equal(field.origin, "drawn", `${field.key} must be marked drawn`);
  }
});

test("a drawn photograph field declares the size of the box that was drawn", () => {
  // NOT `photoSize: "passport35x45"`, which is what this used to assert. A
  // drawn template names no size, and filling that silence with the commonest
  // one made a guess indistinguishable from a declaration: every photograph
  // outside 25-47 mm wide was located correctly by the detector and then
  // refused for not being a passport print.
  const template = parseCustomTemplate(valid());
  const photo = allFields(template).find((f) => f.type === "photograph");
  assert.ok(photo);
  assert.equal(photo.photoSize, undefined);
  assert.deepEqual(photo.photoSizeMM, { widthMM: 35, heightMM: 45 });
  // And the looser window that a dragged box, unlike a named size, requires.
  assert.ok(photo.photoSizeTolerance);
  assert.ok(photo.photoSizeTolerance.min < 0.72);
});

test("a photograph box drawn round a larger print declares that larger size", () => {
  const source = valid();
  source.fields[0] = { type: "photograph", box: { xMM: 140, yMM: 20, widthMM: 58, heightMM: 76 } };
  const photo = allFields(parseCustomTemplate(source)).find((f) => f.type === "photograph");
  assert.ok(photo);
  assert.deepEqual(photo.photoSizeMM, { widthMM: 58, heightMM: 76 });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

const REJECTED: [string, unknown][] = [
  ["not an object", "nope"],
  ["null", null],
  ["no fields array", { name: "x", fields: "many" }],
  ["empty fields", { name: "x", fields: [] }],
  ["unknown page size", { name: "x", page: "A0", fields: valid().fields }],
  [
    "a text field type, which has no detector",
    { name: "x", fields: [{ type: "shortText", box: { xMM: 10, yMM: 10, widthMM: 20, heightMM: 20 } }] },
  ],
  [
    "a box with no numbers",
    { name: "x", fields: [{ type: "photograph", box: { xMM: "10", yMM: 10, widthMM: 20, heightMM: 20 } }] },
  ],
  [
    "a NaN width",
    { name: "x", fields: [{ type: "photograph", box: { xMM: 10, yMM: 10, widthMM: NaN, heightMM: 20 } }] },
  ],
  [
    "an infinite height",
    { name: "x", fields: [{ type: "photograph", box: { xMM: 10, yMM: 10, widthMM: 20, heightMM: Infinity } }] },
  ],
  [
    "a sub-millimetre box",
    { name: "x", fields: [{ type: "photograph", box: { xMM: 10, yMM: 10, widthMM: 1, heightMM: 1 } }] },
  ],
  [
    "two boxes for the same element",
    {
      name: "x",
      fields: [
        { type: "photograph", box: { xMM: 10, yMM: 10, widthMM: 30, heightMM: 40 } },
        { type: "photograph", box: { xMM: 60, yMM: 10, widthMM: 30, heightMM: 40 } },
      ],
    },
  ],
];

for (const [label, payload] of REJECTED) {
  test(`refuses ${label}`, () => {
    assert.throws(() => parseCustomTemplate(payload), TemplateError);
  });
}

test("refuses a template with absurdly many fields", () => {
  const fields = Array.from({ length: 500 }, () => ({
    type: "photograph",
    box: { xMM: 10, yMM: 10, widthMM: 30, heightMM: 40 },
  }));
  assert.throws(() => parseCustomTemplate({ name: "x", fields }), TemplateError);
});

// ---------------------------------------------------------------------------
// Clamping
// ---------------------------------------------------------------------------

test("a box overhanging the page is trimmed, not refused", () => {
  // A person drawing near the edge of the sheet routinely overshoots by a
  // millimetre or two. Refusing that is a worse product than trimming it, and
  // the trimmed box still addresses the right part of the paper.
  const template = parseCustomTemplate({
    name: "x",
    fields: [{ type: "photograph", box: { xMM: 190, yMM: 280, widthMM: 60, heightMM: 60 } }],
  });
  const box = allFields(template)[0]!.box!;
  assert.ok(box.xMM + box.widthMM <= 210 + 1e-9, `right edge ${box.xMM + box.widthMM} must stay on an A4 page`);
  assert.ok(box.yMM + box.heightMM <= 297 + 1e-9, `bottom edge ${box.yMM + box.heightMM} must stay on the page`);
});

test("a negative origin is clamped onto the page", () => {
  const template = parseCustomTemplate({
    name: "x",
    fields: [{ type: "photograph", box: { xMM: -50, yMM: -50, widthMM: 40, heightMM: 40 } }],
  });
  const box = allFields(template)[0]!.box!;
  assert.ok(box.xMM >= 0 && box.yMM >= 0, "a box may not start off the page");
});

test("foolscap is offered, because the target market prints on it", () => {
  // Indian hospitals, schools and government offices commonly use FS rather
  // than A4, and its aspect differs by 7.5 % — enough that a form declared A4
  // but printed on FS puts every coordinate progressively further out down the
  // page.
  const template = parseCustomTemplate({ ...valid(), page: "FOOLSCAP" });
  assert.equal(template.page.heightMM, 330.2);
});

// ---------------------------------------------------------------------------
// The contract between the editor and the parser
// ---------------------------------------------------------------------------

test("what the editor emits is what the parser accepts", () => {
  // THE TEST THAT WAS MISSING. Every case above hand-builds the shape the
  // parser wants, so all of them passed while the editor was emitting a FLAT
  // box — `{ type, xMM, yMM, ... }` — against a parser reading a NESTED one.
  // The two halves met for the first time in a browser, which answered "a drawn
  // region has no position" for every save.
  //
  // The annotation is the assertion. Typing this payload as `DrawnTemplate` —
  // the exact type the editor's `onSave` is declared to produce — means the
  // COMPILER fails the next time the two ends diverge, rather than a person
  // discovering it by clicking Save.
  const fromEditor: DrawnTemplate = {
    name: "JNV Study Certificate",
    page: "A4",
    fields: [
      { type: "photograph", box: { xMM: 150, yMM: 25, widthMM: 35, heightMM: 45 } },
      { type: "signature", box: { xMM: 20, yMM: 250, widthMM: 70, heightMM: 20 } },
      { type: "thumbImpression", box: { xMM: 150, yMM: 245, widthMM: 25, heightMM: 30 } },
    ],
  };

  const template = parseCustomTemplate(JSON.parse(JSON.stringify(fromEditor)));
  assert.equal(allFields(template).length, 3);
  for (const field of allFields(template)) {
    assert.ok(field.box, `${field.key} must have a position`);
    assert.equal(field.origin, "drawn");
  }
});
