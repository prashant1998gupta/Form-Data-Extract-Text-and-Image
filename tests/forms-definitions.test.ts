import assert from "node:assert/strict";
import test from "node:test";

import {
  checklistItems,
  emptyValues,
  fieldsOf,
  formById,
  FORMS,
  joinChecklist,
  normaliseValues,
  recordSummary,
  recordTitle,
  SCHOOL_FORM,
} from "../lib/forms/definitions.ts";

/**
 * The form definitions are the product's whole data model: the prompt, the
 * parser, the editable form and the saved record are all generated from
 * them. These pin the properties everything downstream assumes.
 */

for (const form of FORMS) {
  test(`${form.id}: every field key is unique and machine-safe`, () => {
    const keys = fieldsOf(form).map((field) => field.key);
    assert.equal(new Set(keys).size, keys.length, "duplicate keys");
    for (const key of keys) assert.match(key, /^[a-z][a-zA-Z0-9]*$/, key);
  });

  test(`${form.id}: the title and summary keys name real fields`, () => {
    const keys = new Set(fieldsOf(form).map((field) => field.key));
    assert.ok(keys.has(form.titleKey), `titleKey ${form.titleKey}`);
    for (const key of form.summaryKeys) assert.ok(keys.has(key), `summaryKey ${key}`);
  });

  test(`${form.id}: choice and checklist fields carry options, nothing else does`, () => {
    for (const field of fieldsOf(form)) {
      if (field.kind === "choice" || field.kind === "checklist") {
        assert.ok(field.options && field.options.length >= 2, `${field.key} needs options`);
      } else {
        assert.equal(field.options, undefined, `${field.key} must not carry options`);
      }
    }
  });

  test(`${form.id}: the photograph sits on the page, frame inside the expected box`, () => {
    const { box, printedBorder, sizeMM, sizeTolerance } = form.photo;
    assert.ok(box.xMM >= 0 && box.yMM >= 0);
    assert.ok(box.xMM + box.widthMM <= form.page.widthMM);
    assert.ok(box.yMM + box.heightMM <= form.page.heightMM);
    assert.ok(printedBorder.xMM >= box.xMM && printedBorder.yMM >= box.yMM);
    assert.ok(printedBorder.xMM + printedBorder.widthMM <= box.xMM + box.widthMM);
    assert.ok(printedBorder.yMM + printedBorder.heightMM <= box.yMM + box.heightMM);
    assert.ok(sizeMM.widthMM > 20 && sizeMM.heightMM > 25, "a print, not a stamp");
    assert.ok(sizeTolerance.min < 1 && sizeTolerance.max > 1);
  });

  test(`${form.id}: no signature or thumb field exists`, () => {
    for (const field of fieldsOf(form)) {
      assert.doesNotMatch(field.label.toLowerCase(), /signature|thumb/, field.key);
    }
  });
}

test("formById knows the two forms and refuses anything else", () => {
  assert.equal(formById("school")?.name, "School Admission Form");
  assert.equal(formById("hospital")?.name, "Hospital Patient Form");
  assert.equal(formById("bank"), null);
  assert.equal(formById(null), null);
});

test("emptyValues has every key blank, and normaliseValues fills what is missing", () => {
  const empty = emptyValues(SCHOOL_FORM);
  assert.equal(Object.keys(empty).length, fieldsOf(SCHOOL_FORM).length);
  assert.ok(Object.values(empty).every((value) => value === ""));

  const filled = normaliseValues(SCHOOL_FORM, { studentName: "Asha Verma", bogus: "dropped", pinCode: 201301 });
  assert.equal(filled.studentName, "Asha Verma");
  assert.equal(filled.pinCode, "201301");
  assert.equal("bogus" in filled, false);
  assert.equal(filled.city, "");
});

test("the title and summary come from the declared keys", () => {
  const values = normaliseValues(SCHOOL_FORM, { studentName: "  Asha Verma ", classApplyingFor: "5", fatherMobile: "98765 43210" });
  assert.equal(recordTitle(SCHOOL_FORM, values), "Asha Verma");
  assert.equal(recordSummary(SCHOOL_FORM, values), "5 · 98765 43210");
});

test("a checklist round-trips through one string", () => {
  const joined = joinChecklist(["Birth Certificate", "Aadhaar Copy"]);
  assert.deepEqual(checklistItems(joined), ["Birth Certificate", "Aadhaar Copy"]);
  assert.deepEqual(checklistItems(" , Address Proof ,, "), ["Address Proof"]);
});
