# FormLink

Turn handwritten paper forms into verified digital records.

**What this is today.** Photograph a filled-in form and it **crops the pasted
passport photograph, the signature and the thumb impression as separate
images**, and — when an AI key is configured — **reads the handwritten text
fields** and presents every value for human verification beside the exact crop
it was read from. It works on any form: draw a box around each element once —
the three image elements, and labelled text fields, up to 40 regions in all —
and that form is extracted, and with a key read, from then on.

**There is exactly one model call in it, and it is optional.** Everything
geometric is a deliberate no-AI design: `sharp` decodes and resizes, and every
measurement is pure-TypeScript computer vision written for this problem
(thresholding, morphology, connected components, convex hull, RANSAC line
fitting, homographies). When it reports 97 % on a photograph it has measured a
step in lightness, chroma and texture across a physical boundary — it is not
recognising anything. The one thing that machinery cannot do is *read*, so
handwritten text goes to a vision model (`lib/reader/`) under a deliberately
narrow contract: **the model supplies values, never geometry** — one field per
request, or one numbered composite per scan where a provider's limits demand
it, always from crops this pipeline cut deterministically. No key, no model
call — and the app runs exactly as before.

**It is a whole application now, not a scanner.** Build a form by photographing
a blank copy and drawing on it, publish it to a link, scan filled copies from
that link, check every value, and **Save** — which writes one record with the
extracted images and the original photograph of the paper archived beside it,
readable afterwards as a Doctor view and a printable Patient receipt. The
database half is optional too: without one, everything above still scans and
reads, and only publishing, saving and the record views say they are off.

