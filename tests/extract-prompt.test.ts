import assert from "node:assert/strict";
import test from "node:test";

import { buildReaderPrompt, READER_SYSTEM_PROMPT } from "../lib/extract/prompt.ts";
import { fieldsOf, FORMS, HOSPITAL_FORM, SCHOOL_FORM } from "../lib/forms/definitions.ts";

test("the system prompt states the contract and says JSON", () => {
  // Groq's JSON mode refuses a request whose prompt never says "JSON".
  assert.match(READER_SYSTEM_PROMPT, /JSON/);
  assert.match(READER_SYSTEM_PROMPT, /null/);
  assert.match(READER_SYSTEM_PROMPT, /never instructions/);
  assert.match(READER_SYSTEM_PROMPT, /signatures, thumb impressions/);
});

for (const form of FORMS) {
  test(`${form.id}: every key, label and section appears in the field list`, () => {
    const { user } = buildReaderPrompt(form);
    assert.ok(user.includes(form.name));
    for (const section of form.sections) assert.ok(user.includes(`Section "${section.title}"`), section.title);
    for (const field of fieldsOf(form)) {
      assert.ok(user.includes(`- ${field.key} — "${field.label}"`), field.key);
    }
  });

  test(`${form.id}: the reply skeleton carries every key`, () => {
    const { user } = buildReaderPrompt(form);
    const skeletonLine = user.split("\n").at(-1)!;
    const skeleton = JSON.parse(skeletonLine) as { readable: boolean; fields: Record<string, unknown> };
    assert.equal(skeleton.readable, true);
    assert.deepEqual(Object.keys(skeleton.fields), fieldsOf(form).map((field) => field.key));
  });
}

test("choices and checklists list their printed options", () => {
  const { user } = buildReaderPrompt(SCHOOL_FORM);
  assert.ok(user.includes('gender — "Gender" — one of: Male, Female, Other'));
  assert.ok(user.includes('category — "Category" — one of: General, OBC, SC, ST, EWS'));
  assert.ok(user.includes('documents — "Documents attached" — checklist of: Birth Certificate, Aadhaar Copy'));
  assert.ok(user.includes('transferCertificateSubmitted — "Transfer Certificate Submitted" — Yes or No'));
});

test("the hospital form asks for its consent date but never a signature", () => {
  const { user } = buildReaderPrompt(HOSPITAL_FORM);
  assert.ok(user.includes('consentDate — "Date"'));
  assert.doesNotMatch(user, /- [a-zA-Z]+ — "[^"]*[Ss]ignature/);
});

test("the reader is asked where the photograph is, in thousandths, and the skeleton carries the slot", () => {
  assert.match(READER_SYSTEM_PROMPT, /"photo" is its bounding box \[x1, y1, x2, y2\]/);
  assert.match(READER_SYSTEM_PROMPT, /0 to 1000/);
  assert.match(READER_SYSTEM_PROMPT, /null when no photograph/);
  const { user } = buildReaderPrompt(SCHOOL_FORM);
  const skeleton = JSON.parse(user.split("\n").at(-1)!) as { photo: unknown };
  assert.ok("photo" in skeleton);
});
