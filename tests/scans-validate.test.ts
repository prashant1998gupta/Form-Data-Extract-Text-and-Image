import assert from "node:assert/strict";
import test from "node:test";

import { HOSPITAL_FORM } from "../lib/forms/definitions.ts";
import { isReference, newReference } from "../lib/scans/reference.ts";
import { decodePhotoDataUrl, parseScanBody, ScanInputError, sniffImage } from "../lib/scans/validate.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);

test("a save body must name a form and carry values", () => {
  assert.throws(() => parseScanBody(null), ScanInputError);
  assert.throws(() => parseScanBody({ values: {} }), /Choose which form/);
  assert.throws(() => parseScanBody({ form: "hospital" }), /values are missing/);
  const parsed = parseScanBody({ form: "hospital", values: { patientName: "Anita", stray: 1 } });
  assert.equal(parsed.form.id, "hospital");
  assert.equal(parsed.values.patientName, "Anita");
  assert.equal("stray" in parsed.values, false);
  assert.equal(parsed.photo, undefined, "a photo that was not mentioned is left alone");
});

test("an edit keeps the stored form and distinguishes 'remove photo' from 'unchanged'", () => {
  const removed = parseScanBody({ values: {}, photo: null }, HOSPITAL_FORM);
  assert.equal(removed.photo, null);
  const untouched = parseScanBody({ values: {} }, HOSPITAL_FORM);
  assert.equal(untouched.photo, undefined);
});

test("a photograph is typed by its bytes, not by its declared MIME", () => {
  const lyingUrl = `data:image/png;base64,${JPEG.toString("base64")}`;
  const decoded = decodePhotoDataUrl(lyingUrl);
  assert.equal(decoded.contentType, "image/jpeg");
  assert.equal(decoded.extension, "jpg");

  assert.equal(sniffImage(PNG)?.contentType, "image/png");
  assert.equal(sniffImage(Buffer.from("not an image")), null);
  assert.throws(() => decodePhotoDataUrl("data:text/plain;base64,aGk="), /PNG, JPEG or WebP/);
  assert.throws(() => decodePhotoDataUrl(`data:image/png;base64,${Buffer.from("hello").toString("base64")}`), /not a PNG/);
});

test("references are short, prefixed, and avoid the letters people misread", () => {
  for (let i = 0; i < 50; i += 1) {
    const reference = newReference("SCH");
    assert.ok(isReference(reference), reference);
    assert.doesNotMatch(reference.slice(4), /[ILOU]/);
  }
  assert.equal(isReference("SCH-4F2A19"), true);
  assert.equal(isReference("sch-4f2a19"), false);
  assert.equal(isReference("SCH-4F2A1"), false);
});
