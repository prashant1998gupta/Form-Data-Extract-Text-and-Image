/**
 * Fills the two blank forms with legible sample answers and a pasted
 * photograph, so the app can be tried without a printer.
 *
 *   node --experimental-strip-types scripts/make-samples.ts
 *
 * Reads the blank renders in public/forms/ and writes public/samples/. The
 * answers are the SAMPLE_VALUES below — a known truth to check a scan against.
 * The "photograph" is a synthetic portrait: a print-shaped rectangle with a
 * backdrop, a face and shoulders, pasted a touch crooked as a real one is.
 */

import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const formsDir = join(here, "..", "public", "forms");
const samplesDir = join(here, "..", "public", "samples");

/** The renders are 1754 px wide for 210 mm of paper. */
const PX_PER_MM = 1754 / 210;
/** Positions below were read off a 1055 px wide render; this rescales them. */
const S = 1754 / 1055;

const INK = "#1b2f8c";
const FONT = "'Bradley Hand', 'Chalkboard SE', 'Comic Sans MS', 'Segoe Print', cursive";

interface Mark {
  /** Left edge and baseline, in 1055-scale pixels. */
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly size?: number;
}

interface Tick {
  readonly x: number;
  readonly y: number;
}

interface Sample {
  readonly form: "school" | "hospital";
  readonly marks: readonly Mark[];
  readonly ticks: readonly Tick[];
  /** Where the print goes: centre and size in millimetres, and its tilt. */
  readonly photo: { cxMM: number; cyMM: number; widthMM: number; heightMM: number; rotate: number };
}

export const SAMPLE_VALUES = {
  school: {
    applicationNo: "SPS/2026/0412",
    admissionNo: "A-1187",
    academicYear: "2026-27",
    classApplyingFor: "Class 5",
    studentName: "Aarav Sharma",
    dateOfBirth: "14 / 06 / 2016",
    gender: "Male",
    bloodGroup: "B+",
    aadhaarNo: "4587 2210 9931",
    nationality: "Indian",
    religion: "Hindu",
    category: "General",
    motherTongue: "Hindi",
    address: "B-204, Sunrise Apartments, Sector 45\nNear City Park, Noida",
    city: "Noida",
    state: "Uttar Pradesh",
    pinCode: "201301",
    fatherName: "Rajesh Sharma",
    fatherOccupation: "Engineer",
    fatherMobile: "98765 43210",
    fatherEmail: "rajesh.sharma@email.com",
    motherName: "Priya Sharma",
    motherOccupation: "Teacher",
    motherMobile: "98111 22334",
    motherEmail: "priya.s@email.com",
    previousSchool: "Little Flower School, Noida",
    lastClassAttended: "Class 4",
    board: "CBSE",
    mediumOfInstruction: "English",
    percentageOrGrade: "88%",
    transferCertificateSubmitted: "Yes",
    allergies: "Dust",
    existingMedicalConditions: "None",
    doctorName: "Dr. Mehta",
    emergencyContactPerson: "Rajesh Sharma",
    emergencyContactNumber: "98765 43210",
    medicalBloodGroup: "B+",
    documents: "Birth Certificate, Aadhaar Copy, Previous Report Card, Passport Size Photographs",
  },
  hospital: {
    patientName: "Anita Verma",
    email: "anita.verma@email.com",
    phone: "98765 43210",
    dateOfBirth: "12 / 08 / 1989",
    gender: "Female",
    bloodGroup: "O+",
    address: "45 Lake View Road\nIndiranagar\nBengaluru 560038",
    allergies: "Yes",
    currentMedications: "Metformin 500 mg",
    pastSurgeries: "Appendectomy (2015)",
    chronicConditions: "Type 2 Diabetes",
    doctorName: "Dr. S. Rao",
    insuranceCompany: "Star Health",
    policyNumber: "SH-4471209",
    groupNumber: "G-118",
    consentDate: "04 / 09 / 2026",
  },
} as const;

const school = SAMPLE_VALUES.school;
const hospital = SAMPLE_VALUES.hospital;

