import assert from "node:assert/strict";
import test from "node:test";

import { evidenceRect, cropRgb } from "../lib/reader/crop.ts";
import { readTextFields } from "../lib/reader/read-text-fields.ts";
import { ProviderError, type ReadRequest, type TextProvider } from "../lib/reader/provider-types.ts";
import { A4, CTS_PX_PER_MM, ctsSize } from "../lib/geometry/frames.ts";
import type { FormTemplate } from "../lib/templates/types.ts";
import type { Rgb } from "../lib/vision/types.ts";

/**
 * The orchestrator's load-bearing properties, tested with a scripted provider:
 *
 * - THE MAPPING IS STRUCTURAL. Values land on the field whose crop was sent,
 *   in declaration order, regardless of completion order. This is the property
 *   that makes "a real value under a wrong label" impossible by construction.
 * - FAULTS ARE ISOLATED. One field failing costs one field.
 * - THE EVIDENCE IS EXACT. Every reading carries the crop it was read from.
 */

function template(): FormTemplate {
  return {
    id: "t",
    name: "Test form",
    page: A4,
    hasGeometry: true,
    sections: [
      {
        id: "s",
        title: "S",
        fields: [
          { id: "f1", key: "patientName", label: "Patient Name", type: "name", box: { xMM: 55, yMM: 47, widthMM: 90, heightMM: 8 } },
          { id: "f2", key: "age", label: "Age", type: "age", box: { xMM: 55, yMM: 58, widthMM: 90, heightMM: 8 } },
          // An image field and a boxless text field: both must be ignored.
          { id: "f3", key: "photo", label: "Photo", type: "photograph", box: { xMM: 160, yMM: 30, widthMM: 36, heightMM: 46 } },
          { id: "f4", key: "email", label: "Email", type: "email" },
        ],
      },
    ],
  };
}

function page(): Rgb {
  const { width, height } = ctsSize(A4);
  return { data: new Uint8ClampedArray(width * height * 3).fill(255), width, height, channels: 3 };
}

function scripted(replies: Record<string, () => string>): TextProvider {
  return {
    name: "groq",
    model: "scripted",
    preferredMode: "perField",
    async read(request: ReadRequest): Promise<string> {
      const match = Object.entries(replies).find(([label]) => request.prompt.includes(`"${label}"`));
      if (!match) throw new Error(`no scripted reply for prompt: ${request.prompt}`);
      return match[1]();
    },
  };
}

test("values land on the fields whose crops were sent, and only readable placed fields are read", async () => {
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    provider: scripted({
      "Patient Name": () => '{"value": "Anita Sharma"}',
      Age: () => '{"value": "34"}',
    }),
  });

  assert.equal(readings.length, 2);
  assert.equal(readings[0].key, "patientName");
  assert.equal(readings[0].value, "Anita Sharma");
  assert.equal(readings[1].key, "age");
  assert.equal(readings[1].value, "34");
  for (const reading of readings) {
    assert.ok(reading.evidenceJpeg, `${reading.key} must carry its evidence crop`);
    assert.ok(reading.regionInPage, `${reading.key} must say where the crop came from`);
  }
});

test("one field failing costs one field, stated in words on that field", async () => {
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    provider: scripted({
      "Patient Name": () => {
        throw new ProviderError("the reader had a server error", { retryable: false });
      },
      Age: () => '{"value": "34"}',
    }),
  });

  assert.equal(readings[0].failure, "the reader had a server error");
  assert.equal(readings[0].value, null);
  assert.ok(readings[0].evidenceJpeg, "even a failed field shows the crop a human can read instead");
  assert.equal(readings[1].value, "34");
  assert.equal(readings[1].failure, undefined);
});

test("a retryable fault is retried once and can succeed", async () => {
  let attempts = 0;
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    provider: scripted({
      "Patient Name": () => {
        attempts += 1;
        if (attempts === 1) {
          throw new ProviderError("rate limited", { retryable: true, retryAfterMs: 10 });
        }
        return '{"value": "Anita"}';
      },
      Age: () => '{"value": "34"}',
    }),
  });
  assert.equal(attempts, 2);
  assert.equal(readings[0].value, "Anita");
});

