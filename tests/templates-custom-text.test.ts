import assert from "node:assert/strict";
import test from "node:test";

import { parseCustomTemplate, TemplateError } from "../lib/templates/custom.ts";
import type { DrawnTemplate } from "../lib/templates/drawn.ts";
import { allFields } from "../lib/templates/types.ts";
import { readableFields } from "../lib/reader/types.ts";

/**
 * Taught TEXT fields cross the same trust boundary as the drawn boxes, with
 * one extra stake: the LABEL is quoted verbatim into the prompt the reader
 * sends to a model. These tests hold the parser to that: bounded, cleaned,
 * unambiguous, and never cast.
 */

function withText(textFields: unknown): DrawnTemplate {
  return {
    name: "School Admission Form",
    page: "A4",
    fields: [{ type: "photograph", box: { xMM: 150, yMM: 25, widthMM: 35, heightMM: 45 } }],
    textFields: textFields as DrawnTemplate["textFields"],
  };
}

test("a taught text field parses into a readable, drawn field", () => {
  const template = parseCustomTemplate(
    withText([{ label: "Student Name", textType: "name", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } }]),
  );
  const readable = readableFields(template);
  assert.equal(readable.length, 1);
  assert.equal(readable[0].label, "Student Name");
  assert.equal(readable[0].type, "name");
  assert.equal(readable[0].key, "student_name");
  assert.equal(readable[0].origin, "drawn");
  assert.ok(readable[0].box);
});

test("a template taught before text fields existed still parses", () => {
  const stored = {
    name: "Old form",
    page: "A4",
    fields: [{ type: "signature", box: { xMM: 20, yMM: 250, widthMM: 70, heightMM: 20 } }],
    // no textFields member at all — a localStorage template from an old session
  };
  const template = parseCustomTemplate(stored);
  assert.equal(allFields(template).length, 1);
});

test("a label is required, bounded, and stripped of control characters", () => {
  assert.throws(
    () => parseCustomTemplate(withText([{ label: "   ", textType: "name", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } }])),
    (error: unknown) => error instanceof TemplateError && error.code === "template_text_field_no_label",
  );
  assert.throws(
    () => parseCustomTemplate(withText([{ label: "x".repeat(61), textType: "name", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } }])),
    (error: unknown) => error instanceof TemplateError && error.code === "template_label_too_long",
  );
  const template = parseCustomTemplate(
    withText([{ label: "Mobile  Number", textType: "phone", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } }]),
  );
  assert.equal(readableFields(template)[0].label, "Mobile Number");
});

test("two fields with one label are refused — an ambiguity review cannot resolve", () => {
  assert.throws(
    () =>
      parseCustomTemplate(
        withText([
          { label: "Name", textType: "name", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } },
          { label: "name", textType: "shortText", box: { xMM: 30, yMM: 80, widthMM: 90, heightMM: 8 } },
        ]),
      ),
    (error: unknown) => error instanceof TemplateError && error.code === "template_duplicate_label",
  );
});

test("an unknown answer type is refused, not defaulted", () => {
  assert.throws(
    () => parseCustomTemplate(withText([{ label: "Name", textType: "dropdown", box: { xMM: 30, yMM: 60, widthMM: 90, heightMM: 8 } }])),
    (error: unknown) => error instanceof TemplateError && error.code === "template_bad_text_type",
  );
});

test("text boxes are clamped to the page like every drawn box", () => {
  const template = parseCustomTemplate(
    withText([{ label: "Notes", textType: "longText", box: { xMM: 200, yMM: 60, widthMM: 50, heightMM: 8 } }]),
  );
  const field = readableFields(template)[0];
  assert.ok(field.box!.xMM + field.box!.widthMM <= 210, "clamped to A4's width");
});

test("a text-only taught form is legitimate — many real forms have no photo or signature", () => {
  const template = parseCustomTemplate({
    name: "Feedback slip",
    page: "A4",
    fields: [],
    textFields: [{ label: "Comments", textType: "longText", box: { xMM: 20, yMM: 60, widthMM: 170, heightMM: 40 } }],
  });
  assert.equal(readableFields(template).length, 1);

  // Nothing at all is still refused.
  assert.throws(
    () => parseCustomTemplate({ name: "Empty", page: "A4", fields: [], textFields: [] }),
    (error: unknown) => error instanceof TemplateError && error.code === "template_no_fields",
  );
});

test("the combined field count is bounded", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    label: `Field ${i}`,
    textType: "shortText",
    box: { xMM: 10, yMM: 10 + i * 5, widthMM: 50, heightMM: 6 },
  }));
  assert.throws(
    () => parseCustomTemplate(withText(many)),
    (error: unknown) => error instanceof TemplateError && error.code === "template_too_many_fields",
  );
});