**What is still not built.** Accounts and organizations — the endpoints are
unauthenticated, which is the honest limit on deploying this publicly. Sections
inside a form, the `document` and `custom` field types, the learning-from-
corrections loop, and the confidence calibrator. Read [Status](#status) before
quoting any of it to anyone.

Spec: [`Doc/Form Data Extract Text and Image.pdf`](<Doc/Form Data Extract Text and Image.pdf>) ·
transcribed in [docs/01-product-spec.md](docs/01-product-spec.md).

---

## Status

**The region-extraction engine, the verification screen, and teaching the app a
new form by drawing on it are built, measured and running.** That is the hard
part and the differentiator — and it runs with **zero model calls**.

Any form works, not just the seeded one: photograph it, drag a box around the
photo, signature and thumb, and it is extracted from then on. Boxes are stored
in millimetres against the rectified page, so one drawn on a phone means the
same thing on a scan next week. The detector is told the geometry came from a
finger rather than from registration and widens its prior accordingly, so a box
a few millimetres out still yields a usable crop — **IoU 0.92–0.99 measured end
to end through the pipeline across 0–8 mm of drawing error.** (The tighter
0.98-and-up sweep recorded in [`params.ts`](lib/regions/params.ts) is the
detector measured on its own; the pipeline figure is the one to quote, and it
dips to ~0.92 around 2–3 mm.)

**The drawn box is the declared photo size — any size.** A taught template
never names a photo size, and defaulting that silence to passport 35×45 mm made
a guess indistinguishable from a declaration: a 56×76 mm hospital print was
located correctly, edge by edge, then refused as "the wrong size". The box a
person draws is now the size the detector is told (with a looser window than a
named size gets, because a finger is a few millimetres out), and the crop is
delivered at the photograph's own measured shape. **Faint edges are measured,
not apologised for:** a pale studio backdrop on white paper, with the form's
printed rule a few millimetres outside it, used to come back as "2 of 4 edges
could not be measured"; the detector now re-measures a side the strict pass
could not see, refuses to call a printed rule a boundary while a real one is
available, and caps the confidence of anything it found that way so it always
reaches a human.

**Built, behind a key.** Handwritten text extraction for every text field the
template declares with geometry — the seeded hospital form's eight, and any
field drawn in the builder: draw a box, name it as the form prints it, pick its
answer shape (name, phone, date, dropdown with its printed choices, …). Set
`GROQ_API_KEY` or `ANTHROPIC_API_KEY` (see [Reading the handwritten
text](#reading-the-handwritten-text)) and each field is transcribed by a vision
model and shown for review beside the crop it was read from. Without a key the
section says so and everything else runs unchanged. 15 of the spec's 17 field
types can be declared; `document` and `custom` cannot.

**Built, behind a database.** The whole workflow: **build** a form by
photographing a blank copy and drawing on it, **publish** it to a link, **scan**
filled copies from that link, **save** a verified record, and read it back as a
**Doctor view** and a printable **Patient receipt**. The original capture is
archived with each record, and every saved value carries how it came to be —
`read`, `corrected`, `typed` or `blank` — which is what makes a record
auditable rather than merely stored. Set `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`; without them these screens say so and the scanner
still runs. See [The application](#the-application).

**Not built.** ACCOUNTS — every endpoint is unauthenticated, and that is the
honest limit on deploying this publicly with real patient data: anyone with the
URL can publish a form, save a record, or read one. Sections inside a form. The
`document` and `custom` field types. The learning-from-corrections loop
(a correction improves that scan only; it does not yet teach the template). The
confidence calibrator. Template registration against a *stored blank* —
[`template-anchors.ts`](lib/regions/template-anchors.ts) checks only that a
template's own declared landmarks are where it says, which is a far weaker
claim than the anchor-atlas registration the architecture describes.

The full plan is in [docs/02-architecture.md](docs/02-architecture.md), which is
a build spec rather than a sketch. It describes the finished system; most of it
is still ahead.

```bash
npm install
npm run dev            # http://localhost:3000
npm test               # 238 tests
npm run build

node --experimental-strip-types scripts/demo-extract.ts    # crops to disk, scored
node --experimental-strip-types scripts/preview-fixture.ts # generate fixtures
node --experimental-strip-types scripts/make-samples.ts    # rebuild public/samples
```

Node >= 22.13. **Nothing above needs a key** — the crops, the tests and the
demo script call no model and touch no database. Copy `.env.example` to
`.env.local` to switch either optional half on: `GROQ_API_KEY` (free tier at
console.groq.com/keys) or `ANTHROPIC_API_KEY` for the reader,
`NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` for persistence.
Three sample forms are bundled — a desk photo, a photocopy, and a genuinely
blank one: anyone can demo a detector on a form with everything pasted on it,
and the question a hospital actually asks is what happens when the patient
brought no photograph.

---

## The application

Four screens, in the order the product is used.

**Forms** (`/forms`, `/forms/new`) — build a form by photographing a **blank**
copy and drawing a box around everything people write in. Every competing
design of this screen is a widget-dragging form builder, and every one of them
produces a digital form that has no idea where anything is on the paper. This
product's whole advantage is that it knows, so the builder *is* the paper:
boxes on the rectified page, stored in millimetres. Publishing mints a link.

**A form's link** (`/f/<slug>`) — what staff open. The geometry is loaded
server-side and identified to the scanner by id alone: a published form's boxes
belong to the organization, and a scan must not be able to redefine where its
own crops are cut.

**Verify and Save** — the same two-up screen as ever, plus one button. Save
sends what the human left, not what the reader produced, each value tagged
`read` / `corrected` / `typed` / `blank`. That tag is the audit trail, and it
costs one field.

**Records** (`/records`, `/r/<reference>`) — the Doctor view (everything, with
the evidence crops and a link to the archived original) and the Patient receipt
(deliberately simpler, and printable). References are random rather than
sequential: `HSP-4F2A19` printed on a receipt should not tell a stranger how
many patients were seen this week.

Two notes on how the data is handled, because both are load-bearing:

- **The images are served by this application, never as storage links.** A
  signed URL in the page is a bearer token for a patient's photograph that
  keeps working after the tab closes and can be pasted anywhere. The buckets
  are private and the token never leaves the server.
- **A stored form round-trips through the same parser a browser-supplied one
  does.** The database is a second door into the extractor; it gets the same
  lock. See the trust-boundary note in
  [`lib/templates/custom.ts`](lib/templates/custom.ts).

The schema, its row-level security, and what those policies do and do not
promise are in the migrations applied to the project (`forms`, `records`, and
two private storage buckets). **There is no authentication yet**, so the
policies are written for that reality rather than pretending otherwise — read
the note in the migration before putting real patient data behind this.

Measured through the running app, end to end:

```
filled, photographed on a desk   [perspective]  photo 99%  signature 99%  thumb 70% (review)
photocopy                        [full-frame]   photo 72% (review, greyscale cap)
                                                signature 94%  thumb 70% (review)
unfilled                         [full-frame]   all three Not Detected, with reasons
```

~2.5 s per page on a laptop, most of it photometric normalisation.

---

## The one rule everything obeys

> **A wrong crop is worse than no crop.**

A miss is visible on the verification screen and takes one drag to fix. A
plausible wrong crop slips through review and lands in a patient record. So the
acceptance gate is conjunctive and deliberately biased toward refusing, and
"Not Detected" is an asserted conclusion with a stated reason — never a shrug.

Which is exactly why **absence is only asserted once presence has been
established**. A refusal that is confidently wrong spends the same trust a wrong
crop does, one step earlier: told "the box was located and is empty" about a
page that was never a form, staff learn to discount every refusal the product
makes. So [`lib/regions/form-presence.ts`](lib/regions/form-presence.ts) checks
that the capture carries printed structure — lines of set type, or printed rules
— before any detector is addressed by template coordinates, and reports what it
measured when it does not. The bar is deliberately on the floor, three of
either: a wrong refusal here would reject a real patient's real form, which is
worse than the bug it prevents. Every sample form clears it five times over, and
the unfilled form still reports all three elements as Not Detected — two as
verifiably empty boxes and the thumb as below-threshold, which is a different
and weaker claim, correctly made.

Four more, in [`lib/regions/params.ts`](lib/regions/params.ts):

- **No model coordinate ever reaches a stored crop.** Vision models supply
  search regions, classifications and — in the reader — transcribed values.
  Geometry comes from registration and deterministic image processing.
- **"Not Detected" never carries a percentage.** There is no calibrated
  probability for a non-event, and false precision destroys trust in every other
  number on screen.
- **No number on screen is a model's opinion of itself.** No provider exposes
  logprobs for a vision call; a self-reported confidence is generated text that
  looks like a number.
- **No record is written without an explicit human Save.**

---

## Measured accuracy

Against the synthetic corpus, which carries exact ground truth. **Every number
below is printed by `node --experimental-strip-types scripts/demo-extract.ts`**
— run it and check. Nothing here is an estimate, and nothing is quoted that the
script does not produce.

> An earlier version of this table was optimistic by 0.006–0.011 on every
> photograph row, quoted two conditions the script never measured, and carried a
> "max edge error" column that nothing in the repository computes. It was also
> the one row-set that hid its worst case. The numbers are re-measured, the
> missing condition is now a real variant, and the columns that could not be
> reproduced are gone. A published accuracy figure no command reproduces is
> indistinguishable from one that was invented.

**Passport photograph** — IoU of the detected quadrilateral against the true
physical boundary of the pasted photo:

| Condition | IoU | Confidence |
|---|---|---|
| Clean scan | 0.985 | 0.93 |
| Shadow gradient + noise | 0.973 | 0.96 |
| Photocopy, greyscale photo | 0.978 | 0.72 |
| Specular glare | 0.975 | 0.93 |
| Page skewed 4.5° | 0.985 | 0.94 |
| **Photo pasted 6° crooked** | **0.844** — rotation recovered as 5.6° | 0.94 |

The crooked row is the weakest and is stated rather than omitted. Rotation
recovery works; the quad it fits to a rotated paste is measurably looser than
one fitted to a square one, and no amount of confidence should disguise that.

**Signature** — containment of the true ink. A crop that swallows the printed
label fails even with a respectable IoU, so containment rather than IoU is the
measure that matters:

| Condition | Contains |
|---|---|
| Clean | 0.986 |
| Photocopy | 1.000 |
| Shadow | 0.986 |
| Glare | 0.986 |
| **Page skewed 4.5°** | **0.751** |

Skew is the signature's weak case too, and worth knowing before anyone photographs
a form at an angle.

**Thumb impression** — containment 0.917–0.925 across clean, shadow, glare and
photocopy. **On the 4.5° skewed page it is missed entirely** (`below_threshold`).
Confidence is **hard-capped at 0.70 and review is always required**, because
without ridge verification this detector cannot support a stronger claim. That
is enforced in the detector, not left to the caller.

Ridge-frequency analysis is deliberately *not* used. Real stamp-pad impressions
are usually over-inked into a solid smudge with no resolvable ridges; phone
image pipelines denoise away the 0.4–0.6 mm band; and JPEG's 8×8 blocking puts
spurious energy right beside it, so the fallback fires on compression
artefacts. Machinery that works on flatbed scans and almost never in the field
is worse than none, because it produces confident wrong answers where honest
uncertainty was available.

**Refusals.** An empty printed photo box, blank paper, a signature region shown
to the photo detector, printed text in a signature box, and a thumb impression
in a signature box are all refused, each with a distinct reason. A signature
written *in the thumb box* is reported as a wrong-box warning rather than
cropped into a biometric field or silently ignored — the template knows which
box is which, so that is a human error the system can surface.

These are synthetic-corpus numbers. Real handwritten Indian hospital forms will
be harder, and no number here should be quoted to a customer before it has been
measured on real ones. [docs/02-architecture.md §12](docs/02-architecture.md)
sets out honest expectations, including the ones that are not good.

---

## Why it works: boundary, not appearance

The obvious way to find a pasted photo is to look for photo-like pixels —
colour, texture, faces. That fails on the single most common real input.

The modal Indian passport photo is a person on a **white or pale-blue studio
backdrop**, printed on **white photo paper**, pasted onto **white form paper**.
Segment any appearance map correctly and you get the head and shoulders, not the
rectangle. A head-and-shoulders blob then fails every aspect-ratio and
rectangularity check, so the detector either rejects a photo that is plainly
there or "fixes" it by snapping to the printed box — a guess wearing a
measurement's clothes.

But a pasted photo **always has a hard physical boundary**: a step in lightness,
or in chroma, or — when the tones genuinely match — in high-frequency texture
energy, because photographic emulsion and paper fibre never share a grain.

And because registration says where the box is to within a fraction of a
millimetre, the job is not to *find* a rectangle. It is to **measure four
lines**. That is a far easier problem, it yields the paste angle for free, and
it fails loudly: an edge that cannot be measured is reported as such, never
replaced by the template's own edge.

Appearance is still used — but only to **accept or reject** the quadrilateral
the boundary fit produced. It never decides where the boundary is.

The signature works the same way in reverse: the printed rule and caption are
subtracted first, so the question stops being "find handwriting among printed
text" and becomes "measure the only ink present". The deliverable is **ink on a
transparent background** in the pen's own colour, which composites onto a
discharge summary without a white box around it — only possible because the rule
was removed.

## Reading the handwritten text

The one thing measurement cannot do is read, so reading is the one model call —
and it is boxed in on every side (`lib/reader/`):

**One field, one request, one crop.** Each text field's answer area is cut from
the rectified page at its template-declared box — the same millimetre geometry,
in the same canonical space, that anchors the photograph's search region —
padded 2.5 mm for ascenders and overruns, and sent as its own request. The
model is never shown the whole page and never asked which field a value
belongs to: request N *is* field N, so a value cannot land under the wrong
label by a model miscounting rows. The alternative — one page-sized request
returning key–value pairs — asks the model to do attribution, which is
geometry, which is the thing a model does not supply here.

**Except where the provider's limits price that out — then one honest pass.**
Groq bills every image a flat ~2k input tokens and its free tier caps tokens
per minute below eight requests' worth, so a per-field scan there can *never*
finish. On such providers the reader switches to **composite mode**
(`lib/reader/composite.ts`): every crop stacked into one image, each strip's
number printed into the pixels by us, one request per scan. The reply is keyed
by strip number — a skipped strip fails that field alone and can never shift
its neighbours — and every value still lands in front of a human beside its
own crop. Default: composite on Groq, per-field on Anthropic;
`FORMLINK_TEXT_MODE` overrides.

**A rate limit is retried, not reported.** A free-tier 429 is a *window*, and
the first retry usually lands inside it. Every request gets up to three
attempts (`lib/reader/read-text-fields.ts`, `MAX_ATTEMPTS`), waiting the delay
the provider named in `retry-after` — up to 15 s per wait — or an exponential
backoff when it named none, and every wait is clamped to what remains of the
scan's 40 s budget. Only when the budget genuinely cannot fit another attempt
does the screen say "the reader is rate limited"; the crops above it are never
affected either way, and **Read again** re-sends the same capture without
re-photographing.

**The evidence is the model's own input.** The verify screen shows each value
beside the crop the model read — byte for byte in per-field mode; in composite
mode, the same pixels the model saw at that strip's position, re-encoded on
their own. Every value is editable and every value requires review — there is
no confidence number that buys a value out of it, because no number on screen
may be a model's opinion of itself.

**Blank and unreadable are different answers.** `""` means the model asserts
the box is empty — a positive claim about examined pixels. `null` means it
declined to guess, and the screen says "could not be read — check the paper"
with no percentage attached, for the same reason "Not Detected" never carries
one. The prompt says it in so many words: a plausible wrong reading is worse
than none.

**No reading without identity.** Text is read only after the page passes both
recognition gates — it is a printed form, and it is *this* form. A crop found
on an unregistered page degrades honestly to an "unconfirmed candidate"; a text
value has no honest degraded form, because a value is nothing but a labelled
claim. So on an unregistered page no field is read at all, and the screen says
why.

**The reply is untrusted input.** It is parsed against a closed contract (one
JSON object, one member), clamped, and mapped to a key the server chose —
never a key the model returned. Handwriting is transcribed as content, never
followed as instructions; the worst a hostile sentence on paper can achieve is
appearing, faithfully transcribed, in its own box on a review screen.

Providers: `GROQ_API_KEY` (default model `qwen/qwen3.6-27b` — Groq shut down
both Llama 4 vision models in 2026, so the older IDs floating around no longer
serve) or `ANTHROPIC_API_KEY` (default `claude-opus-5`). With both set, Claude
is used unless `FORMLINK_TEXT_PROVIDER=groq`; `FORMLINK_TEXT_MODEL` overrides
the model. Keys live in `.env.local`, server-side only — which reader runs is
decided by the environment, never by anything in the request.

**A key on a public deployment is spend anyone can trigger.** `/api/extract`
has no authentication — nothing here does yet — so once a key is set, an
anonymous POST of a registerable capture costs you a scan's worth of metered
vision calls (one composite request on Groq; one request per field on Claude),
and the sample form that registers is served by the deployment itself. Three
honest mitigations, in order of honesty: don't put a key on a public
deployment; set a spend cap in the provider's console; and the built-in bound —
at most `FORMLINK_TEXT_MAX_SCANS_PER_MINUTE` scans reach the model per minute
(default 10, `0` disables), which is per serverless instance and is therefore a
brake, not a lock. `lib/reader/throttle.ts` says exactly what it is and is not.
The real fix is the authentication the roadmap already owes.

The bundled samples are legible on purpose. Their handwriting is a jittered
single-stroke print font (`tests/helpers/stroke-font.ts`) writing known values
— ANITA SHARMA, B+, 98765 43210 — that the generator returns as ground truth,
so a scan with a key can be checked against a right answer. (An earlier version
shipped statistical scrawl with no letters in it, which made every honest
reader look broken: a demo that manufactures its own illegibility cannot
demonstrate reading.) Real handwriting is still messier — photograph a real
filled-in form before believing any accuracy impression the samples give.

## Everything is measured against this scan

**Almost no absolute threshold exists in the detection path.** Every geometric
one is in millimetres, and every response one is a ratio against a statistic
measured on blank paper in the same image
([`lib/ink/paper-stats.ts`](lib/ink/paper-stats.ts)).

Two deliberate exceptions, named rather than glossed over: the binarisation mean
offset (`ink.adaptiveMeanOffset`, a raw grey level, which runs inside
`prepareChannels` for every detector), and the structural line and rule counts in
[`form-presence.ts`](lib/regions/form-presence.ts) — those are counts rather
than fractions on purpose, because "are there at least three lines of type on
this page?" is the same claim on every capture of every form.

"An edge is a step of at least 20 grey levels" is generous on a clean scan and
impossible on a photocopy whose whole dynamic range is 40 levels. Both are
really asking *is this bigger than the noise?*, and the only way to answer is to
measure the noise in the image in front of you. That is what lets one set of
constants work on a 170 dpi WhatsApp recompression and a 600 dpi flatbed scan.

---

## Testing without real forms

Real filled-in patient forms are personal medical data. They cannot go in a
repository, and a test suite that needs them is a test suite nobody runs.

So fixtures are generated: a printed skeleton, legible handwriting (known
values, returned as ground truth) that crosses its
rules, a pasted photograph, a signature with a flourish that overruns its box, a
thumb impression with realistic ridge spacing — plus perspective, skew, shadow,
glare, photocopy speckle and sensor noise. Everything is seeded, so a failure
reproduces. The generator returns **ground-truth boxes**, so detectors are
scored by IoU rather than by eye.

This is not a claim that synthetic forms are as good as real ones. They are not.
What they give is a fast regression net, which concentrates the remaining risk
into a small set of real fixtures a human has to supply.

Six real bugs were caught this way, every one of them silent-wrong rather than
crashing. The most instructive:

- **A NaN skipped a safety gate.** Fractional rectangles indexed the summed-area
  table with non-integer indices, reading `undefined` → NaN. `NaN < threshold`
  is *false*, so a NaN feature does not fail a gate — it skips it. An empty
  photo box became a stored crop. Coordinates now round, and every gate is
  written as a negated `>=` so NaN rejects.
- **Complete-link clustering cannot assemble an elongated object.** It is the
  textbook defence against chaining, and it refused to join two halves of the
  same signature whose nearest edges were one pixel apart, because its left-hand
  loops sat 168 px from its flourish tip.
- **A median window makes a step response plateau,** and with asymmetric windows
  that plateau is not centred on the edge — a millimetre of extra paper per side.
- **The fixture itself was wrong once,** drawing flourish tails as dashed lines
  that any speckle filter correctly discards. It presented as a detector losing
  6 mm of every signature.

---

## Layout

```
lib/client/      capture preparation in the browser (resize, HEIC via the
                 platform decoder) — Vercel rejects a body over 4.5 MB at the edge
lib/vision/      pure-TS image primitives, browser+server isomorphic
                 types gray integral threshold morphology components
                 geometry lines colour cluster thinning features
                 page (page-quad detection + the edge-support gate)
                 image-header (format sniffing before sharp sees the bytes)
                 warp-rgb (bicubic projective — sharp cannot do this)
                 io (sharp bridge; applies EXIF orientation)
lib/geometry/    Canonical Template Space — everything persisted is in mm
lib/ink/         paper statistics, photometric normalisation, caption removal
lib/reader/      the handwritten-text reader: one field, one request, one crop
                 (or one composite request per scan, for token-capped tiers)
                 prompt · parse (reply trust boundary) · crop · composite
                 provider · groq · anthropic · throttle — enabled by an API
                 key, absent without one
lib/regions/     photo · signature · thumb · postprocess · params
                 form-presence   (is this a printed form at all?)
                 template-anchors (is it THIS form? absence needs an answer)
lib/templates/   form definition; the hospital form is its first tenant
                 custom + drawn — a form TAUGHT by drawing boxes on it
lib/db/          persistence, optional: client (server-only) · forms · records
                 the Save, the archive, and the signed reads
lib/pipeline/    bytes -> crops, driven by a template
app/             the application: home · forms + builder · f/[slug] (a form's
                 link) · records + r/[reference] (Doctor view, Patient receipt)
                 api/extract · api/forms · api/records
tests/           236 tests + the synthetic form generator
scripts/         demo-extract, preview-fixture, make-samples
docs/            product spec, architecture build spec
```

No OpenCV. Every primitive needed here is small enough to write, test exactly
and tune for documents; the wasm builds are ~13 MB and bring an initialisation
cost on every cold serverless start. `sharp` handles decode and resampling only.

## License

Private. © Rionick Studios.
