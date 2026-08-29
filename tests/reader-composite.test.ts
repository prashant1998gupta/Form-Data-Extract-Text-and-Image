import assert from "node:assert/strict";
import test from "node:test";

import { buildComposite } from "../lib/reader/composite.ts";
import { parseCompositeReadings } from "../lib/reader/parse.ts";
import { compositeInstruction, COMPOSITE_SYSTEM_PROMPT } from "../lib/reader/prompt.ts";
import { readTextFields } from "../lib/reader/read-text-fields.ts";
import { ProviderError, type ReadRequest, type TextProvider } from "../lib/reader/provider-types.ts";
import { resolveReader } from "../lib/reader/provider.ts";
import { A4, ctsSize } from "../lib/geometry/frames.ts";
import type { FormField, FormTemplate } from "../lib/templates/types.ts";
import type { Rgb } from "../lib/vision/types.ts";

/**
 * The one-request mode, and the property it must never lose: values map to
 * fields BY STRIP NUMBER, never by position in the reply. A reply that skips
 * strip 2 must fail field 2 alone — shifting field 3's value up a field is
 * the misattribution the whole reader design refuses.
 */

const FIELDS: FormField[] = [
  { id: "f1", key: "patientName", label: "Patient Name", type: "name" },
  { id: "f2", key: "age", label: "Age", type: "age" },
  { id: "f3", key: "bloodGroup", label: "Blood Group", type: "dropdown", options: ["A+", "B+", "O+"] },
];

test("a complete reply maps by strip number, in any order", () => {
  const readings = parseCompositeReadings('{"3": "b+", "1": "Anita", "2": ""}', FIELDS);
  assert.equal(readings[0].value, "Anita");
  assert.equal(readings[1].blank, true);
  assert.equal(readings[2].value, "B+", "option matching applies per field in composite mode too");
});

test("a skipped strip fails its own field and must not shift its neighbours", () => {
  const readings = parseCompositeReadings('{"1": "Anita", "3": "B+"}', FIELDS);
  assert.equal(readings[0].value, "Anita");
  assert.ok(readings[1].problem, "the skipped field carries a stated problem");
  assert.equal(readings[2].value, "B+", "field 3 keeps ITS value — nothing slides up");
});

test("a non-JSON reply fails every field in words", () => {
  const readings = parseCompositeReadings("I see three strips", FIELDS);
  for (const reading of readings) assert.ok(reading.problem);
});

test("null and blank stay distinct answers per strip", () => {
  const readings = parseCompositeReadings('{"1": null, "2": "", "3": "B+"}', FIELDS);
  assert.equal(readings[0].value, null);
  assert.equal(readings[0].blank, false);
  assert.equal(readings[1].blank, true);
});

test("the composite instruction numbers every field and demands JSON", () => {
  const instruction = compositeInstruction(FIELDS);
  assert.match(instruction, /1\. "Patient Name"/);
  assert.match(instruction, /3\. "Blood Group"/);
  assert.match(instruction, /A\+, B\+, O\+/);
  assert.match(instruction, /JSON/);
  assert.match(COMPOSITE_SYSTEM_PROMPT, /JSON/);
  // Keys never reach the model — the reply is keyed by strip number alone.
  assert.doesNotMatch(instruction, /patientName|bloodGroup/);
});

test("the composite image stacks every crop full-size with separators and a numbered gutter", () => {
  const crop = (width: number, height: number, tone: number): Rgb => ({
    data: new Uint8ClampedArray(width * height * 3).fill(tone),
    width,
    height,
    channels: 3,
  });
  const composite = buildComposite([crop(200, 60, 120), crop(300, 80, 180)]);

  assert.ok(composite.width >= 300, "wide enough for the widest crop plus the gutter");
  assert.ok(composite.height >= 60 + 80 + 10, "tall enough for both strips and the separator");

  // The separator row between strips is solid black across the full width.
  const separatorY = 60 + 5; // inside the 10px bar after the first 60px strip
  const i = (separatorY * composite.width + Math.floor(composite.width / 2)) * 3;
  assert.equal(composite.data[i], 0);

  // The gutter carries ink (the strip numerals) somewhere in the first strip.
  let gutterInk = false;
  for (let y = 0; y < 60 && !gutterInk; y += 1) {
    for (let x = 0; x < 70; x += 1) {
      if (composite.data[(y * composite.width + x) * 3]! < 100) {
        gutterInk = true;
        break;
      }
    }
  }
  assert.ok(gutterInk, "strip numbers are printed into the image");
});

