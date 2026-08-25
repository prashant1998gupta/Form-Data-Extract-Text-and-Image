/**
 * The seeded hospital template — "New Patient Registration Form".
 *
 * The spec describes a hospital demo and then a universal platform, and notes
 * that the hospital's own "Future Scalability" requirements (configurable
 * fields per organization) collapse the first into the second. So the hospital
 * form is not the product; it is the product's first tenant, defined here in
 * exactly the shape the builder will emit.
 *
 * Geometry is in millimetres on A4 and matches the layout the synthetic form
 * generator renders, which is what lets the whole pipeline be exercised
 * end-to-end without a real scan.
 */

import { A4 } from "../geometry/frames.ts";
import type { FormTemplate } from "./types.ts";

export const HOSPITAL_TEMPLATE: FormTemplate = {
  id: "seed-hospital-registration",
  name: "New Patient Registration Form",
  page: A4,
  hasGeometry: true,
  sections: [
    {
      id: "personal",
      title: "Personal Information",
      fields: [
        { id: "f-name", key: "patientName", label: "Patient Name", type: "name", required: true, box: { xMM: 55, yMM: 47, widthMM: 90, heightMM: 8 } },
        { id: "f-age", key: "age", label: "Age", type: "age", box: { xMM: 55, yMM: 58, widthMM: 90, heightMM: 8 } },
        {
          id: "f-blood",
          key: "bloodGroup",
          label: "Blood Group",
          type: "dropdown",
          options: ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"],
          box: { xMM: 55, yMM: 69, widthMM: 90, heightMM: 8 },
          hint: "Always confirm against the paper — one stroke separates B+ from B-.",
        },
      ],
    },
    {
      id: "contact",
      title: "Contact Information",
      fields: [
        { id: "f-mobile", key: "mobileNumber", label: "Mobile Number", type: "phone", required: true, box: { xMM: 55, yMM: 80, widthMM: 90, heightMM: 8 } },
        { id: "f-email", key: "email", label: "Email ID", type: "email", box: { xMM: 55, yMM: 91, widthMM: 130, heightMM: 8 } },
      ],
    },
    {
      id: "medical",
      title: "Medical Information",
      fields: [
        { id: "f-date", key: "visitDate", label: "Date", type: "date", box: { xMM: 55, yMM: 102, widthMM: 130, heightMM: 8 } },
        { id: "f-disease", key: "disease", label: "Disease / Complaint", type: "shortText", box: { xMM: 55, yMM: 113, widthMM: 130, heightMM: 8 } },
        { id: "f-doctor", key: "doctor", label: "Doctor Assigned", type: "shortText", box: { xMM: 55, yMM: 124, widthMM: 130, heightMM: 8 } },
      ],
    },
    {
      id: "documents",
      title: "Documents",
      fields: [
        {
          id: "f-photo",
          key: "patientPhotograph",
          label: "Patient Photograph",
          type: "photograph",
          photoSize: "passport35x45",
          // The pasted photo, and separately the printed rectangle it sits in.
          // Keeping both is what lets the detector prefer the inner of two
          // parallel edges instead of cropping the empty box.
          box: { xMM: 160.2, yMM: 29.8, widthMM: 36, heightMM: 46 },
          printedBorder: { xMM: 160.2, yMM: 30.3, widthMM: 35, heightMM: 45 },
        },
      ],
    },
    {
      id: "declaration",
      title: "Declaration",
      fields: [
        {
          id: "f-signature",
          key: "patientSignature",
          label: "Patient Signature",
          type: "signature",
          box: { xMM: 16.3, yMM: 225.2, widthMM: 79.6, heightMM: 22 },
          baselineMM: 244.5,
        },
        {
          id: "f-thumb",
          key: "thumbImpression",
          label: "Thumb Impression",
          type: "thumbImpression",
          box: { xMM: 149, yMM: 233.7, widthMM: 30.5, heightMM: 37.2 },
          printedBorder: { xMM: 149, yMM: 233.7, widthMM: 30.5, heightMM: 37.2 },
        },
      ],
    },
  ],
};

export const SEEDED_TEMPLATES: readonly FormTemplate[] = [HOSPITAL_TEMPLATE];

export function templateById(id: string): FormTemplate | undefined {
  return SEEDED_TEMPLATES.find((template) => template.id === id);
}
