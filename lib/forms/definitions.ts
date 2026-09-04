/**
 * The forms this app can scan — defined in code, the way CardLink defines a
 * visiting card's fields.
 *
 * Each definition is the paper form transcribed: its sections, every field as
 * the form prints it, the kind of answer each expects, and where the pasted
 * photograph sits. The reader prompt, the editable form, the saved record and
 * the saved-list row are all generated from this one description, so adding a
 * form is adding an entry here — no boxes to draw, no template to teach.
 *
 * Signatures and thumb impressions are deliberately NOT fields. The product
 * fills text and the person's photograph, nothing else.
 */

import { A4, type PageSizeMM } from "../geometry/frames.ts";

export type FormId = "school" | "hospital";

/**
 * What an answer looks like, which decides three things at once: how the
 * model is asked for it, how the reply is validated, and which control edits
 * it. A closed set on purpose — a free-text kind would be an unhandled branch.
 */
export type FieldKind =
  | "text"
  | "name"
  | "phone"
  | "email"
  | "date"
  | "number"
  | "multiline"
  /** Exactly one of the printed options, or blank. */
  | "choice"
  /** Yes or No, or blank. */
  | "yesno"
  /** Any number of the printed options, stored comma-separated. */
  | "checklist";

export interface FieldDefinition {
  /** Stable machine key, the JSON key the model replies with. */
  readonly key: string;
  /** What the printed label says. */
  readonly label: string;
  readonly kind: FieldKind;
  /** The printed options of a choice or checklist field. */
  readonly options?: readonly string[];
  readonly placeholder?: string;
  /** Spans the full row of the editable form. */
  readonly wide?: boolean;
}

export interface SectionDefinition {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly FieldDefinition[];
}

/**
 * The pasted photograph: its label, and the print size the detector judges a
 * candidate against, within `sizeTolerance` — a ratio window wide enough for
 * a passport print pasted into a larger frame. WHERE it is on the page is not
 * declared: the reader locates it in each capture (`lib/photo/locate-photo.ts`).
 */
export interface PhotoDefinition {
  readonly label: string;
  readonly sizeMM: { readonly widthMM: number; readonly heightMM: number };
  readonly sizeTolerance: { readonly min: number; readonly max: number };
}

export interface FormDefinition {
  readonly id: FormId;
  readonly name: string;
  readonly description: string;
  /** Prefix of a saved scan's reference, e.g. SCH-4F2A19. */
  readonly referencePrefix: string;
  readonly page: PageSizeMM;
  /** A blank copy of the form, for the chooser. */
  readonly thumbnail: string;
  readonly photo: PhotoDefinition;
  /** The field that names a saved scan. Required before saving. */
  readonly titleKey: string;
  /** Shown under the title in the saved list. */
  readonly summaryKeys: readonly string[];
  readonly sections: readonly SectionDefinition[];
}

/** A scan's answers, keyed by field key. Every key of the form is present. */
export type FormValues = Readonly<Record<string, string>>;

const GENDER = ["Male", "Female", "Other"] as const;