test("a malformed reply becomes that field's failure, never a crash", async () => {
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    provider: scripted({
      "Patient Name": () => "sorry, I cannot help with that",
      Age: () => '{"value": ""}',
    }),
  });
  assert.ok(readings[0].failure);
  assert.equal(readings[1].blank, true, "an asserted blank survives beside a failure");
});

test("an exhausted scan budget fails fields in words instead of contacting the provider", async () => {
  let calls = 0;
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    scanBudgetMs: 0,
    provider: {
      name: "groq",
      model: "scripted",
      preferredMode: "perField",
      async read() {
        calls += 1;
        return '{"value": "x"}';
      },
    },
  });
  // The scan survives — every field carries its evidence and an honest reason,
  // and no metered request was made for a call that could not finish.
  assert.equal(calls, 0);
  for (const reading of readings) {
    assert.equal(reading.failure, "the reader ran out of time for this scan");
    assert.ok(reading.evidenceJpeg);
  }
});

test("the retry is skipped when the scan budget cannot fit the delay plus a real attempt", async () => {
  let attempts = 0;
  const readings = await readTextFields({
    rectified: page(),
    template: template(),
    scanBudgetMs: 4_000, // enough to start, not enough for delay + MIN_CALL_MS
    provider: scripted({
      "Patient Name": () => {
        attempts += 1;
        throw new ProviderError("rate limited", { retryable: true, retryAfterMs: 2_000 });
      },
      Age: () => '{"value": "34"}',
    }),
  });
  assert.equal(attempts, 1, "a retry that cannot finish inside the budget must not be attempted");
  assert.equal(readings[0].failure, "rate limited");
  assert.equal(readings[1].value, "34");
});

test("the evidence rect pads the declared box and stays integral and on the page", () => {
  const rect = evidenceRect({ xMM: 55, yMM: 47, widthMM: 90, heightMM: 8 }, A4);
  const pad = 2.5 * CTS_PX_PER_MM;
  assert.ok(Number.isInteger(rect.x) && Number.isInteger(rect.y));
  assert.ok(Number.isInteger(rect.width) && Number.isInteger(rect.height));
  assert.ok(Math.abs(rect.x - (55 * CTS_PX_PER_MM - pad)) <= 1);
  assert.ok(Math.abs(rect.height - (8 * CTS_PX_PER_MM + 2 * pad)) <= 1);

  // A box at the page corner must clamp, not go negative.
  const corner = evidenceRect({ xMM: 0, yMM: 0, widthMM: 10, heightMM: 5 }, A4);
  assert.equal(corner.x, 0);
  assert.equal(corner.y, 0);

  // A box at the far edge must not overrun the raster.
  const edge = evidenceRect({ xMM: 200, yMM: 290, widthMM: 10, heightMM: 7 }, A4);
  const pageW = Math.round(A4.widthMM * CTS_PX_PER_MM);
  const pageH = Math.round(A4.heightMM * CTS_PX_PER_MM);
  assert.ok(edge.x + edge.width <= pageW);
  assert.ok(edge.y + edge.height <= pageH);
});

test("cropRgb copies exactly the requested pixels", () => {
  // A 4x3 image whose red channel encodes x and green encodes y.
  const width = 4;
  const height = 3;
  const data = new Uint8ClampedArray(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data[(y * width + x) * 3] = x * 10;
      data[(y * width + x) * 3 + 1] = y * 10;
    }
  }
  const crop = cropRgb({ data, width, height, channels: 3 }, { x: 1, y: 1, width: 2, height: 2 });
  assert.equal(crop.width, 2);
  assert.equal(crop.height, 2);
  assert.equal(crop.data[0], 10); // x=1
  assert.equal(crop.data[1], 10); // y=1
  assert.equal(crop.data[3], 20); // x=2
  assert.equal(crop.data[crop.width * 3 + 1], 20); // second row, y=2
});
