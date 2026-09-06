import assert from "node:assert/strict";
import test from "node:test";

import { reconcileReadings, sameReading } from "../lib/extract/double-check.ts";
import { parseReaderReply } from "../lib/extract/parse.ts";
import { fieldByKey, HOSPITAL_FORM, SCHOOL_FORM } from "../lib/forms/definitions.ts";

/**
 * Two readings of one page: agreement passes through, disagreement is
 * flagged with the other reading's word, and a blank on one pass is not a
 * disagreement about the word but a note that it stood alone.
 */

function reading(fields: Record<string, unknown>, form = HOSPITAL_FORM) {
  return parseReaderReply(JSON.stringify({ readable: true, photo: null, fields }), form);
}

test("readings that agree pass through unflagged, whatever their spacing and case", () => {
  const first = reading({ patientName: "Dinesh Singh", phone: "98765 43210", email: "Abc@gmail.com" });
  const second = reading({ patientName: "dinesh  singh", phone: "9876543210", email: "abc@gmail.com" });
  const merged = reconcileReadings(first, second, HOSPITAL_FORM);
  assert.deepEqual(merged.uncertain, []);
  assert.equal(merged.values.patientName, "Dinesh Singh");
  assert.equal(merged.values.phone, "98765 43210");
});

test("a disagreement delivers the first reading and flags the field with the second's word", () => {
  const first = reading({ patientName: "राजेश रतन", doctorName: "Dr. Rajesh Kumar" });
  const second = reading({ patientName: "दिनेश सिंह", doctorName: "Dr. Rajesh Kumar" });
  const merged = reconcileReadings(first, second, HOSPITAL_FORM);
  assert.equal(merged.values.patientName, "राजेश रतन");
  assert.deepEqual(merged.uncertain, [{ key: "patientName", alternative: "दिनेश सिंह" }]);
  assert.equal(merged.values.doctorName, "Dr. Rajesh Kumar");
});

test("blank on one pass, read on the other: the reading is delivered, marked as standing alone, and no longer 'unreadable'", () => {
  const first = reading({ patientName: null, phone: "9250916272" });
  const second = reading({ patientName: "दिनेश सिंह", phone: "" });
  assert.deepEqual(first.unreadable, ["patientName"]);
  const merged = reconcileReadings(first, second, HOSPITAL_FORM);
  assert.equal(merged.values.patientName, "दिनेश सिंह");
  assert.equal(merged.values.phone, "9250916272");
  assert.deepEqual(merged.unreadable, []);
  assert.deepEqual(merged.uncertain, [
    { key: "patientName", alternative: "" },
    { key: "phone", alternative: "" },
  ]);
  assert.equal(merged.filled, 2);
});

test("numbers compare by their digits, checklists by their items", () => {
  const phone = fieldByKey(HOSPITAL_FORM, "phone")!;
  assert.equal(sameReading("92509 16272", "9250916272", phone), true);
  assert.equal(sameReading("925916272", "9250916272", phone), false);
  const documents = fieldByKey(SCHOOL_FORM, "documents")!;
  assert.equal(sameReading("Birth Certificate, Aadhaar Copy", "aadhaar copy, birth certificate", documents), true);
  assert.equal(sameReading("Birth Certificate", "Birth Certificate, Aadhaar Copy", documents), false);
});

test("a reading that saw no form yields to the one that did, whichever came first", () => {
  const read = reading({ patientName: "Dinesh Singh" });
  const blank = parseReaderReply(JSON.stringify({ readable: false, fields: {} }), HOSPITAL_FORM);
  for (const merged of [reconcileReadings(read, blank, HOSPITAL_FORM), reconcileReadings(blank, read, HOSPITAL_FORM)]) {
    assert.equal(merged.readable, true);
    assert.equal(merged.values.patientName, "Dinesh Singh");
    assert.deepEqual(merged.uncertain, []);
  }
  const neither = reconcileReadings(blank, blank, HOSPITAL_FORM);
  assert.equal(neither.readable, false);
});

test("an off-option value delivered from the second reading is still listed as not one of the options", () => {
  const first = reading({ gender: null, allergies: "Yes" }, SCHOOL_FORM);
  const second = reading({ gender: "Other-ish", allergies: "Yes" }, SCHOOL_FORM);
  assert.deepEqual(second.notInOptions, ["gender"]);
  const merged = reconcileReadings(first, second, SCHOOL_FORM);
  assert.equal(merged.values.gender, "Other-ish");
  assert.deepEqual(merged.notInOptions, ["gender"]);
  // And one delivered from the first reading keeps its listing whether or not the readings agree.
  const agreeing = reconcileReadings(second, second, SCHOOL_FORM);
  assert.deepEqual(agreeing.notInOptions, ["gender"]);
  const differing = reconcileReadings(second, reading({ gender: "Male", allergies: "Yes" }, SCHOOL_FORM), SCHOOL_FORM);
  assert.deepEqual(differing.notInOptions, ["gender"]);
  assert.deepEqual(differing.uncertain, [{ key: "gender", alternative: "Male" }]);
});

test("the photograph's box comes from whichever reading gave one", () => {
  const withBox = parseReaderReply(JSON.stringify({ readable: true, photo: [120, 60, 380, 400], photoPicture: 2, fields: { patientName: "Dinesh Singh" } }), HOSPITAL_FORM);
  const without = reading({ patientName: "Dinesh Singh" });
  assert.deepEqual(reconcileReadings(without, withBox, HOSPITAL_FORM).photoBox, [120, 60, 380, 400]);
  assert.equal(reconcileReadings(without, withBox, HOSPITAL_FORM).photoPicture, 2);
  assert.deepEqual(reconcileReadings(withBox, without, HOSPITAL_FORM).photoBox, [120, 60, 380, 400]);
  assert.equal(reconcileReadings(without, without, HOSPITAL_FORM).photoBox, null);
});