const samples: Sample[] = [
  {
    form: "school",
    marks: [
      { x: 190, y: 333, text: school.applicationNo },
      { x: 520, y: 333, text: school.admissionNo },
      { x: 830, y: 333, text: school.academicYear },
      { x: 212, y: 366, text: school.classApplyingFor },
      { x: 215, y: 399, text: school.studentName, size: 15 },
      { x: 165, y: 432, text: school.dateOfBirth },
      { x: 852, y: 432, text: school.bloodGroup },
      { x: 168, y: 465, text: school.aadhaarNo },
      { x: 520, y: 465, text: school.nationality },
      { x: 808, y: 465, text: school.religion },
      { x: 808, y: 499, text: school.motherTongue },
      { x: 140, y: 533, text: "B-204, Sunrise Apartments, Sector 45" },
      { x: 70, y: 573, text: "Near City Park, Noida" },
      { x: 108, y: 630, text: school.city },
      { x: 468, y: 630, text: school.state },
      { x: 838, y: 630, text: school.pinCode },
      { x: 182, y: 716, text: school.fatherName },
      { x: 658, y: 716, text: school.fatherOccupation },
      { x: 158, y: 748, text: school.fatherMobile },
      { x: 500, y: 748, text: school.fatherEmail },
      { x: 186, y: 781, text: school.motherName },
      { x: 658, y: 781, text: school.motherOccupation },
      { x: 158, y: 813, text: school.motherMobile },
      { x: 500, y: 813, text: school.motherEmail },
      { x: 226, y: 962, text: school.previousSchool, size: 11 },
      { x: 212, y: 990, text: school.lastClassAttended },
      { x: 118, y: 1017, text: school.board },
      { x: 222, y: 1045, text: school.mediumOfInstruction },
      { x: 212, y: 1072, text: school.percentageOrGrade },
      { x: 616, y: 962, text: school.allergies },
      { x: 745, y: 990, text: school.existingMedicalConditions },
      { x: 648, y: 1017, text: school.doctorName },
      { x: 745, y: 1045, text: school.emergencyContactPerson, size: 11 },
      { x: 752, y: 1072, text: school.emergencyContactNumber },
      { x: 648, y: 1099, text: school.medicalBloodGroup },
    ],
    ticks: [
      { x: 466, y: 436 }, // Gender: Male
      { x: 168, y: 503 }, // Category: General
      { x: 291, y: 1103 }, // Transfer certificate: Yes
      { x: 68, y: 1194 }, // Birth Certificate
      { x: 68, y: 1219 }, // Aadhaar Copy
      { x: 68, y: 1245 }, // Previous Report Card
      { x: 294, y: 1245 }, // Passport Size Photographs
    ],
    photo: { cxMM: 183.9, cyMM: 31.4, widthMM: 35, heightMM: 45, rotate: 1.6 },
  },
  {
    form: "hospital",
    marks: [
      { x: 178, y: 517, text: hospital.patientName, size: 15 },
      { x: 648, y: 517, text: hospital.email },
      { x: 178, y: 579, text: hospital.phone },
      { x: 706, y: 579, text: hospital.dateOfBirth },
      { x: 656, y: 636, text: hospital.gender },
      { x: 706, y: 689, text: hospital.bloodGroup },
      { x: 96, y: 686, text: "45 Lake View Road" },
      { x: 96, y: 731, text: "Indiranagar" },
      { x: 96, y: 776, text: "Bengaluru 560038" },
      { x: 560, y: 964, text: hospital.currentMedications },
      { x: 96, y: 1041, text: hospital.pastSurgeries },
      { x: 560, y: 1041, text: hospital.chronicConditions },
      { x: 232, y: 1151, text: hospital.doctorName },
      { x: 286, y: 1194, text: hospital.insuranceCompany },
      { x: 236, y: 1240, text: hospital.policyNumber },
      { x: 696, y: 1240, text: hospital.groupNumber },
      { x: 150, y: 1401, text: hospital.consentDate },
    ],
    ticks: [{ x: 290, y: 930 }], // Allergies: Yes
    photo: { cxMM: 168.9, cyMM: 51.6, widthMM: 35, heightMM: 45, rotate: -1.2 },
  },
];

/**
 * A print-shaped synthetic portrait: backdrop gradient, shoulders, neck, a
 * face with hair, and grain so it reads as a photograph rather than a flat
 * fill — the detector measures texture as well as tone.
 */
