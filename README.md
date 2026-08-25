# FormLink

Turn handwritten paper forms into verified digital records — and keep the
original form archived.

An organization builds its paper form once in a no-code builder (sections,
fields, field types) and publishes it to a link. Staff open the link, photograph
a filled-in form, and the AI populates the digital fields, **crops the pasted
passport photograph, the signature and the thumb impression as separate
images**, and shows everything for human verification before anything is saved.

Spec: [`Doc/Form Data Extract Text and Image.pdf`](Doc/) ·
transcribed in [docs/01-product-spec.md](docs/01-product-spec.md).

---

## Status

**The region-extraction engine and the verification screen are built, measured
and running.** That is the hard part and the differentiator — and it runs with
**zero model calls**.

Not yet built: the no-code form builder, template registration against a stored
layout, text extraction, persistence, and the confidence calibrator. The full
plan is in [docs/02-architecture.md](docs/02-architecture.md), which is a build
spec rather than a sketch.

```bash
npm install
npm run dev            # http://localhost:3000 — upload a form, see the crops
npm test               # 149 tests
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

Against the synthetic corpus, which carries exact ground truth. These are
measurements from `scripts/demo-extract.ts`, not estimates.

**Passport photograph** — IoU of the detected quadrilateral against the true
physical boundary of the pasted photo:

| Condition | IoU | Max edge error |
|---|---|---|
| Clean scan | 0.992 | 0.17 mm |
| Registration prior 2.5 mm out | 0.991 | 0.21 mm |
| Photocopy, greyscale photo | 0.984 | 0.38 mm |
| Shadow gradient + noise | 0.983 | 0.33 mm |
| Specular glare | 0.986 | 0.26 mm |
| Page skewed 4.5° | 0.991 | 0.20 mm |
| Photo pasted 6° crooked | rotation recovered as 5.60° | |

**Signature** — containment of the true ink, and crop area as a multiple of the
signature's own extent (a crop that swallows the printed label fails even with a
respectable IoU):

| Condition | Contains | Area |
|---|---|---|
| Clean | 0.986 | 0.99× |
| Photocopy | 1.000 | 1.00× |
| Shadow | 0.986 | 0.99× |
| Glare | 0.986 | 0.99× |

**Thumb impression** — containment 0.917–0.925 across clean, shadow and
photocopy. Confidence is **hard-capped at 0.70 and review is always required**,
because without ridge verification this detector cannot support a stronger
claim. That is enforced in the detector, not left to the caller.

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

There is **no absolute threshold anywhere** in the detection path. Every one is
in millimetres, or a ratio against a statistic measured on blank paper in the
same image ([`lib/ink/paper-stats.ts`](lib/ink/paper-stats.ts)).

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
                 warp-rgb (bicubic projective — sharp cannot do this)
                 io (sharp bridge; applies EXIF orientation)
lib/geometry/    Canonical Template Space — everything persisted is in mm
lib/ink/         paper statistics, photometric normalisation, caption removal
lib/regions/     photo · signature · thumb · postprocess · params
                 form-presence (is this a printed form at all?)
lib/templates/   form definition; the hospital form is its first tenant
lib/pipeline/    bytes -> crops, driven by a template
app/             verification screen + /api/extract
tests/           149 tests + the synthetic form generator
scripts/         demo-extract, preview-fixture
docs/            product spec, architecture build spec
```

No OpenCV. Every primitive needed here is small enough to write, test exactly
and tune for documents; the wasm builds are ~13 MB and bring an initialisation
cost on every cold serverless start. `sharp` handles decode and resampling only.

## License

Private. © Rionick Studios.