test("composite mode sends ONE request for the whole scan and distributes by number", async () => {
  const template: FormTemplate = {
    id: "t",
    name: "T",
    page: A4,
    hasGeometry: true,
    sections: [
      {
        id: "s",
        title: "S",
        fields: [
          { id: "f1", key: "patientName", label: "Patient Name", type: "name", box: { xMM: 55, yMM: 47, widthMM: 90, heightMM: 8 } },
          { id: "f2", key: "age", label: "Age", type: "age", box: { xMM: 55, yMM: 58, widthMM: 90, heightMM: 8 } },
        ],
      },
    ],
  };
  const { width, height } = ctsSize(A4);
  const rectified: Rgb = { data: new Uint8ClampedArray(width * height * 3).fill(255), width, height, channels: 3 };

  let requests = 0;
  const provider: TextProvider = {
    name: "groq",
    model: "scripted",
    preferredMode: "composite",
    async read(request: ReadRequest): Promise<string> {
      requests += 1;
      assert.equal(request.system, COMPOSITE_SYSTEM_PROMPT);
      assert.match(request.prompt, /2 strips/);
      return '{"1": "Anita", "2": "34"}';
    },
  };

  const readings = await readTextFields({ rectified, template, provider });
  assert.equal(requests, 1, "one scan, one request");
  assert.equal(readings[0].value, "Anita");
  assert.equal(readings[1].value, "34");
  for (const reading of readings) {
    assert.ok(reading.evidenceJpeg, "evidence stays per field even in one-pass mode");
    assert.ok(reading.regionInPage);
  }
});

test("a composite transport failure fails every field with one shared message", async () => {
  const template: FormTemplate = {
    id: "t",
    name: "T",
    page: A4,
    hasGeometry: true,
    sections: [
      {
        id: "s",
        title: "S",
        fields: [{ id: "f1", key: "age", label: "Age", type: "age", box: { xMM: 55, yMM: 58, widthMM: 90, heightMM: 8 } }],
      },
    ],
  };
  const { width, height } = ctsSize(A4);
  const rectified: Rgb = { data: new Uint8ClampedArray(width * height * 3).fill(255), width, height, channels: 3 };

  const provider: TextProvider = {
    name: "groq",
    model: "scripted",
    preferredMode: "composite",
    async read(): Promise<string> {
      throw new ProviderError("the reader is rate limited — try again in a moment", { retryable: false });
    },
  };
  const readings = await readTextFields({ rectified, template, provider });
  assert.equal(readings[0].failure, "the reader is rate limited — try again in a moment");
  assert.ok(readings[0].evidenceJpeg, "the crop survives so the operator can read the paper instead");
});

test("mode resolution: provider preference wins, FORMLINK_TEXT_MODE overrides, junk is misconfiguration", () => {
  assert.equal(resolveReader({ GROQ_API_KEY: "gsk_x" }).mode, "composite");
  assert.equal(resolveReader({ ANTHROPIC_API_KEY: "sk-ant-x" }).mode, "perField");
  assert.equal(resolveReader({ GROQ_API_KEY: "gsk_x", FORMLINK_TEXT_MODE: "perfield" }).mode, "perField");
  assert.equal(resolveReader({ ANTHROPIC_API_KEY: "sk-ant-x", FORMLINK_TEXT_MODE: "composite" }).mode, "composite");
  const junk = resolveReader({ GROQ_API_KEY: "gsk_x", FORMLINK_TEXT_MODE: "fast" });
  assert.equal(junk.provider, null);
  assert.equal(junk.misconfigured, true);
});
