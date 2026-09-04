# FormLink

Photograph a filled-in paper form. The answers and the person's photograph are
read into an editable record. Check it against the paper, save it, and find it
again in the saved list.

Built in the shape of [CardLink](https://github.com/prashant1998gupta/Card-to-Connect)
(Card-to-Connect): pick what you are scanning, one photo, one AI call, an
editable form, a save, a list.

**Two forms today**, defined in code:

| Form | Sections | Fields | Photograph |
|---|---|---|---|
| School Admission Form (Sunrise Public School) | Student, Parent / Guardian, Academic, Medical / Emergency, Required Documents | 41 | student photo, top right |
| Hospital Patient Form (Rimberio Hospital) | Patient, Medical History, Doctor Details, Consent | 16 | patient photo, top right |

**Never read:** signatures and thumb impressions. The product fills text and
the photograph, nothing else.

---

## How a scan works

1. **Choose the form** on the home screen.
2. **Photograph the filled-in copy** — camera or gallery. The browser downsizes
   it to 3500 px on the long edge (300 dpi of A4, and inside Vercel's 4.5 MB
   body limit) and posts it once to `/api/extract`.
3. **One model call reads everything.** The capture goes to Groq's vision
   model with the form's field list; the reply is one JSON object with every
   field and, alongside them, where the pasted photograph is as a box in
   thousandths of the picture. No page straightening first: the model reads a
   tilted page on a desk as well as a flat scan, and the box refers to the
   picture as taken.
4. **The photograph is cut, never generated.** The model's box is good to
   about a tenth of the picture, so it is a place to search, not a crop. In
   a region several prints wide around it, the print is found as a block of
   continuous tone surrounded by paper and read out to its own extent; then
   the edge-fitting detector (`lib/regions/photo.ts`) measures its four
   sides and delivers it upright at print resolution. When the edges cannot
   be measured — a faint backdrop, a blurred capture — the block itself is
   cut at lower confidence and flagged; a box on blank paper is refused. The
   pixels always come from the upload (`lib/photo/locate-photo.ts`).
5. **The record fills in.** Fields the model could not read are highlighted
   amber and left blank rather than guessed. The photograph sits at the top,
   with Replace and Remove.
6. **Save.** One explicit action writes the record — the model's raw output is
   never stored. With a database, scans go to Postgres and photographs to
   Storage; without one, they stay in the browser's IndexedDB, and the app
   says which on screen.
7. **Saved scans** lists everything with the photograph, a reference such as
   `SCH-4F2A19`, search, a filter per form, a detail drawer, Edit and Delete.

Try it without a printer: `public/samples/school-filled.jpg` and
`public/samples/hospital-filled.jpg` are the two forms filled in with the
values in `scripts/make-samples.ts` and a pasted photograph.

---

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

| Variable | What it does |
|---|---|
| `GROQ_API_KEY` | Turns reading on. Without it, the scan button explains that reading is off and the record can still be filled by hand. Free tier at console.groq.com/keys. |
| `GROQ_MODEL` | Optional. Default `qwen/qwen3.6-27b`, Groq's current vision model. |
| `GROQ_BASE_URL` | Optional. A Groq-compatible endpoint (a proxy, or a local stand-in). |
| `FORMLINK_MAX_SCANS_PER_MINUTE` | Optional. Scans per minute per server instance that may reach the model (default 10). A brake, not a lock. |
| `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Optional. Turns database saving on. The publishable key works too. |

Node 22.13 or newer.

```bash
npm run dev          # localhost:3000
npm run build
npm run lint
npm run typecheck
npm test             # forms, prompt, parser, reader, validation, the photo pipeline, vision primitives
node --experimental-strip-types scripts/make-samples.ts   # regenerate public/samples from public/forms
```

### Database

The Supabase project is `formlink` (`wslxnqmfokecaowycqac`, ap-south-1).
`supabase/migrations/20260903210818_scans.sql` creates the `scans` table and
is applied. Photographs go to the existing private `crops` bucket under
`scans/<id>/` and are streamed through `/api/scans/[id]/photo`, so no storage
URL for a person's face ever reaches a browser.

There are no accounts yet. The endpoints are unauthenticated and the table's
policies let the anon key read, write and delete — the honest posture for a
demo, and the first thing to change before a public deployment. The previous
product's `forms` and `records` tables, its files and its `captures` bucket
were retired on 2026-09-04 (`20260904044030_retire_previous_product.sql` and
`20260904044112_retire_previous_product_cleanup.sql`); only `scans` and the
`crops` bucket remain.

---

## Where things are

```
app/page.tsx                 the form chooser, and what this server can do
app/scan/[form]/page.tsx     the scan screen for one form (?edit=<id> opens a saved scan)
app/saved/page.tsx           the saved list
app/api/extract/route.ts     one scan: Groq reads the page and locates the photograph, which is cut locally
app/api/scans/                list, save, get, update, delete, photo
components/scanner/          ScanPanel, Scanner, RecordForm, Field
components/saved/            SavedScans (list + drawer)
lib/forms/definitions.ts     THE TWO FORMS — sections, fields, kinds, photo size
lib/extract/                 prompt builder, reply parser, Groq client, retry, throttle
lib/photo/locate-photo.ts    cut the photograph where the model located it, measuring its edges
lib/regions, lib/vision, lib/ink, lib/geometry   the computer vision underneath it
lib/db/scans.ts              Postgres + Storage
lib/client/                  upload preparation, the scan call, the two stores (API / IndexedDB)
lib/scans/                   shared types, references, input validation
scripts/make-samples.ts      fills the blank forms in public/forms with sample answers
supabase/migrations/         the schema, applied
tests/                       node --test, no network
```

### Adding a form

Add an entry to `lib/forms/definitions.ts`: its sections and fields (key,
printed label, kind — text, name, phone, email, date, number, multiline,
choice, yesno, checklist — and options), which field names a record, and the
size of the pasted photograph in millimetres. Put a blank render in
`public/forms/`. Everything else — the prompt, the parser,
the editable form, the saved list — is generated from the definition.

---

## Limits, stated plainly

- **Reading needs a key.** The Groq call is the product; with no key the app
  is a form you fill by hand.
- **The photograph must be visible in the picture.** It is cut where the
  model says it is; a picture that misses the top of the form yields the
  text but no photograph, and says so. A crop marked "check the crop" was cut
  around the block the search found, without measured edges — look before
  saving.
- **No accounts.** Anyone with the URL can scan, save, read and delete.
- **One instance's throttle is one instance's.** Set a spend cap with Groq
  before putting a key on a public deployment.