/** The printed frame is 32.5 x 46 mm; a passport print (35 x 45) is pasted over it. */
export const SCHOOL_FORM: FormDefinition = {
  id: "school",
  name: "School Admission Form",
  description: "Sunrise Public School admission form — student, parent, academic and medical details.",
  referencePrefix: "SCH",
  page: A4,
  thumbnail: "/forms/school.jpg",
  photo: {
    label: "Student photograph",
    sizeMM: { widthMM: 35, heightMM: 45 },
    sizeTolerance: { min: 0.7, max: 1.4 },
  },
  titleKey: "studentName",
  summaryKeys: ["classApplyingFor", "fatherMobile"],
  sections: [
    {
      id: "student",
      title: "Student Information",
      fields: [
        { key: "applicationNo", label: "Application No.", kind: "text" },
        { key: "admissionNo", label: "Admission No.", kind: "text" },
        { key: "academicYear", label: "Academic Year", kind: "text", placeholder: "2026-27" },
        { key: "classApplyingFor", label: "Class Applying For", kind: "text" },
        { key: "studentName", label: "Student Full Name", kind: "name", wide: true },
        { key: "dateOfBirth", label: "Date of Birth", kind: "date", placeholder: "DD / MM / YYYY" },
        { key: "gender", label: "Gender", kind: "choice", options: GENDER },
        { key: "bloodGroup", label: "Blood Group", kind: "text", placeholder: "B+" },
        { key: "aadhaarNo", label: "Aadhaar No.", kind: "number" },
        { key: "nationality", label: "Nationality", kind: "text" },
        { key: "religion", label: "Religion", kind: "text" },
        { key: "category", label: "Category", kind: "choice", options: ["General", "OBC", "SC", "ST", "EWS"] },
        { key: "motherTongue", label: "Mother Tongue", kind: "text" },
        { key: "address", label: "Address", kind: "multiline", wide: true },
        { key: "city", label: "City", kind: "text" },
        { key: "state", label: "State", kind: "text" },
        { key: "pinCode", label: "PIN Code", kind: "number" },
      ],
    },
    {
      id: "parents",
      title: "Parent / Guardian Details",
      fields: [
        { key: "fatherName", label: "Father's Name", kind: "name" },
        { key: "fatherOccupation", label: "Father's Occupation", kind: "text" },
        { key: "fatherMobile", label: "Father's Mobile No.", kind: "phone" },
        { key: "fatherEmail", label: "Father's Email", kind: "email" },
        { key: "motherName", label: "Mother's Name", kind: "name" },
        { key: "motherOccupation", label: "Mother's Occupation", kind: "text" },
        { key: "motherMobile", label: "Mother's Mobile No.", kind: "phone" },
        { key: "motherEmail", label: "Mother's Email", kind: "email" },
        { key: "guardianName", label: "Guardian's Name", kind: "name" },
        { key: "guardianRelationship", label: "Relationship", kind: "text" },
        { key: "guardianContact", label: "Guardian Contact No.", kind: "phone" },
      ],
    },
    {
      id: "academic",
      title: "Academic Details",
      fields: [
        { key: "previousSchool", label: "Previous School Name", kind: "text", wide: true },
        { key: "lastClassAttended", label: "Last Class Attended", kind: "text" },
        { key: "board", label: "Board", kind: "text" },
        { key: "mediumOfInstruction", label: "Medium of Instruction", kind: "text" },
        { key: "percentageOrGrade", label: "Percentage / Grade", kind: "text" },
        { key: "transferCertificateSubmitted", label: "Transfer Certificate Submitted", kind: "yesno" },
      ],
    },
    {
      id: "medical",
      title: "Medical / Emergency Details",
      fields: [
        { key: "allergies", label: "Allergies", kind: "text" },
        { key: "existingMedicalConditions", label: "Existing Medical Conditions", kind: "text" },
        { key: "doctorName", label: "Doctor Name", kind: "name" },
        { key: "emergencyContactPerson", label: "Emergency Contact Person", kind: "name" },
        { key: "emergencyContactNumber", label: "Emergency Contact Number", kind: "phone" },
        { key: "medicalBloodGroup", label: "Blood Group", kind: "text", placeholder: "B+" },
      ],
    },
    {
      id: "documents",
      title: "Required Documents",
      fields: [
        {
          key: "documents",
          label: "Documents attached",
          kind: "checklist",
          wide: true,
          options: [
            "Birth Certificate",
            "Aadhaar Copy",
            "Previous Report Card",
            "Transfer Certificate",
            "Address Proof",
            "Passport Size Photographs",
          ],
        },
      ],
    },
  ],
};

