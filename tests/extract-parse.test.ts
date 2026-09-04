import assert from "node:assert/strict";
import test from "node:test";

import { parseReaderReply, ReplyFormatError } from "../lib/extract/parse.ts";
import { fieldsOf, HOSPITAL_FORM, SCHOOL_FORM } from "../lib/forms/definitions.ts";

/**
 * The reply is untrusted input. These pin that every shape a model reaches
 * for lands as the form's own keys with cleaned strings, that "could not
 * read" survives as a list rather than as an empty string indistinguishable
 * from blank, and that anything else is refused in words.
 */

function reply(fields: Record<string, unknown>, readable = true): string {
  return JSON.stringify({ readable, fields });
}

const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
const BELL = String.fromCharCode(7);

test("a well-formed reply fills the form's keys and nothing else", () => {
  const parsed = parseReaderReply(reply({ patientName: "Anita Sharma", phone: "98765 43210", bogus: "x" }), HOSPITAL_FORM);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.values.patientName, "Anita Sharma");
  assert.equal(parsed.values.phone, "98765 43210");
  assert.equal("bogus" in parsed.values, false);
  assert.equal(Object.keys(parsed.values).length, fieldsOf(HOSPITAL_FORM).length);
  assert.equal(parsed.values.email, "");
  assert.equal(parsed.filled, 2);
});

test("null is 'could not read', listed separately from blank", () => {
  const parsed = parseReaderReply(reply({ patientName: null, email: "" }), HOSPITAL_FORM);
  assert.equal(parsed.values.patientName, "");
  assert.deepEqual(parsed.unreadable, ["patientName"]);
  assert.equal(parsed.values.email, "");
});

test("a fenced or chatty reply still yields its object", () => {
  const fenced = "```json" + LF + reply({ patientName: "Ravi" }) + LF + "```";
  assert.equal(parseReaderReply(fenced, HOSPITAL_FORM).values.patientName, "Ravi");
  const chatty = "Here is the JSON you asked for: " + reply({ patientName: "Ravi" }) + " Let me know!";
  assert.equal(parseReaderReply(chatty, HOSPITAL_FORM).values.patientName, "Ravi");
});

test("a flat object without a fields wrapper is accepted", () => {
  const parsed = parseReaderReply(JSON.stringify({ patientName: "Ravi", phone: "1" }), HOSPITAL_FORM);
  assert.equal(parsed.values.patientName, "Ravi");
});

test("something that is not JSON is refused in words", () => {
  assert.throws(() => parseReaderReply("I cannot read this image.", HOSPITAL_FORM), ReplyFormatError);
  assert.throws(() => parseReaderReply("[1,2,3]", HOSPITAL_FORM), ReplyFormatError);
});

test("readable false blanks everything", () => {
  const parsed = parseReaderReply(reply({ patientName: "Ravi" }, false), HOSPITAL_FORM);
  assert.equal(parsed.readable, false);
  assert.equal(parsed.values.patientName, "");
  assert.equal(parsed.filled, 0);
});

test("choices are matched to the printed spelling, and anything else is flagged", () => {
  const parsed = parseReaderReply(reply({ gender: "female", category: "O.B.C.", motherTongue: "Hindi" }), SCHOOL_FORM);
  assert.equal(parsed.values.gender, "Female");
  assert.equal(parsed.values.category, "OBC", "case and punctuation do not matter");
  assert.deepEqual(parsed.notInOptions, []);

  const odd = parseReaderReply(reply({ gender: "Boy" }), SCHOOL_FORM);
  assert.equal(odd.values.gender, "Boy", "kept as written so the person can see it");
  assert.deepEqual(odd.notInOptions, ["gender"]);
});

test("yes/no accepts the ways a model says it", () => {
  const cases: [unknown, string][] = [
    ["Yes", "Yes"],
    ["yes", "Yes"],
    ["Y", "Yes"],
    [true, "Yes"],
    ["No", "No"],
    ["n", "No"],
    [false, "No"],
    ["", ""],
  ];
  for (const [raw, expected] of cases) {
    const parsed = parseReaderReply(reply({ transferCertificateSubmitted: raw }), SCHOOL_FORM);
    assert.equal(parsed.values.transferCertificateSubmitted, expected, String(raw));
  }
  const maybe = parseReaderReply(reply({ transferCertificateSubmitted: "Pending" }), SCHOOL_FORM);
  assert.equal(maybe.values.transferCertificateSubmitted, "Pending");
  assert.deepEqual(maybe.notInOptions, ["transferCertificateSubmitted"]);
});

test("a checklist arrives as an array, a string or an object of booleans", () => {
  const fromArray = parseReaderReply(reply({ documents: ["birth certificate", "Aadhaar Copy", "Aadhaar copy"] }), SCHOOL_FORM);
  assert.equal(fromArray.values.documents, "Birth Certificate, Aadhaar Copy");

  const fromString = parseReaderReply(reply({ documents: "Address Proof; Transfer Certificate" }), SCHOOL_FORM);
  assert.equal(fromString.values.documents, "Address Proof, Transfer Certificate");

  const fromObject = parseReaderReply(
    reply({ documents: { "Birth Certificate": true, "Aadhaar Copy": false, "Previous Report Card": "Yes" } }),
    SCHOOL_FORM,
  );
  assert.equal(fromObject.values.documents, "Birth Certificate, Previous Report Card");

  const none = parseReaderReply(reply({ documents: [] }), SCHOOL_FORM);
  assert.equal(none.values.documents, "");
});

test("values are cleaned: whitespace, control characters, line breaks, length", () => {
  const parsed = parseReaderReply(
    reply({
      studentName: "  Asha  Verma " + BELL + " ",
      address: "12 Lakeview Road" + CR + LF + CR + LF + "  Sector 45 " + LF,
      city: "Noida" + LF + "Uttar Pradesh",
      pinCode: 201301,
      religion: "x".repeat(3000),
    }),
    SCHOOL_FORM,
  );
  assert.equal(parsed.values.studentName, "Asha Verma");
  assert.equal(parsed.values.address, "12 Lakeview Road" + LF + "Sector 45", "a multiline field keeps its line breaks");
  assert.equal(parsed.values.city, "Noida, Uttar Pradesh", "a single-line field folds line breaks into commas");
  assert.equal(parsed.values.pinCode, "201301");
  assert.equal(parsed.values.religion.length, 2000);
});

test("an object where a string belongs is treated as unreadable, not saved as JSON", () => {
  const parsed = parseReaderReply(reply({ patientName: { first: "Anita" } }), HOSPITAL_FORM);
  assert.equal(parsed.values.patientName, "");
  assert.deepEqual(parsed.unreadable, ["patientName"]);
});
