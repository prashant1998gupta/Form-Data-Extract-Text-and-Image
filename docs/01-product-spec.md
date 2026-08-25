# Product spec — FormLink

Transcribed from [`Doc/Form Data Extract Text and Image.pdf`](../Doc/Form%20Data%20Extract%20Text%20and%20Image.pdf)
(Rionick Studios). The PDF describes two approaches. **We build the second one** — the
Universal Form Digitization Platform — and ship the hospital form as its seeded demo.
Rationale is in §4 below.

---

## 1. The problem

Organizations still collect information on paper. Someone then retypes it into a
computer. That retyping is slow, error-prone, and the paper original is either filed in a
cabinet or lost.

**Core value proposition (the PDF's own words, condensed):** create any digital form
once, then convert matching handwritten physical forms into structured digital records
using AI — while keeping the original physical form digitally archived.

## 2. Approach A — fixed hospital form (the PDF's first half)

A hospital-specific demo. Five screens:

1. Dashboard
2. Scan / Upload Form
3. AI Processing
4. Verify Extracted Information
5. Doctor Preview / Patient Preview

**Flow:** `Scan Form → AI Digitizes → Staff Verifies → Save → Generate Doctor & Patient View`

### 2.1 Scan / Upload
Staff either photographs the patient's physical form or uploads an existing image. **The
complete original image is stored permanently with the patient's digital record.**

### 2.2 AI reads the form
Detects handwritten values for: Patient Name, Phone Number, Mobile Number, Email ID, Age,
Date, Blood Group, Disease / Complaint, Doctor Assigned, and any other hospital-defined
field.

> "Since the hospital generally uses a fixed form format, the system can also understand
> where each field is normally located on the page."

This sentence is the single most important line in the document. It is the licence for
template-based extraction, which is what makes the accuracy target reachable. See
[04-region-extraction.md](04-region-extraction.md).

### 2.3 Detect photograph, signature & thumb impression
From the same image, detect **visual** elements separately and crop them into their own
fields:

- Patient Photograph (a pasted passport-size photo)
- Patient Signature
- Thumb Impression

> "If any of these elements are not available on the form, the application should simply
> show **Not Detected**. The system should never automatically generate or assume missing
> information."

**This is a hard product rule, not a nicety.** A wrong crop is worse than no crop. It is
enforced in code by the decision rule in [04-region-extraction.md](04-region-extraction.md)
and by tests.

### 2.4 Verification screen
Two-up: original uploaded form on the left, digitized information on the right. Every
AI-detected field stays editable. Low-confidence fields are highlighted for manual review.

The PDF's example of the intended presentation:

```
Rahul Sharma  — 96% Confidence
Diabetes      — 71% Confidence — Review Required
```

### 2.5 Save patient record
Stores patient information, photograph, signature, thumb impression, original scanned
form, scan date and time, assigned doctor, and a Patient ID / Registration Number.

### 2.6 Live preview — two tabs

**Doctor View** — a compact digital patient sheet: name, photograph, patient ID, contact
information, age, blood group, disease/complaint, assigned doctor, registration date,
current appointment, next appointment, signature/thumb impression, original scanned form.
Later expandable with visit history, prescriptions, medical reports, doctor notes and
previous appointments.

**Patient View** — much simpler, a digital information receipt:

```
Hospital Name
Patient: Rahul Sharma
Patient ID: HSP-10238
Doctor: Dr. Amit Sharma
Visit Date: 24 August 2026
Next Appointment: 31 August 2026, 11:30 AM

General Instructions
 • Take medicines as prescribed by the doctor.
 • Bring previous medical reports during the next visit.
 • Arrive at least 15 minutes before the scheduled appointment.
 • Contact the hospital in case the appointment needs to be rescheduled.
```

With **Download Patient Receipt** and **Print Patient Receipt** at the bottom, and a QR
code "added later" so the patient can reopen the receipt from their phone.

### 2.7 Human verification is mandatory
> "The system should not directly push AI-extracted information into the hospital
> database without human verification."

Called out as especially important for Patient Name, Blood Group, Disease, Doctor
Assignment and Phone Number. There is no auto-save path in this product. Ever.

### 2.8 Future scalability (stated inside Approach A)
Fields must be **configurable, not hard-coded** — different hospitals want Aadhaar
Number, Address, Gender, Emergency Contact, Guardian Name, Allergies, Medical History,
Insurance Information, Referral Doctor.

This requirement is what collapses Approach A into Approach B.

## 3. Approach B — Universal Form Digitization Platform (the PDF's second half)

Make the technology independent of any specific form or industry. Usable by hospitals,
schools, colleges, government departments, clinics, offices, insurance companies, HR
departments — anyone who still collects information on paper.

**Flow:** `Admin Creates Digital Form → Publish → Staff Opens Form Link → Scan Physical
Form → AI Extracts Data → Staff Verifies → Save Digital Record`

### 3.1 Sub-admin system
Every organization gets its own Sub-Admin Panel. The org admin recreates their existing
paper form as a digital form. No coding knowledge required.

### 3.2 Create a form
`Create New Form`, give it a name — "New Patient Registration Form", "Student Admission
Form", "Employee Joining Form", "Insurance Application Form".

### 3.3 Create sections
e.g. Personal Information, Contact Information, Medical Information, Documents,
Declaration.

### 3.4 Create fields
Field types the platform must offer:

| | | |
|---|---|---|
| Short Text | Long Text | Name |
| Phone Number | Email | Number |
| Date | Age | Address |
| Dropdown | Checkbox | Radio Button |
| **Photograph** | **Signature** | **Thumb Impression** |
| Document/Image | Custom Field | |

The admin looks at the paper form and recreates every writable field:

```
Paper:  Patient Name: __________     →   Field Name: Patient Name, Field Type: Text
Paper:  Blood Group:  __________     →   Field Name: Blood Group, Field Type: Dropdown / Text
```

### 3.5 Publish the form
`Publish Form` generates a unique link. The org uses that link internally on computers,
tablets or mobile devices.

### 3.6 Scan physical form
Staff open the published link, click `Scan Physical Form`, and take a picture or upload a
scan. **The AI reads the uploaded form and compares the detected information with the
fields created by the admin** — i.e. the admin-defined schema constrains extraction. The
AI searches specifically for information corresponding to those fields.

### 3.7 AI populates the digital form
Values land in their respective fields. Photograph, signature and thumb impression are
detected, **cropped separately**, and placed into the corresponding image fields.

### 3.8 Manual verification
Original physical form alongside the AI-generated digital form. Anything wrong is edited
before submission.

### 3.9 Save record
Stores: structured digital information, original scanned form, extracted photograph,
signature, thumb impression, uploaded documents, creation date and time, form used, and
the user who processed the record.

### 3.10 Why the PDF prefers this
The technology stops being tied to one hospital or one form. The organization itself
defines what the AI should extract. The platform becomes reusable **Physical Form to
Digital Data Infrastructure**.

## 4. What we are building, and why

**We build Approach B, and seed it with the Approach A hospital form.**

Three reasons:

1. **Approach A's own "Future Scalability" section demands Approach B.** Configurable
   fields per organization *is* the sub-admin form builder. Building A first means
   building the schema layer twice.
2. **Approach B makes the accuracy story better, not worse.** A user-defined field list
   is a constraint on the model: it turns open-ended "read this form" into "find exactly
   these 14 things, and say Not Detected for anything you cannot find". Constrained
   extraction beats open extraction on every axis that matters here.
3. **The hospital demo survives intact.** A seeded "New Patient Registration Form"
   template plus the Doctor View and Patient View render on top of the generic record
   model. Nothing in §2 is lost; it becomes the first tenant rather than the whole
   product.

### 4.1 Scope boundary
> "The first demo should not attempt to become a complete hospital-management system."

The demo proves exactly one thing: **convert a handwritten physical form into a
structured digital record within seconds.** Appointments, prescriptions, visit history,
billing and reports are explicitly out of scope; the data model leaves room for them but
no screen is built.

### 4.2 The priority, stated by the owner
The main part is **passport-size photograph and signature extraction**. Text extraction
is the table stakes (the sibling product CardLink already proves that path); accurate,
tight, correct **image region cropping** is the differentiator and gets the engineering
budget. Accuracy is the goal, not speed and not cost.

## 5. Requirements checklist

Derived from the above. Each maps to a test or a screen.

### Must
- [ ] Org admin builds a form from sections + fields, no code, and publishes it to a link.
- [ ] All 17 field types from §3.4 exist and render in the builder and the verify screen.
- [ ] Staff capture via camera or file upload, on desktop and mobile.
- [ ] The **original image is stored permanently and unmodified** with the record.
- [ ] Extraction is constrained to the admin-defined field schema.
- [ ] Photograph, signature and thumb impression are detected and cropped as separate images.
- [ ] Absent elements report **Not Detected**. Nothing is ever fabricated.
- [ ] Per-field confidence, with low-confidence fields flagged **Review Required**.
- [ ] Verify screen: original left, editable digital form right.
- [ ] No record is written without an explicit human Save.
- [ ] Record stores: values, original scan, cropped images, documents, timestamp, form
      version used, and the user who processed it.
- [ ] Hospital tenant renders Doctor View and Patient View from a saved record.
- [ ] Patient receipt downloads and prints.

### Should
- [ ] Staff can correct a crop by dragging its box on the original image.
- [ ] A correction improves subsequent scans of the same form (template learning).
- [ ] QR code on the patient receipt.

### Out of scope for the demo
Appointment scheduling, prescriptions, billing, lab reports, inventory, multi-page forms
beyond a documented limit, and any hospital-management feature not named above.

## 6. Where the rest of the design lives

| Doc | Covers |
|---|---|
| [02-architecture.md](02-architecture.md) | Stack, deployment, module layout |
| [03-data-model.md](03-data-model.md) | Postgres schema, RLS, Storage buckets |
| [04-region-extraction.md](04-region-extraction.md) | Photo / signature / thumb detection — the core engine |
| [05-text-extraction.md](05-text-extraction.md) | Field reading, validation, normalization |
| [06-confidence.md](06-confidence.md) | How every percentage on screen is computed |
| [07-templates.md](07-templates.md) | Template learning, registration, feedback loop |
| [08-testing.md](08-testing.md) | Fixtures, synthetic forms, what is asserted |