/** The printed frame is 40 x 52 mm; the print pasted in it is usually a passport size. */
export const HOSPITAL_FORM: FormDefinition = {
  id: "hospital",
  name: "Hospital Patient Form",
  description: "Rimberio Hospital patient registration — patient, medical history and doctor details.",
  referencePrefix: "HSP",
  page: A4,
  thumbnail: "/forms/hospital.jpg",
  photo: {
    label: "Patient photograph",
    // The frame is 40 x 52 mm; what gets pasted in it is a passport print.
    sizeMM: { widthMM: 35, heightMM: 45 },
    sizeTolerance: { min: 0.7, max: 1.5 },
  },
  titleKey: "patientName",
  summaryKeys: ["phone", "doctorName"],
  sections: [
    {
      id: "patient",
      title: "Patient Information",
      fields: [
        { key: "patientName", label: "Name", kind: "name", wide: true },
        { key: "email", label: "Email", kind: "email" },
        { key: "phone", label: "Phone", kind: "phone" },
        { key: "dateOfBirth", label: "Date of Birth", kind: "date", placeholder: "DD / MM / YYYY" },
        { key: "gender", label: "Gender", kind: "text" },
        { key: "bloodGroup", label: "Blood Group", kind: "text", placeholder: "O+" },
        { key: "address", label: "Address", kind: "multiline", wide: true },
      ],
    },
    {
      id: "history",
      title: "Medical History",
      fields: [
        { key: "allergies", label: "Allergies", kind: "yesno" },
        { key: "currentMedications", label: "Current Medications", kind: "multiline" },
        { key: "pastSurgeries", label: "Past Surgeries", kind: "multiline" },
        { key: "chronicConditions", label: "Chronic Conditions", kind: "multiline" },
      ],
    },
    {
      id: "doctor",
      title: "Doctor Details",
      fields: [
        { key: "doctorName", label: "Doctor Name", kind: "name", wide: true },
        { key: "insuranceCompany", label: "Insurance Company", kind: "text", wide: true },
        { key: "policyNumber", label: "Policy Number", kind: "text" },
        { key: "groupNumber", label: "Group Number", kind: "text" },
      ],
    },
    {
      id: "consent",
      title: "Consent",
      fields: [{ key: "consentDate", label: "Date", kind: "date", placeholder: "DD / MM / YYYY" }],
    },
  ],
};

export const FORMS: readonly FormDefinition[] = [SCHOOL_FORM, HOSPITAL_FORM];

export function isFormId(value: unknown): value is FormId {
  return value === "school" || value === "hospital";
}

export function formById(id: string | null | undefined): FormDefinition | null {
  return FORMS.find((form) => form.id === id) ?? null;
}

/** Every field across all sections, in reading order. */
export function fieldsOf(form: FormDefinition): FieldDefinition[] {
  return form.sections.flatMap((section) => section.fields);
}

export function fieldByKey(form: FormDefinition, key: string): FieldDefinition | undefined {
  return fieldsOf(form).find((field) => field.key === key);
}

/** Every key blank — the shape the editable form starts from. */
export function emptyValues(form: FormDefinition): FormValues {
  return Object.fromEntries(fieldsOf(form).map((field) => [field.key, ""]));
}

/**
 * Restricts a values object to the form's own keys, filling any that are
 * missing. What a browser or a database row sends is never trusted to have
 * exactly the form's shape.
 */
export function normaliseValues(form: FormDefinition, values: Record<string, unknown> | null | undefined): FormValues {
  const out: Record<string, string> = {};
  for (const field of fieldsOf(form)) {
    const raw = values?.[field.key];
    out[field.key] = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  }
  return out;
}

/** The name a saved scan is listed under. */
export function recordTitle(form: FormDefinition, values: FormValues): string {
  return (values[form.titleKey] ?? "").trim();
}

/** The one-line summary under a saved scan's title: "Class 5 · 98765 43210". */
export function recordSummary(form: FormDefinition, values: FormValues): string {
  return form.summaryKeys
    .map((key) => (values[key] ?? "").trim())
    .filter(Boolean)
    .join(" · ");
}

const CHECKLIST_SEPARATOR = ", ";

/** A checklist value is stored as one string; this is how it is read back. */
export function checklistItems(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function joinChecklist(items: readonly string[]): string {
  return items.join(CHECKLIST_SEPARATOR);
}
