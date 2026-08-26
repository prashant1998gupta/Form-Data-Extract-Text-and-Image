# FormLink

Turn handwritten paper forms into verified digital records.

**What this is today.** Photograph a filled-in form and it **crops the pasted
passport photograph, the signature and the thumb impression as separate
images**, then shows them for human verification. It works on any form: draw a
box around each element once, and that form is read from then on.

**There is no AI in it.** Not a placeholder — a deliberate design. Nothing here
calls a model of any kind. `sharp` decodes and resizes; everything else is
pure-TypeScript computer vision written for this problem (thresholding,
morphology, connected components, convex hull, RANSAC line fitting,
homographies). When it reports 97 % on a photograph it has measured a step in
lightness, chroma and texture across a physical boundary — it is not recognising
anything, and it cannot read.

**What the intended product adds, and this does not have yet.** The vision
(below, and in the spec) is a no-code builder where an organization recreates
its paper form as sections and typed fields, publishes it to a link, and has
handwritten *text* read into those fields as well. None of that is built: there
is no builder, no published links, no text extraction, no database, and nothing
is stored anywhere. Read [Status](#status) before quoting any of it to anyone.

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

**Not built.** Text extraction — no field on the form is *read*, only the three
image regions are cropped. Persistence: nothing is saved anywhere, so the
"original form archived" half of the product does not exist yet, and the client
re-encodes the capture before upload, so even the bytes that reach the server are
not the original ones. The no-code builder with sections and 17 typed field
types (the taught-form editor covers only the three image regions). Published
form links. Doctor and Patient views. The confidence calibrator. Template
registration against a *stored blank* — [`template-anchors.ts`](lib/regions/template-anchors.ts)
checks only that a template's own declared landmarks are where it says, which is
a far weaker claim than the anchor-atlas registration the architecture describes.

The full plan is in [docs/02-architecture.md](docs/02-architecture.md), which is
a build spec rather than a sketch. It describes the finished system; most of it
is still ahead.

```bash
npm install
npm run dev            # http://localhost:3000 — upload a form, see the crops
npm test               # 178 tests
npm run build

node --experimental-strip-types scripts/demo-extract.ts    # crops to disk, scored
node --experimental-strip-types scripts/preview-fixture.ts # generate fixtures
```

Node >= 22.13. **No API key is needed for any of this** — nothing here calls a
model. Three sample forms are bundled, including an unfilled one: anyone can
demo a detector on a form with everything pasted on it, and the question a
hospital actually asks is what happens when the patient brought no photograph.

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
  search regions and classifications. Geometry comes from registration and
  deterministic image processing.
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

So fixtures are generated: a printed skeleton, handwriting that crosses its
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
lib/regions/     photo · signature · thumb · postprocess · params
                 form-presence   (is this a printed form at all?)
                 template-anchors (is it THIS form? absence needs an answer)
lib/templates/   form definition; the hospital form is its first tenant
                 custom + drawn — a form TAUGHT by drawing boxes on it
lib/pipeline/    bytes -> crops, driven by a template
app/             verification screen + /api/extract
tests/           178 tests + the synthetic form generator
scripts/         demo-extract, preview-fixture
docs/            product spec, architecture build spec
```

No OpenCV. Every primitive needed here is small enough to write, test exactly
and tune for documents; the wasm builds are ~13 MB and bring an initialisation
cost on every cold serverless start. `sharp` handles decode and resampling only.

## License

Private. © Rionick Studios.