function renderPortrait(width: number, height: number): Buffer {
  const data = Buffer.alloc(width * height * 3);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const cx = width / 2;
  const faceCy = height * 0.4;
  const faceRx = width * 0.26;
  const faceRy = height * 0.2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const t = y / height;
      let r = 176 + 30 * t;
      let g = 190 + 24 * t;
      let b = 206 + 18 * t;
      // Shoulders.
      const shoulderTop = height * 0.72 - Math.abs(x - cx) * 0.25;
      if (y > shoulderTop) {
        r = 58;
        g = 74;
        b = 92;
      }
      // Neck.
      if (y > faceCy + faceRy * 0.7 && y <= shoulderTop + 4 && Math.abs(x - cx) < width * 0.1) {
        r = 214;
        g = 172;
        b = 140;
      }
      // Face.
      const dx = (x - cx) / faceRx;
      const dy = (y - faceCy) / faceRy;
      if (dx * dx + dy * dy <= 1) {
        r = 224;
        g = 180;
        b = 143;
        // Hair over the top of the head.
        if (dy < -0.35 && dx * dx + (dy + 0.1) * (dy + 0.1) * 0.8 <= 1) {
          r = 46;
          g = 34;
          b = 26;
        }
        // Eyes and mouth.
        if (Math.abs(dy - 0.05) < 0.08 && (Math.abs(dx - 0.35) < 0.12 || Math.abs(dx + 0.35) < 0.12)) {
          r = 40;
          g = 36;
          b = 40;
        }
        if (Math.abs(dy - 0.55) < 0.05 && Math.abs(dx) < 0.3) {
          r = 170;
          g = 96;
          b = 90;
        }
      }
      const grain = (random() - 0.5) * 14;
      const p = (y * width + x) * 3;
      data[p] = Math.max(0, Math.min(255, r + grain));
      data[p + 1] = Math.max(0, Math.min(255, g + grain));
      data[p + 2] = Math.max(0, Math.min(255, b + grain));
    }
  }
  return data;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function handwritingSvg(width: number, height: number, marks: readonly Mark[], ticks: readonly Tick[]): Buffer {
  const texts = marks
    .map(
      (mark) =>
        `<text x="${(mark.x * S).toFixed(1)}" y="${((mark.y - 4) * S).toFixed(1)}" font-size="${((mark.size ?? 13) * S).toFixed(1)}" font-family="${FONT}" fill="${INK}">${escapeXml(mark.text)}</text>`,
    )
    .join("\n");
  const marksSvg = ticks
    .map((tick) => {
      const x = tick.x * S;
      const y = tick.y * S;
      return `<path d="M ${(x - 7).toFixed(1)} ${y.toFixed(1)} L ${(x - 1).toFixed(1)} ${(y + 6).toFixed(1)} L ${(x + 9).toFixed(1)} ${(y - 8).toFixed(1)}" stroke="${INK}" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    })
    .join("\n");
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${texts}${marksSvg}</svg>`,
  );
}

for (const sample of samples) {
  const base = sharp(join(formsDir, `${sample.form}.jpg`));
  const { width, height } = await base.metadata();
  if (!width || !height) throw new Error(`could not read ${sample.form}.jpg`);

  const photoWidth = Math.round(sample.photo.widthMM * PX_PER_MM);
  const photoHeight = Math.round(sample.photo.heightMM * PX_PER_MM);
  const portrait = await sharp(renderPortrait(photoWidth, photoHeight), { raw: { width: photoWidth, height: photoHeight, channels: 3 } })
    .rotate(sample.photo.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const rotated = await sharp(portrait).metadata();
  const left = Math.round(sample.photo.cxMM * PX_PER_MM - (rotated.width ?? photoWidth) / 2);
  const top = Math.round(sample.photo.cyMM * PX_PER_MM - (rotated.height ?? photoHeight) / 2);

  const output = await base
    .composite([
      { input: portrait, left, top },
      { input: handwritingSvg(width, height, sample.marks, sample.ticks), left: 0, top: 0 },
    ])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();

  const file = join(samplesDir, `${sample.form}-filled.jpg`);
  await writeFile(file, output);
  console.log(`${sample.form}-filled.jpg  ${width}x${height}  ${(output.length / 1024).toFixed(0)} KB`);
}
