# FormLink — Final Architecture

**Universal Form Digitization Platform**
Next.js 16 (App Router) · TypeScript · Supabase · Vercel `bom1` · Node 24
Status: **build spec**. This document supersedes the three candidate designs and the judge reviews. Where a judge raised a fatal flaw, §13 names it and states the resolution or accepts the risk explicitly.

Existing assets this builds on: `lib/vision/` (now **16 files, ~4,986 lines** of tested pure-TS CV — the original nine plus `colour.ts`, `features.ts`, `lines.ts`, `cluster.ts`, `thinning.ts`, `page.ts`, `warp-rgb.ts`) and `docs/01-product-spec.md`.

**This document is the ONLY design document that exists.** It was written as the source for `docs/03-data-model.md` through `docs/08-testing.md`; none of those were ever written, and `docs/01-product-spec.md` §6 now says so plainly rather than linking to six files that are not there. Do not regenerate those links from this line — write the file first, or leave the content here.

> ### How to read this document
>
> **The prose is the PLAN. The `> **Status.**` line under a heading is the REPOSITORY.**
> Where the two disagree, the status line is what is true today.
>
> - **BUILT** — implemented and tested.
> - **SUBSTITUTED** — something cheaper is shipped that gates the same decision. Named so it reads as a decision rather than a gap, and so nobody rebuilds it by accident.
> - **NOT BUILT** — as described, and not started.

---

## 1. Executive summary — the spine, in five sentences

**Geometry is never a model output.** Every pixel coordinate that reaches a user comes from a per-template geometric model expressed in millimetres (the Canonical Template Space), re-fitted to each scan by classical registration with OpenCV.js, and gated by a multi-signal trust check that includes a *semantic constellation test* — so a confidently-wrong homography, the one way this architecture could fabricate, has to defeat geometry, structure, and printed-label semantics simultaneously.

**The pasted photograph is found by its physical boundary, not by its appearance.** Per-edge RANSAC line fitting over rank-based step responses in three independent channels (luminance, chroma, paper-texture high-frequency energy) recovers an exact quadrilateral to ~0.2 mm, which is the only mechanism in any candidate design that survives a white photo on white paper, a staple, a glare band, or a crooked paste — appearance features are used to *accept or reject* that quadrilateral, never to segment it.

**The signature is found in the ink that the printed template cannot explain**, using component-wise (not pixel-wise) template subtraction so strokes written *along* the printed rule survive, cross-checked against AWS Textract's purpose-built `SIGNATURES` detector, which is script-agnostic, returns a genuinely calibrated confidence, and costs $3.50 per 1,000 pages.

**"Not Detected" is an asserted conclusion with three distinguishable causes** — *box located and verifiably empty*, *candidates found but below threshold*, *geometry could not be trusted* — each with its own UI treatment, its own telemetry, and a self-referential emptiness test measured against the scan's own paper statistics rather than against a clean template that a phone photo can never match.

**Every displayed confidence is a measured or externally-calibrated quantity passed through an isotonic calibrator fitted on a mandatory 3% blind audit sample**, never on "did the clerk edit it" (which measures diligence, not correctness) and never on a VLM's self-report (no provider exposes input-token logprobs; self-reported confidence is generated text) — and until a field kind has enough audited samples for the calibration to be measurable, the UI shows High/Medium/Low buckets instead of a number it cannot justify.

---

## 2. End-to-end pipeline

### 2.0 Coordinate frames — the contract everything obeys

Four frames. Confusing them is the single most common source of silent misalignment, so they are named types in `lib/geometry/frames.ts` and never interchangeable.

| Frame | Definition | Units | Used for |
|---|---|---|---|
| `ORIG` | Original captured pixels after EXIF `autoOrient()`. Never resampled, never re-encoded. | px | Archival, final crop sampling |
| `CTS` | Canonical Template Space. The page in **millimetres**, rasterised at **200 dpi** (7.8740 px/mm). A4 → 1654×2339. | mm (stored) / px (raster) | All analysis, all stored geometry |
| `DETAIL` | A CTS-aligned band or ROI resampled from `ORIG` at **300 dpi** (11.811 px/mm) in one pass. | px | Edge refinement, field crops for reading |
| `OUT` | Delivered crop rasters. Photo = 413×531 (35×45 mm @ 300 dpi). Signature/thumb at native, ≤600 px long edge. | px | Storage, UI, print |

**Rules.**
- Every persisted rectangle, quad, anchor and correction is stored in **millimetres** in CTS. Never pixels.
- There is exactly **one** resample between `ORIG` and any delivered crop. Deskew, perspective correction and scaling are composed into a single 3×3 homography and applied once with bicubic sampling. Two interpolations is a bug.
- `H` denotes `ORIG → CTS`. `H⁻¹` maps a CTS mm rectangle back into original pixels.
- All thresholds in this document are expressed either in **millimetres / mm²** or as a **ratio against a statistic measured in the same scan**. Raw pixel constants are forbidden outside the CTS rasteriser. This is what makes the system work at 170 dpi and at 600 dpi with the same constants.

---

### Stage 0 — Client capture and quality assessment (browser)

> **Status.** SUBSTITUTED: [`lib/client/prepare-upload.ts`](../lib/client/prepare-upload.ts) resizes the capture to 3500 px and transcodes HEIC via the browser's own decoder — it exists because the 4.5 MB edge limit made it urgent, not because Stage 0 was built. NOT BUILT: every quality metric (`effectiveDpi`, sharpness ratio, `glareFrac`, `quadConfidence`), the advisory/blocking policy, `capture_tier`, the Web Worker preview loop, and client rectification. Nothing measures capture quality today.

**What.** Live camera capture or gallery upload. Compute a quality report. Advise, and only hard-block at the floor where nothing can work.

**Why.** Free compute; the fastest possible feedback loop is while the operator is still standing at the paper. But the judges were right that a hard gate is a product-killer: staff open links inside WhatsApp WebViews, on locked-down hospital tablets with camera permission denied, and they forward WhatsApp-recompressed 1 MP images. **The gallery/upload path is a first-class citizen, not a fallback.**

**How.**
- `getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 } } })`; attempt `ImageCapture.takePhoto()` for a full-resolution still and silently fall back to a `grabFrame()` if the OEM implementation misbehaves (common on mid-range Android).
- Preview loop at ~6 fps in a Web Worker (`comlink`) on a 640 px proxy.
- **Quality metrics, all self-normalised:**
  - `effectiveDpi` = quad long edge in px ÷ page long edge in mm × 25.4, estimated on the full-res frame. Tiers: `good ≥ 260`, `usable 180–260`, `degraded 110–180`, `blocked < 110`.
  - `sharpness` = variance of the 3×3 Laplacian **divided by the same statistic measured on the printed-text band of the template's own reference render** when a template exists, or divided by the frame's own global contrast when it does not. A raw Laplacian-variance threshold is content-dependent and will be miscalibrated per template (judge, D2#16); the ratio is not.
  - `glareFrac` = fraction of in-page pixels with `V > 250` **and** local 15×15 σ < 4. Warn > 0.5 %. Hard-warn if a specular blob's centroid falls inside a known image-field ROI.
  - `quadConfidence`, `coverage`, `cornerAngles`.
- **Blocking policy.** Only `effectiveDpi < 110` or `sharpness ratio < 0.25` blocks. Everything else warns with a specific instruction ("move closer", "move away from the light", "hold steady") and offers **Upload anyway**. Uploading anyway sets `capture_tier` on the scan, which propagates into every confidence as a multiplicative penalty and forces review on image fields. Refusing input is worse than accepting it with a stated ceiling.
- **Optional client rectification** (`image-js`, pure TS, no wasm, no COOP/COEP requirement): `getPerspectiveWarp(corners, {width,height})` + `transform(matrix, { interpolationType: 'bilinear' })`. Measured at ~70 ms on 2000×1500. Used for the *preview* and to produce a smaller working image. **The rectified image is a hint. The server always re-derives geometry from `ORIG`.** (Judge D3#10: there must be no path where a browser capability gap silently breaks every downstream threshold.)
- **API gotcha, wrapped at the module boundary:** `image-js` uses `{ column, row }` Points, not `{ x, y }`. Passing `{x,y}` yields `NaN` dimensions and a `RangeError` thrown deep inside `Image.createFrom`. `lib/client/imagejs-adapter.ts` is the only file allowed to construct `image-js` points.
- HEIC from iOS transcoded client-side via `heic-to` to JPEG q92.

**Output.** `{ originalFile, quality: QualityReport, clientQuad?: Quad, exif }`.

---

### Stage 1 — Direct-to-Storage upload and job creation (browser → server)

> **Status.** NOT BUILT — no Supabase project, no signed upload, no `scans` row, no job runner. SUBSTITUTED: the browser downscales so the POST fits under the 4.5 MB cap. That workaround has a real cost recorded in [01-product-spec.md](01-product-spec.md) §5 — the capture is RE-ENCODED, so the Must item "the original image is stored permanently and unmodified" is currently moving away from satisfaction, and this stage is how it gets undone.

**What.** Browser requests a signed upload URL, PUTs the original directly to Supabase Storage, then POSTs a small JSON job.

**Why.** Vercel caps request **and response** bodies at 4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`). A 12 MP JPEG is 4–12 MB. Routing the image through the function burns duration and memory for nothing. The original must be archived permanently and unmodified anyway — it is an explicit product requirement (spec §2.1, §5).

**How.**
- Server action authenticates, checks org membership and form publication state, and returns `supabase.storage.from('originals').createSignedUploadUrl(path)`.
- Path: `originals/{org_id}/{form_id}/{scan_id}/original.{ext}`.
- Browser PUTs. Then `POST /api/scans` with `{ scanId, formVersionId, storagePath, quality, clientQuad, exif }`.
- Insert `scans` row with `status='queued'`; return immediately. Client subscribes to that row via Supabase Realtime.
- **Job runner (named, because two of three designs left this blank).** The route handler calls the pipeline via `waitUntil()` on Vercel Fluid compute, and a `pg_cron` sweeper every 60 s re-dispatches any `scans` row stuck in `queued`/`running` past its lease (`lease_expires_at`, renewed every 20 s by the worker). Reliability backstop, no extra vendor. `vercel.json`:
  ```json
  {
    "regions": ["bom1"],
    "functions": {
      "app/api/scans/process/route.ts": { "maxDuration": 300, "memory": 4096, "runtime": "nodejs24.x" }
    }
  }
  ```
  Fluid compute + Active CPU is required. Vercel Pro is required (2 vCPU / 4 GB, `bom1`, multi-region).

---

### Stage 2 — Server ingest, single decode, working pyramid

**What.** Fetch `ORIG` once, decode it **once**, hold the raw RGB buffer for the whole job, build a 3-level analysis pyramid.

**Why.** Judge D2#9 correctly identified that "extract only the ROI with sharp" still fully decodes the JPEG every call — 25 fields = 25 full decodes = 4–7 s of pure waste. A 12 MP RGB raw buffer is 36 MB. At 4 GB that is free.

**How.**
```ts
const { data, info } = await sharp(buf, { failOn: 'none', limitInputPixels: 60_000_000 })
  .rotate()                 // EXIF autoOrient
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const orig: Rgb = rgbFrom(new Uint8ClampedArray(data), info.width, info.height, 3);
```
- `orig` lives in the job context; every crop samples from it.
- Pyramid for detection: `P0` = `orig` downscaled so long edge ≤ 2400 (`WORKING_EDGE` in `lib/vision/io.ts`), `P1` = ½, `P2` = ¼.
- **Memory budget, stated:** `orig` 36 MB + `P0` 17 MB + CTS grey 3.9 MB + two Float64 integral images at CTS (62 MB) + OpenCV Mats (peak ~150 MB) ≈ **300 MB peak**. Comfortably inside 4 GB. Integral images at CTS resolution are affordable; the "never compute full-res integrals" rule from Design 1 was over-cautious and self-contradictory.
- Two-page detection (a stage two designs listed as required and never implemented): if the detected page aspect is within 12 % of 2× or 0.5× the template aspect, project the ink mask onto the long axis; a gutter ≥ 15 mm wide with ink density < 5 % of the page mean splits it. Each half registers independently against the corresponding template page. If the split is ambiguous, **stop and ask the operator** — never a silent partial extraction.

---

### Stage 3 — Page localisation (four hypotheses, no rotation of rasters)

> **Status.** BUILT, with one addition this document did not specify: `edgeSupport()` in [`lib/vision/page.ts`](../lib/vision/page.ts) requires a darker background behind at least 3 of 4 quad edges before `perspective` is returned, and scales the reported confidence by the fraction supported. It exists because a full-bleed dark band across a sheet — a heavy header rule, a fold, a lid shadow — severs the bright mask, the larger fragment wins, and the old shape-only check returned maximum confidence on a quad covering 85 % of the page. Measured: a 5 mm band is enough; 3 mm is absorbed.

**What.** Produce `H₀`, a coarse `ORIG → CTS` homography, or declare that the page boundary is unusable and hand off to content registration.

**Why.** A good `H₀` turns registration into a small-displacement problem, which is where template matching is reliable.

**How.**
1. **Quad detection.** `P2` → grey → Gaussian σ=1.5 → Scharr → hysteresis (hi = 80th pct of non-zero |G|, lo = 0.4·hi) → `cv.HoughLinesP` → cluster θ mod 180 into two near-orthogonal families → enumerate quads → score:
   `0.30·edgeSupport + 0.25·borderContrast + 0.20·aspectFit + 0.15·areaFrac + 0.10·convexity`.
   Fallback: `cv.findContours` + `approxPolygon` (already in `lib/vision/geometry.ts`) with `eps = 0.02·perimeter`, convex 4-gons only.
2. **Rotation disambiguation — done correctly.** Judge D2#1 is right that rotating an already-warped raster cannot undo an anisotropic squash. So: take the detected quad and generate its **four cyclic corner orderings**, compute `H₀` for each via `estimateHomography` (exact 4-point DLT, already implemented), and evaluate each with a cheap level-2 anchor match (≤16 anchors, `cv.matchTemplate` TM_CCOEFF_NORMED, ±16 px search). Winner must beat runner-up by 1.6× on accepted-match count. Ties → carry the top two into Stage 4 and let the trust gate decide.
3. **No usable quad.** Partially-cropped pages (the modal phone capture of a *filled* form — operators move close so the handwriting is legible), white form on white desk, flatbed scans with zero margin. These do **not** go to a broken bootstrap. They go straight to **content registration** (Stage 4 path B) with `H₀ = identity + scale estimate from the template's own dimensions`. Content registration does not need the page border.

**Output.** `H₀`, `quadSource ∈ {client, server, none}`, `rotationHypotheses[]`.

---

### Stage 4 — Fine registration (OpenCV.js)

**What.** Refine to a homography that maps `ORIG → CTS` with p50 residual ≤ 0.25 mm, plus a non-planar upgrade when the residuals are structured.

**Why.** This is the load-bearing stage. Every ROI, the differential ink map, the emptiness assertion and the template prior inherit its error.

**How — engine choice, stated honestly.** The brief asked for an honest evaluation of OpenCV-in-JS versus hand-written TypeScript. The research settles it: **`@techstark/opencv-js@5.0.0-release.1`** is a single self-contained `dist/opencv.js` of 13.3 MB with the wasm base64-embedded (no separate `.wasm` for Next's tracer to miss), measured at **153 ms cold init**, 152 MB peak RSS, `warpPerspective` on 2000×1500 in 56 ms, `matchTemplate`/`findHomography`/`ORB`/`HoughLinesP`/`connectedComponentsWithStats`/`CLAHE`/`distanceTransform`/`inpaint` all present. On a 1-vCPU Fluid instance budget ~300 ms init amortised across warm invocations and ~400 ms for a full pass. That is 4 % of the 250 MB bundle for the elimination of roughly 30 numerically delicate hand-written components. All three judges independently flagged the hand-rolled CV stack as the top implementability risk (2–4 engineer-months before the first end-to-end number). **We adopt OpenCV.js for the registration and heavy-geometry stack and keep the existing tested pure-TS primitives for the cheap, hot, small-ROI work already written.**

Critical integration facts:
```ts
// 5.x is a THENABLE. Every 4.x onRuntimeInitialized tutorial is wrong.
// Immediately after require(), cv.Mat is undefined and Object.keys(cv) is [].
let cvPromise: Promise<any> | null = null;
export function getCv() { return (cvPromise ??= require('@techstark/opencv-js')); }
```
- **No `imgcodecs`.** `imread`/`imshow` need a DOM canvas. Bridge is: sharp → raw RGBA → `cv.matFromImageData({ data, width, height })`; and back via `mat.data` → `sharp(buf, { raw: { width, height, channels } })`.
- `next.config.ts`: add `@techstark/opencv-js` to `serverExternalPackages`; add `outputFileTracingIncludes` for `node_modules/@techstark/opencv-js/dist/**`. Never import it into the client graph. (`vercel.json` `includeFiles` does **not** work in Next.js — use `outputFileTracingIncludes`.)
- Boot-time **capability probe** logs which optional symbols exist. **Do not depend on `findTransformECC`** — the research inventory did not confirm it in this build. `SIFT`, `AKAZE`, `BRISK`, `FlannBasedMatcher`, `goodFeaturesToTrack`, `phaseCorrelate` are **absent**; plan on ORB + brute-force Hamming and `GFTTDetector`.

**Path A — anchor template matching (primary, when `H₀` exists).**
- Template ships an **anchor pack**: 48–80 patches of 64×64 CTS px mined at publish time from the canonical blank.
  - Selection: Shi-Tomasi `λ_min` above the 90th percentile, **plus isotropy `min(Sxx,Syy)/max(Sxx,Syy) ≥ 0.15`** to reject patches sitting on a pure horizontal rule (they slide freely along themselves — the aperture problem — and inject systematic bias). This one rule prevents a whole class of failure on ruled Indian forms.
  - Spatial spread: 8×10 grid, top-1 per cell.
  - Packed into one greyscale PNG atlas (10×8 tiles of 64×64 = 640×512, ~40 KB) in Storage + JSON metadata. Cached in Node module scope, LRU 5, keyed by `template_version_id`; warm invocations pay nothing.
- Matching: coarse-to-fine over the pyramid with `cv.matchTemplate(TM_CCOEFF_NORMED)` — level 2 search **±16 px** (≈ 8 mm, comfortably above the stated `H₀` error; judge D2#17 caught the original ±12 being exactly at the error bound), level 1 ±5, level 0 ±2. Parabolic sub-pixel on the 3 scores around the peak.
- Accept a match on `peak ≥ 0.55` **and** `peakRatio = peak / bestOutsideRadius4 ≥ 1.15`.
- `cv.findHomography(src, dst, cv.RANSAC, 3.0 /* CTS px = 0.38 mm */, mask, 2000, 0.995)` → refit on inliers with normalised DLT.

**Path B — content registration (when no quad, or Path A yields < 8 matches).**
- `cv.ORB` with **`nlevels = 8`, `scaleFactor = 1.2`** (judge D2#2: a single-scale ORB cannot recover an unknown scale, which is precisely the job the bootstrap exists for), `nfeatures = 1500`, mask restricted to printed-ink regions of the template.
- `cv.BFMatcher(cv.NORM_HAMMING, crossCheck=false)` + Lowe ratio 0.80 + explicit cross-check → `findHomography(RANSAC, 6.0)`.
- Result replaces `H₀`; re-enter Path A.

**Non-planar upgrade (creased / curled paper).**
- Test residual spatial autocorrelation with **Moran's I** over inlier residual vectors, inverse-distance weights, 199-permutation significance. `I > 0.30, p < 0.05` ⇒ the residuals are structured, not noise.
- Then fit a 4×5 grid of locally-weighted homographies (Moving-DLT / APAP), `w_i = max(0.01, exp(-‖c_cell − x_i‖² / σ²))`, `σ = 0.15 · pageWidth`. Sample any point by bilinear blend of the four surrounding cell warps.
- Persist `warp_model ∈ {homography, apap}` and the cell matrices. APAP typically cuts p95 residual from ~8 px to ~2.5 px on creased captures.

---

### Stage 5 — Registration trust gate (four independent check families)

> **Status.** SUBSTITUTED, partially. Two cheaper gates ship and answer the same question — may template coordinates be trusted on this page? [`form-presence.ts`](../lib/regions/form-presence.ts) asks whether the capture is a printed form at all; [`template-anchors.ts`](../lib/regions/template-anchors.ts) asks whether the template's own declared `printedBorder`/`baselineMM` landmarks are where it says, which needs no stored reference render. NOT BUILT: the reprojection-residual family, the constellation check, the periodicity ambiguity test, and APAP. Neither shipped gate can CORRECT a misalignment — only notice one.

**What.** Produce `STRICT | LOOSE | AMBIGUOUS | UNREGISTERED`. Nothing is cropped from template geometry until this passes.

**Why.** This is the mechanism that makes "never fabricate" true rather than aspirational. Judge D1#1 identified the one attack that beats every purely geometric gate: on a repetitive ruled form, a homography shifted by exactly one row pitch is *self-consistent* — convex, unit scale, tiny perspective terms, low RMSE on its own inliers — and produces a record where every value is individually plausible and collectively wrong. That is worse than fabrication. **Two new check families exist specifically to kill it.**

**Family 1 — Geometric.** `inlierRatio`, `nInliers`, `rmse`, `p95residual`, `anchorCellCoverage` (fraction of the 8×10 grid contributing ≥ 1 inlier), `hullArea/pageArea`, covariance condition number. Decomposition of the 2×2 linear part: singular values ∈ [0.85, 1.18]; shear ≤ 0.12; rotation ≤ 8°; |h31|,|h32| ≤ 3e-4 per px; det > 0.

**Family 2 — Structural.** Chamfer overlap: fraction of template ink edge pixels with a scan ink pixel within 3 CTS px, via two-pass Felzenszwalb distance transform, computed **only over printed-only regions** (excluding every answer ROI and image ROI, where handwriting legitimately differs). `chamfer ≥ 0.45` for STRICT.

**Family 3 — Semantic constellation (new).** The template stores K = 8–14 distinctive printed label strings with their CTS mm positions (`template_anchors.kind='label'`). Azure `prebuilt-read` (Stage 6) runs on the registered scan; require **≥ 70 % of constellation labels found within 3 mm of expected position** with OCR confidence ≥ 0.70, matched by normalised Levenshtein ≥ 0.8. A row-shifted homography fails this immediately and unmistakably, because "Patient Name" is no longer where "Patient Name" should be.

**Family 4 — Periodicity ambiguity test (new).** At template build time, compute the vertical autocorrelation of the printed row-ink profile. If a strong peak exists at period `p` (a repetitive ruled/table layout), then at scan time re-evaluate `chamfer` for `H` translated by `±p` and `±2p`. If any shifted chamfer is within **8 %** of the best, emit **`AMBIGUOUS`**: the UI asks the operator to click one named landmark on the scan ("tap the box labelled *Blood Group*"), which pins the offset in one interaction. This is the honest answer to an ambiguity the pixels genuinely do not resolve.

**Gate.**

| State | Requirement | Consequence |
|---|---|---|
| `STRICT` | All four families pass: inlierRatio ≥ 0.60, nInliers ≥ 12, rmse ≤ 2.5 px, p95 ≤ 6 px, coverage ≥ 0.45, hull ≥ 0.25, cond ≤ 8, chamfer ≥ 0.45, constellation ≥ 0.70, no periodicity ambiguity | Full pipeline. Geometry learning enabled. |
| `LOOSE` | inlierRatio ≥ 0.45, nInliers ≥ 8, rmse ≤ 6 px, chamfer ≥ 0.30, constellation ≥ 0.55 | Search pads ×1.5. Intra-ROI refinement mandatory. All image fields forced to review. Confidence penalty. **Geometry learning disabled** (judge D2#20: a biased `H` under LOOSE launders a systematic offset into "learned" geometry). |
| `AMBIGUOUS` | Periodicity test failed, or two rotation hypotheses tied | One-tap operator disambiguation, then re-gate. |
| `UNREGISTERED` | Anything else | Cold-start path (Stage 12). Low chamfer specifically surfaces **"This does not look like the expected form"** — which correctly catches scanning the wrong form. |

---

### Stage 6 — Document AI: word geometry, per-word confidence, signature detection

**What.** Two external calls, run in parallel with local CV, on the CTS-rectified page.

**Why.** These provide the only **externally calibrated** confidence numbers in the system, and one purpose-built visual detector.

**How.**
- **Azure Document Intelligence `prebuilt-read`** (v4.0 GA, api-version 2024-11-30), region **Central India**. Returns per word: `content`, `polygon`, `confidence`, `span`; plus `styles[].isHandwritten` with its own confidence. That handwritten-style flag separates pre-printed labels from staff-filled values *for free*, which is exactly what the constellation check and the label-anchoring cold-start path need. $1.50/1k pages (East US verified; **India pricing must be re-verified before commit**). Input limits: 50×50 to 10,000×10,000 px, min text height 12 px at 1024×768.
  - **Hard limit, designed around:** Azure handwriting supports exactly 12 languages and **Hindi is not one of them**. Printed Devanagari labels are supported. So Azure reads printed Hindi labels (useful for constellation and anchoring) and Latin handwriting; handwritten Devanagari values route to Gemini and are always review-required.
  - Do **not** pass a language code unless certain — Azure's own docs warn the service returns incomplete/incorrect text if forced to the wrong model.
- **AWS Textract `AnalyzeDocument` with `FeatureTypes: ['SIGNATURES']`**, region `ap-south-1` (Mumbai). Returns `SIGNATURE` blocks with normalised `Geometry.BoundingBox`, `Polygon`, `RotationAngle` and `Confidence` (0–100). Detects handwritten signatures, e-signatures and initials. **$3.50 per 1,000 pages** — by far the cheapest `AnalyzeDocument` feature (Forms is $50/1k).
  - **The decisive property: signature detection is a visual detector, so it is script-agnostic.** It works on Hindi/English mixed Indian forms even though Textract's OCR is English-only. This is the single strongest cold-start asset in the whole architecture and directly answers "a VLM asked for coordinates and hoped": it is a real detector with a real confidence.
  - Textract blocks are mapped into CTS through `H` by `lib/models/textract-adapter.ts`. Normalised `Left/Top/Width/Height` × page dims → CTS.

Both calls are behind `lib/models/provider.ts` with timeout, jittered retry, and a circuit breaker. If either is down, the pipeline continues with local evidence only and every affected confidence takes a documented penalty; it does not fail the scan.

---

### Stage 7 — Photometric normalisation and the differential ink map

**What.** Produce four derived rasters in CTS, and one soft ink map.

**Why.** Every subsequent threshold is expressed relative to these. Two candidate designs contained a hard self-contradiction here (judge D1#6, D3#1): the same flat-field pass that removes shadows also removes object-scale contrast, and the photo detector then tests for exactly the contrast that was deleted. This stage resolves it by producing **separate images for structure and for tone**, and by constraining the flat-field kernel.

**How.**

1. **`FLAT` (structure image).** Illumination estimated as a heavily-blurred background and divided out. **Kernel radius rule: `r ≥ 1.5 × the longest dimension of any image field on this template`** (for a 45 mm photo at 200 dpi that is `r ≥ 531 px`, i.e. ~1/3 of the page, not 1/16). A kernel comparable to the object destroys it. Existing `flattenIllumination(image, grid, target)` in `lib/vision/threshold.ts` implements the grid-based version; the grid size is derived from the template's largest image field, not hardcoded.
2. **`TONE` (tone-preserving image).** White-balanced only: 95th percentile per channel computed over **non-ink pixels** (paper is the white reference), channels scaled to equalise. No flat-fielding. This is where hue entropy, tone spread and Otsu bimodality are measured. Fifteen lines, and it is what rescues blue ballpoint photographed under tungsten from being classified as black.
   - **`skinFrac` is deleted from the architecture.** The YCbCr band it used overlaps cream paper under tungsten (judge D1#15), and separately, prompting or feature-engineering around "is there a person" invites a policy refusal on a core product path. Replaced by `chromaClusterCount` and `toneSpread`.
3. **`HF` (paper-texture energy).** `|I − boxBlur(I, 3px)|`, then a 9×9 local mean. Paper fibre, print screen and photo emulsion have measurably different high-frequency energy. This is the channel that finds a white photo on white paper.
4. **`Δ` (photometrically-matched template difference).** Per 16×16 CTS tile, fit a robust linear gain/offset from template→scan using only pixels the template says are paper-or-printed (20 % trimmed least squares), then `Δ = |scan − predicted|`. Threshold at **4 × MAD(Δ) measured over paper-only regions of this same scan**. This is what "Dmap" should have been: self-normalised, so a cream photocopy under CFL and a white flatbed scan produce the same numbers.

5. **`INK` — component-wise differential ink (the highest-value derived artifact).**

   The naive form, `Fg = Sauvola(scan) AND NOT dilate(Sauvola(template), r)`, has two documented killers: multi-generation photocopies thicken printed strokes by 2–4 px so the dilation tolerance is exceeded and label halos flood the map (judge D1#2); and at a realistic `r` of ~1.3 mm it **erases handwriting written on the printed rule**, which is how people actually fill forms — signature spines run *along* the baseline (judge D2#4). Both are fatal to the two mechanisms that depend on `INK`.

   **The fix is to subtract components, not pixels.**
   ```
   a. Measure stroke growth. On matched printed regions OUTSIDE all answer ROIs,
      compute median stroke width via distance transform for template ink and for
      scan ink.  Δsw = max(0, sw_scan − sw_template).  This is the photocopy /
      toner-bloom compensator, measured per scan rather than assumed.
   b. r_adapt = 0.15 mm + rmse_mm + Δsw.   (Tied to measured error, not a constant.)
   c. Binarize scan: sauvola(FLAT, window = 6.5 mm, k = 0.25, R = 128).   [existing]
   d. Label scan-ink connected components.                                 [existing]
   e. For each CC:  cov = |CC ∩ dilate(templateInk, r_adapt)| / |CC|
        - cov ≥ 0.85  AND  strokeWidth(CC) within 40 % of local template stroke width
            → DROP the whole component (it is printed).
        - otherwise → KEEP the whole component, intact.
      A stroke that merely CROSSES a rule has cov well below 0.85 and survives whole.
   f. Long-rule handling: within ROIs, run extractRules(mask, minLength = 12 mm)
      [existing, lib/vision/morphology.ts] to isolate rule pixels, remove them, then
      morphological reconstruction from the surviving stroke fragments to reconnect
      across the removed band (≤ 3 px gap bridging, vertical-continuity seeded).
   g. INK_soft(x) = clamp((T_sauvola(x) − I(x)) / (0.6 · T_sauvola(x)), 0, 1)
      restricted to kept components — an anti-aliased alpha, not a 1-bit cutout.
   ```
   **Guards.** If `residualInkRatio = |INK| / |scanInk| > 0.75` on a print-heavy template, registration is silently wrong → demote to `LOOSE`. If `Δsw > 1.2 mm`, mark `photocopy_generation = high` and widen all ink tolerances.

   `INK` gives us four things nothing else can: printed-baseline-free signature detection, a **model-independent hallucination detector** (a non-empty value on a field with no handwriting ink), a **positive assertion of emptiness**, and ink-on-transparent output PNGs.

---

### Stage 8 — Region extraction (photo, signature, thumb) — **§3**

Detailed separately because it is the product.

---

### Stage 9 — Field crops and text reading — **§4**

> **Status.** SUBSTITUTED, partially — an interim single-pass reader ships as
> [`lib/reader/`](../lib/reader/) (README § Reading the handwritten text). What it does:
> one request per declared text field, from a crop cut deterministically at the field's
> template box on the rectified page — or, on token-per-minute-capped tiers where eight
> requests can never fit (Groq prices every image a flat ~2k tokens), ONE composite
> request per scan: every crop stacked into one image with strip numbers printed into
> the pixels, replies keyed by strip number so a skipped strip fails alone
> (`lib/reader/composite.ts`; `FORMLINK_TEXT_MODE` overrides the per-provider default).
> Providers Groq (default `qwen/qwen3.6-27b`) or Anthropic (`claude-opus-5`), chosen by
> `GROQ_API_KEY`/`ANTHROPIC_API_KEY` — with no key the reader is off and nothing calls a
> model. Taught templates may declare text fields too: the editor draws a labelled,
> typed box and `custom.ts` parses it at the same trust boundary as the image boxes.
> Every value is review-required with its evidence crop shown; blank (`""`) and
> unreadable (`null`) are distinct answers; no reading happens unless form presence AND
> template registration pass; replies are parsed as untrusted input; a 40 s scan budget,
> per-request timeouts and a per-instance scan throttle bound cost. The Groq default
> coexists with §4.3's verdict deliberately: for a zero-cost single-tenant demo its
> caveats are acceptable, composite mode is exactly the low-stakes fast path §4.3
> reserves for it, and the model is overridable (`FORMLINK_TEXT_MODEL`); the production
> stance below stands. NOT BUILT: everything else this section specifies — `lib/text/`,
> the three-reader fusion (Gemini primary, Claude decorrelated, Azure lexical), 2-of-3
> agreement, per-type validation and normalisation, the INK-based hallucination and
> blank gates, per-character doubt underlining, and every confidence number for text
> (the shipped reader displays none, by design).

---

### Stage 10 — Validation, normalisation, confidence fusion — **§5**

---

### Stage 11 — Verification screen and correction capture (browser)

**What.** Original on the left with registered overlays, editable digital form on the right, every interaction captured as labelled data.

**Why.** Human verification is a hard product requirement ("The system should not directly push AI-extracted information into the hospital database without human verification"), so the only question is how much learning value we extract from an action the user must perform anyway.

**How.**
- Left pane renders the **rectified** page (so overlays land exactly) with a toggle to the raw original. Each field's ROI outlined; each detected object's exact **quad** drawn (not its bounding box — a crooked photo's quad is the honest depiction).
- Clicking a field on the right pans/zooms the left pane via a CSS transform on the canvas; hovering either side highlights the other.
- **Red (`Review Required`) fields render EMPTY and focused**, with the zoomed crop inline. This forces a read rather than inviting a rubber-stamp on a pre-filled guess. Small decision, large real-world effect.
- **Safety-critical fields are always review-required** regardless of confidence, and always display their evidence crop: name, blood group, phone, doctor, drug/dose, allergy, ID numbers. Handwritten `B+` vs `B−` differs by one short stroke that a photocopy routinely loses; two model passes will *agree on the wrong one* because the model is consistently wrong, not randomly wrong. There is no confidence value at which this field auto-passes.
- **Text evidence boxes come from Azure word polygons inside the registered ROI — never from a VLM.** Asking a VLM for an `evidence_bbox` and drawing it as "proof" is the exact coordinate regression this architecture exists to avoid, and showing a hallucinated rectangle labelled as evidence destroys the verification premise (judge D3#20).
- Image fields expose a **rotatable, resizable crop handle**. The result is transformed through `H` into **CTS millimetres** and written to `corrections.after_quad_mm`. This is what makes a correction made on one skewed phone photo reusable on every future scan.
- `Not Detected` renders as literal text with **no percentage** and one of three reason strings. A staff-settable chip distinguishes *"the box was empty"* from *"the AI missed it"* — which is what separates a true negative from a false negative in the metrics, and is another free label stream.
- Per-character underlining on doubtful characters, from Levenshtein alignment across decorrelated reads. Staff re-check two digits of a phone number, not the whole value.
- Save is blocked while any red field is untouched. There is no auto-save path in this product. Ever.

---

### Stage 12 — Cold start (first scan of a brand-new form)

**What.** A complete parallel path requiring nothing from the admin but the field list.

**Why.** The architecture must not have a cliff, and must not require setup work before the customer sees value.

**How.**
1. Quad rectify + deskew (projection-profile variance maximisation over −5°..+5° in 0.25° steps — 40 lines, extremely robust).
2. **Azure `prebuilt-read`** → word polygons, confidences, `isHandwritten`. Fuzzy-match printed words against the admin's field labels (normalised Levenshtein ≥ 0.8 + synonym table incl. Hindi: `मोबाइल`/Mobile, `हस्ताक्षर`/Signature, `फोटो`/Photo, `अंगूठा`/Thumb). Answer ROI = span from the end of the matched label to the next label or the column edge, height = 1.6× label cap height, extended along any detected ruled line.
3. **Printed rectangle extraction:** `extractRules` on horizontal and vertical runs, union, connected components → candidate boxes. A rectangle with physical size 30–45 mm wide and aspect 0.70–0.85, or one whose nearby label matches `/photo|affix|photograph|paste|फोटो/i`, is the photograph box.
4. **AWS Textract `SIGNATURES`** → this is the cold-start signature localiser. It works with no template, no training and no prompt.
5. **Photograph, cold:** search region = union of (printed-rectangle candidates) ∪ (one Gemini detection call). The Gemini call is a **search region, never an answer** — the §3 boundary refiner produces the actual quad inside it. Strict thresholds; when in doubt, Not Detected.
6. Everything amber or red. The verification screen **requires** the operator to confirm or draw crops for photo/signature/thumb. That affordance is mandatory, not optional, because it is the seed data.
7. Immediately after scan #1, mine anchors from the rectified scan itself. By scan #3 the template is in LOOSE mode with real geometry; by ~scan #10–15 it reaches STRICT; at ≥ 9 STRICT scans the consensus blank is synthesised (§6) and the org silently graduates to full accuracy without anyone being asked to do anything.

**Honest statement of the cost of skipping the blank-template upload: roughly ten scans of elevated manual correction, not a permanently worse system.** And for a genuinely one-off form, this architecture offers nothing over a plain VLM pass — the whole bet is that organisations scan the same layout hundreds of times.

---

### Stage 13 — Template learning update — **§6**

---

## 3. The region-extraction engine

This is the product. The user's #1 priority is passport-photo and signature crop accuracy, and the hard product rule is that **a wrong crop is worse than no crop**.

### 3.0 Design principle

> **Boundary before appearance. Evidence from two independent families before emitting. Self-normalised thresholds only. Never a VLM coordinate on the warm path.**

Why boundary-first for the photograph: the modal Indian passport photo is a person on a **white or pale-blue studio backdrop**, printed on white photo paper, pasted onto white form paper. Every appearance-based score (chroma, local σ, darkness, tile fill) *collapses over the photo's own backdrop* — the correct segmentation of an appearance map is the head and shoulders, not the rectangle, and a head-and-shoulders blob then fails every aspect and rectangularity filter (judge D3#6). But a pasted photo **always** has a hard physical boundary: a step in luminance, or in chroma, or — when both tones match — in **high-frequency texture energy**, because photo emulsion and paper fibre never have the same grain. Plus a drop shadow along at least one edge in almost every real capture.

Because we know the ROI to within ~0.3 mm from registration, we do not need to *find* the rectangle. We need to *measure four lines*.

---

### 3.1 Photograph

**ROI.** `ROI_search = templatePhotoBox ⊕ max(8 mm, 0.30 × box dimension)` (photos overlap their printed border and are pasted crooked). Sampled from `ORIG` at `DETAIL` (300 dpi) through the composed warp — **one resample**.

**Expected geometry.** The admin picks the photo size at template build time from a dropdown: 35×45 mm Indian passport (aspect 0.7778), 25×35 mm stamp, 51×51 mm US (1.0), or custom. **Never guessed.**

#### Step 1 — Per-edge RANSAC step-response line fitting (produces the quad)

For each of the four edges, take a band of ±6 mm around the expected edge. For the **left** edge, for every row `r` and every candidate column `x` in the band:

```
s(r,x) =        | median(L[x−w..x−1]) − median(L[x+1..x+w]) | / σ_L_paper
       + 0.6 ·  | median(C*[x−w..x−1]) − median(C*[x+1..x+w]) | / σ_C_paper
       + 0.4 ·  | median(HF[x−w..x−1]) − median(HF[x+1..x+w]) | / σ_HF_paper
        w = 0.8 mm
```

- **Medians, not means**, so a staple, a dust speck, a shadow line or a single blown pixel cannot drag the response.
- Each channel is divided by the standard deviation of that channel measured over **paper-only patches sampled from this same scan**. Everything is self-normalised; there is no absolute L\* constant anywhere.
- `HF` is the channel that fires on white-on-white.

Then: `argmax_x s(r,·)` per row → **RANSAC line fit** through the per-row argmax positions, tolerance 0.25 mm, 200 iterations, PROSAC-ordered by response strength. Intersect the four fitted lines → **exact quadrilateral**, which also directly yields the paste rotation θ.

**Acceptance per edge:** inlier ratio ≥ 0.55 **and** mean inlier response ≥ 3.0 (i.e. three paper-σ). An edge that fails is *not* replaced by the template's edge — it fails the whole detection into a lower tier (see §3.4).

**Printed-border disambiguation.** The classic error is locking onto the pre-printed "Affix Photo" rectangle instead of the photo pasted over it. When the template knows where its printed border is:
- Any fitted line landing within **0.4 mm** of a known printed border must exceed the best alternative candidate line by **1.5×** in response to be accepted.
- If two roughly-parallel candidate lines exist within 4 mm, prefer the **inner** one (the photo sits inside its box; a photo overlapping outward is caught by the size gate).
- Judge D1 noted the mirror-image failure — a hand-drawn ink border around the photo — which is handled by the same "prefer inner of two parallel steps" rule.

**Glare and staples.** Rows whose peak response is below the floor become RANSAC outliers automatically; no special case needed. Staple marks are small dark components inside the accepted rectangle. Tape specular bands (>70 % of a row with `V > 250` and low local σ) are marked *unknown*, contributing neither support nor opposition.

#### Step 2 — Content acceptance scoring (accept/reject only, never segment)

Measured **inside** the fitted quad, on `TONE` for tone features and on `FLAT` for structure features:

| Feature | Definition | Photo | Handwriting / blank |
|---|---|---|---|
| `covFrac` | fraction of quad interior with `Δ > 4·MAD(Δ_paper)` | 0.80–1.00 | < 0.35 |
| `lvCoverage` | fraction of 9×9 windows with local variance > p95 of the scan's own paper-patch variance | > 0.85 | 0.10–0.30 |
| `toneSpread` | fraction of 256 histogram bins between p2 and p98 carrying > 0.2 % mass | > 0.45 | < 0.20 |
| `bimodality` | Otsu between-class variance ratio η | < 0.55 | > 0.75 |
| `chromaClusterCount` | count of distinct chroma-weighted hue modes (C\* > 12), 36-bin histogram, modes ≥ 8 % mass | ≥ 2 | 1 |
| `hfContrastRatio` | mean `HF` inside ÷ mean `HF` on adjacent paper | > 1.6 | ≈ 1.0 |
| `rectangularity` | quadArea / minAreaRectArea | ≥ 0.80 | — |
| `sizeFit`, `aspectFit` | vs declared photo size; size ∈ [0.72, 1.35]×, aspect ∈ ±15 % | — | — |

```
photoContent =  0.26·σ(covFrac, 0.55, 0.85)
             +  0.22·σ(lvCoverage, 0.35, 0.80)
             +  0.16·σ(hfContrastRatio, 1.15, 1.80)
             +  0.14·σ(toneSpread, 0.20, 0.50)
             +  0.10·σ(chromaClusterCount, 1, 3)
             +  0.12·(0.5·rectangularityFit + 0.5·sizeAspectFit)
   where σ(v,a,b) = clamp((v−a)/(b−a), 0, 1)
```

**Greyscale / photocopy branch.** If page-level `satFrac < 0.02`, `chromaClusterCount` is meaningless; drop it and redistribute its 0.10 as +0.06 `toneSpread`, +0.04 `(1 − bimodality)`. Lower the content threshold to 0.48 and **cap the resulting confidence at 0.72** (forced review).

#### Step 3 — Optional Tier-2 refiner (SlimSAM), browser-side

`Xenova/slimsam-77-uniform` — Apache-2.0, **13.2 MB quantised total** (vision encoder 8.5 MB + prompt/mask decoder 4.7 MB), transformers.js, box-promptable. Feed it the Step-1 quad's bounding box as a prompt; it returns a pixel-accurate mask. Take `minAreaRect` of the mask.

- **Used only as an agreement signal.** Accepted iff `IoU(SAM quad, Step-1 quad) ≥ 0.85`, in which case it may replace the quad and adds +0.06 to geometric confidence. Below 0.85 it is logged and discarded — it never overrides the deterministic fit.
- Runs in the **browser** during verification (free compute, amortised across a session, no COOP/COEP requirement, no per-request cold-start tax). Server-side execution via `onnxruntime-web` (13.96 MB wasm) is behind a flag and off by default.
- It genuinely helps the awkward cases the research names: a crooked photo overlapping its printed border, staple marks, a photocopy-of-a-photo with low contrast — because it segments by appearance rather than by finding the printed rectangle.
- **Not on the v1 critical path.**

#### Step 4 — Positive absence

If the printed placeholder rectangle **was located in the scan** (Hough restricted to ±5° of the template's expected edge orientations, four lines bounding a rectangle within ±2 mm of expected) **and**:
- interior `covFrac < 0.15`, **and**
- interior mean local σ ≤ **p85 of paper patches sampled from this same scan** (self-referential — comparing a phone JPEG against a clean template's 5th percentile is a test that essentially never passes, which is how "Not Detected as assertion" silently reverts to "Not Detected as fallback"; judge D2#5), **and**
- `INK` inside the box < 0.5 % of box area,

then emit **`Not Detected — the photo box is empty`** with **HIGH** confidence in the absence.

#### Step 5 — Post-processing

- Warp the exact detected quad to an upright rectangle with a 4-point homography, **bicubic** (`cv.warpPerspective`, `INTER_CUBIC`), sampled from `ORIG` — so a crooked pasted photo comes out straight. This is the visible quality difference versus an axis-aligned crop.
- Inset 1.5 % per side (the fitted line lands *on* the boundary; an inset removes the paper sliver and drop shadow — always safer than an outset).
- **Staple removal:** very dark CCs (L < 40) within 4 mm of a corner, area 0.2–4 mm², aspect > 2 → `cv.inpaint` with a 7 px ring, TELEA.
- Mild grey-world white balance (per-channel gain clamped to [0.8, 1.25]) and CLAHE on L (8×8 tiles, clip 2.0), **both skipped if the crop is already well exposed** (L histogram spans > 70 % of range). Good captures are never "improved".
- Emit `photo_raw` (lossless PNG, native `DETAIL` resolution, detected quad recorded in metadata) and `photo_display` (413×531 @ 300 dpi, aspect preserved by **padding, not stretching** — forcing 35:45 onto a 30:40 photo distorts faces).
- **No invented resolution.** If reaching 300 dpi requires > 1.5× upscale, emit at honest native scale, set `low_resolution=true`, and cap that field's confidence at 0.72.

---

### 3.2 Signature

Operates on **`INK`**, so the printed ruled line and the printed "Signature" label are already gone before detection starts. That is only possible because we know exactly where they were.

**ROI.** `templateSignatureBox ⊕ max(10 mm, 0.40 × box dimension)` — signatures habitually overflow.

#### Step 1 — Stroke grouping (complete-link, hard caps)

Signatures fragment into 2–6 disconnected strokes. Group `INK` components with:
- **Complete-link** clustering (not single-link — single-link chains catastrophically through registration residue into the printed label and the adjacent handwritten date; judge D3#6).
- Distance = bbox gap, thresholds **4 mm horizontal / 1.5 mm vertical** (the horizontal bias merges the pieces of one signature without merging two lines of writing).
- **Absolute cap: cluster bbox ⊆ ROI ⊕ 12 mm.** A group violating the cap is split at its widest internal gap.

#### Step 2 — Size gate

Reject groups with total ink area < 25 mm² or bbox width < 15 mm. Kept deliberately low so small initials survive.

#### Step 3 — Feature scoring

```
sigScore = 0.20·aspectBand
         + 0.17·(1 − σ(solidity, 0.30, 0.70))
         + 0.14·σ(strokeWidthCV, 0.30, 0.55)
         + 0.14·curvatureScore
         + 0.11·(1 − printedTextLikelihood)
         + 0.10·σ(longestBranchMM, 20, 45)
         + 0.08·baselineProximity
         + 0.06·(1 − ocrWordContainment)
```

| Feature | Definition | Signature | Contrast |
|---|---|---|---|
| `aspectBand` | plateau: `σ(aspect,1.4,2.5)·(1−σ(aspect,8,12))` | wide & short | — |
| `solidity` | ink / convex hull area | **0.25–0.65** | thumb 0.75–0.95, photo > 0.95 |
| `strokeWidthCV` | CV of `2 × p75(chamfer-3-4 DT over ink)` | 0.35–0.60 | printed text < 0.35 |
| `curvatureScore` | `σ(mean|dθ|, 0.06, 0.20 rad/px) · σ(signChangesPerCm, 1.5, 6)` on a Zhang–Suen skeleton | high | ruled line ≈ 0 |
| `printedTextLikelihood` | `σ(baselineAlign)·σ(1−swCV)·σ(charPitchRegularity)`; pitch = max normalised autocorrelation peak of the column-sum profile, lag 8–40 px | low | printed type > 0.45 → **also a registration alarm** |
| `longestBranchMM` | longest single skeleton branch | 25–80 mm | block capitals 5–12 mm (accepted, lower confidence — correct behaviour) |
| `baselineProximity` | `1 − clamp(|centroidY − templateLineY| / 15 mm, 0, 1)` | — | — |
| `ocrWordContainment` | fraction of group ink inside an Azure word polygon with confidence > 0.80 | ~0 | hand-printed text high |

#### Step 4 — Textract cross-check (the externally-calibrated vote)

Map every `SIGNATURE` block from Stage 6 into CTS.

| Textract | Local | Action |
|---|---|---|
| fires, `IoU ≥ 0.30` with best group | `sigScore ≥ 0.55` | **Accept.** Union the two extents (Textract's box is coarse but its recall is real). Confidence gets Textract's own `Confidence/100` as a calibrated feature. |
| fires | no group above threshold | **Re-search** inside the Textract box with thresholds relaxed 25 %. If still nothing, emit `Not Detected` with the reason `detector_disagreement` and show Textract's region as a dashed suggestion. |
| silent | `sigScore ≥ 0.70` | **Accept**, −0.08 confidence. Textract can miss non-Latin scrawl and very light pencil; it does not get a veto. |
| silent | `0.55 ≤ sigScore < 0.70` | **Not Detected**, below threshold. |

#### Step 5 — Cross-class rejection and cap

- Reject the group if it passes the thumb blob gate (solidity ≥ 0.75 and aspect 0.55–1.8 and fill ≥ 0.30) — it is the thumb.
- Reject if `covFrac > 0.7` and `maxDistanceTransform > 1.7 mm` — signatures never have a DT maximum that large; strokes are thin by construction. That is a photo or a pasted sticker.
- **Area cap, with defined behaviour** (the original designs specified a cap and never said what happens on breach; judge D1#12): if cluster area > `3 × learnedPriorArea`, or > `2 × ROI area` when no prior exists, keep the **sub-cluster whose centroid is nearest the baseline anchor**, drop the rest, set `reason='adjacent_content_excluded'`, and **force review**. Never truncate silently, never reject outright.

#### Step 6 — Post-processing

- Deskew computed (PCA principal axis of ink) and **recorded but not applied** unless the template opts in. Default OFF: silently rotating a signature looks wrong to a verifier comparing it against the paper.
- Primary output: **ink-on-transparent PNG.** `alpha = INK_soft` dilated 2 px and feathered with a 1 px Gaussian; `RGB` = median ink colour of the group, so a blue pen stays blue. This composites cleanly onto a discharge summary, a doctor view, a printed receipt — a materially better deliverable than a rectangular JPEG with paper texture and a printed rule through it, and it is only possible because the rule was subtracted.
- Also emit a flattened white-background PNG for compatibility. Pad 3 mm. Upscale 2× (lanczos3) if the long edge < 600 px.

---

### 3.3 Thumb impression — deliberately descoped, and stated as such

**The honest position.** Two designs built elaborate ridge-frequency machinery (Gabor banks, structure-tensor coherence, 64×64 FFT radial spectra) on a physical constant — human ridge spacing 0.4–0.6 mm. Both judges independently demolished it, and they are right on three counts: (a) real Indian stamp-pad thumb impressions are usually **over-inked into a solid smudge** with no resolvable ridges at any DPI; (b) mid-range Android ISPs apply aggressive denoise and sharpening that destroy exactly that band; (c) JPEG 8×8 DCT quantisation puts spurious energy at an 8 px period, immediately adjacent to the diagnostic band, producing false positives on the fallback that was supposed to save it.

**v1 thumb detector = blob + geometry + chroma. No ridge analysis. Confidence hard-capped at 0.70. Always review.**

```
Candidates: within ROI ⊕ 30%, Otsu-threshold FLAT with a histogram computed
            INSIDE the ROI only (not globally); close 2.5 mm; CC; union with
            INK-derived CCs (a smeared thumb's core is near-solid).

Gate:  area 150–1200 mm²   (a thumb pad is ~15×20 mm to ~25×30 mm)
       aspect 0.55–1.8
       solidity ≥ 0.70
       fill ∈ [0.30, 0.85]
       NOT cursive: curvatureScore < 0.30 AND longestBranchMM < 0.6 × bboxDiagonal

thumbScore = 0.30·σ(solidity, 0.60, 0.85)
           + 0.22·aspectFit
           + 0.20·σ(inkFrac, 0.30, 0.60)
           + 0.16·colourConsistency
           + 0.12·(1 − cursiveness)

colourConsistency:  hueEntropy < 0.25  AND  ink is near-neutral (median C* < 8)
                    or in the blue/violet band (Lab b* < −8, or a* > 10 ∧ b* < 0).
                    Stamp pads are one ink; photographs never are.

Accept: thumbScore ≥ 0.55 AND the anchor is a declared thumb field.
Confidence: min(computed, 0.70).  Always needs_review = true.
```

**v1.2 (deferred, gated):** ridge confirmation may run **only** when `effectiveDpi ≥ 350`, sampled from `ORIG` at native resolution, with an explicit **notch rejecting energy at exactly the JPEG 8-px period ±10 %**, a required global-orientation-variance test in [0.15, 0.60] (halftone screens are globally uniform at 45°; fingerprints curve around a core), and — critically — it may only **raise** confidence, never reject a candidate. Accepted risk if never built: thumb crops remain a manual-confirm step. That is an honest trade; the alternative is expensive machinery that fires on flatbed scans and almost never in the field.

**Cross-box error surfacing.** Because the template declares which box is which, a high-cursiveness, low-fill blob in the thumb box means *someone signed in the thumb box* — surfaced explicitly to the operator as a warning, not silently cropped into the wrong field. Same in reverse.

---

### 3.4 Fusion and the Not-Detected decision rule

Four evidence sources per image element, combined in a fixed precedence.

**S1 — Geometric prior.** `ROI_search` from the template anchor. Detection outside `ROI_search` is deliberately not attempted: a page-wide search materially raises false accepts, and a signature in the wrong box is a *human* error we should surface, not silently absorb.

**S2 — Scan-observed placeholder.** Independently re-locate the printed box in the scan. If found, the **scan-observed** box (not the template box) becomes the geometric anchor, absorbing residual registration error. If found and verifiably empty → HIGH-confidence absence.

**S3 — Deterministic detector.** §3.1 / §3.2 / §3.3 outputs with their measured feature values.

**S4 — External detector.** Textract `SIGNATURES` (signature only). Real detector, real calibrated confidence, script-agnostic.

**S5 — VLM adjudication (ambiguous cases only, never a coordinate).** Invoked only when S3 produced a candidate that fails exactly one acceptance clause, or when two candidates compete. Never asked "where"; asked "what is this".

#### Joint assignment

Build a cost matrix over `candidates × {photo, signature, thumb, none}`:
```
cost(c, k) = −log(classScore(c,k)) + 0.6 · normalizedDistanceToAnchor(c, k)
cost(c, none) = −log(acceptThreshold(k))
```
Solve with Hungarian (n ≤ 8, microseconds). Hard constraint: one candidate per class. This prevents a single blob being crowned both signature and thumb, and prevents an overflowing thumb from stealing the signature slot when a real signature also exists.

#### The gate — conjunctive, named clauses, logged on failure

A crop is emitted **only if all of**:

| # | Clause | Detail |
|---|---|---|
| G1 | **Trust** | Registration is `STRICT`, or `LOOSE` **and** S3 fired independently at score ≥ τ_high |
| G2 | **Boundary** | (photo) all four edges fitted with inlier ratio ≥ 0.55 and response ≥ 3σ; (signature/thumb) group passed size + shape gates |
| G3 | **Content** | class content score ≥ τ (photo 0.55 / signature 0.55 / thumb 0.55) from a *different feature family* than G2 |
| G4 | **Structural — "is this still the blank form?"** | `SSIM(crop, warped blank ROI) < 0.90`, computed with an explicit **variance floor**: if *both* patches have variance below the paper-noise floor, the result is **`blank`**, not "different". (NCC subtracts means and divides by σ, so on two flat white patches it is noise-dominated and lands anywhere — it fails to fire on exactly the empty box it was written to catch; judge D3#4.) |
| G5 | **External / adjudication** | signature: Textract agrees, or local ≥ 0.70. Ambiguous cases: ≥ 2 of 3 VLM votes `present`, **and** the per-scan negative control passed |
| G6 | **Uniqueness** | won its class in the Hungarian assignment |

Any clause failing ⇒ **no image is stored**, value = literal `"Not Detected"`, `needs_review = true`, and `detector_events` records **which clause failed**. That telemetry powers an admin insight: *"38 % of Not Detected on this template failed the still-looks-blank check → your staff may be scanning before the photo is pasted."* A refusal becomes an operational finding.

#### The three absence reasons — surfaced distinctly

| Reason | Condition | UI | Confidence in the absence |
|---|---|---|---|
| `box_empty` | S2 located the placeholder, G4 returned `blank`, `INK` < 0.5 % | "Not Detected — the box is empty" | **HIGH** |
| `below_threshold` | candidates exist, none clears | "Not Detected — possible content found, please check" + best candidate as a **dashed one-click suggestion** | LOW |
| `geometry_unknown` | trust gate failed | "Could not align this form — re-scan, or set the crop manually" | n/a |

**Absolute rules.** `Not Detected` **never** carries a percentage — we have no calibrated probability for a non-event and false precision destroys trust in every other number on the screen. A below-threshold candidate is never emitted as an answer. The asymmetry is deliberate and matches the product rule: the operating point minimises **false crops** even at the cost of misses, because a miss is visible and fixable on the verification screen while a plausible wrong crop can slip through review.

#### Per-scan negative control (kept, hardened)

Before trusting any VLM adjudication vote on a scan, push a **known-blank region** through the identical verifier prompt. If the verifier claims it sees the target, that verifier's weight goes to zero **for that scan** and adjudication falls back to local evidence only.

Hardening (judge D3#22 found the original brittle): the control region is chosen from areas that are **empirically blank across this template's scan history** (occupancy < 2 %), not merely blank on the template — real forms collect rubber stamps, registration stickers and margin overflow. The region is ink-checked immediately before use; if it has ink, the next candidate region is used. If no clean control region exists, adjudication is skipped and the element falls to `below_threshold`, rather than forcing the entire scan to manual review.

#### VLM adjudication call (when invoked)

Three images in one turn: (1) the bare crop, (2) the crop with 40 % context margin and the proposed quad drawn in magenta (composited server-side via `sharp.composite()` of an inline SVG), (3) the same region of the **blank template**. Asking about a *drawn* rectangle in context is far more reliable than asking for numbers.

Schema: `{ present: boolean, kind: 'colour_photo'|'greyscale_photo'|'photocopy_of_photo'|'blank_box'|'handwriting'|'printed_only'|'other', crop_error: 'none'|'too_tight_top'|...|'wrong_object', suggested_adjust_pct: {...} }`.

**Prompt wording is purely geometric and documentary.** "Locate and describe the rectangular pasted region." Never anything resembling describing or identifying a person — Claude refuses person identification by policy and drift toward it risks refusals on a core product path. Cropping a region is fine; the prompt must make that unambiguous.

**Repair loop:** max 2 iterations, each directional adjustment clamped to ±12 %, and after each adjustment **the deterministic §3.1 edge fit re-runs**. The model proposes; the CV disposes. A model adjustment is never applied directly to the output geometry.

#### Coordinate adapters (cold path only, but they must be exactly right)

Three families, three mutually incompatible conventions. Transposing them is silent and catastrophic on a portrait A4 form.

```ts
// lib/models/bbox/gemini.ts   box_2d = [ymin, xmin, ymax, xmax], normalized 0–1000
// lib/models/bbox/qwen.ts     bbox_2d = [x1, y1, x2, y2],        normalized 0–1000
// lib/models/bbox/claude.ts   [x1, y1, x2, y2] in ABSOLUTE PIXELS of the POST-RESIZE image
```
- **Gemini detection calls:** thinking budget **off** (Google's own docs recommend it for detection and an mAP study confirmed it), native-resolution image, the documented trigger phrasing *"Detect the 2D bounding boxes of the …"*, JSON array demanded with no code fences and no masks, output capped at 8192 tokens. Segmentation `mask` is a **base64 PNG probability map defined inside `box_2d`** — not a polygon vertex list, and by construction it cannot extend outside the box (judge D3#2 caught a design treating it as a tighter polygon). If used, decode the PNG.
- **Claude calls:** pre-resize ourselves using Anthropic's published `resizedSize()` reference (banker's rounding, to match the live API) so coordinates map 1:1, and set `"transformations": { "oversized_image": "error" }` on every coordinate-bearing image block — turning silent server-side resizing into a 400 that names the exact target dimensions. Remember Claude 4.7+ is high-res tier (2576 px / 4784 tokens) while older models are standard (1568/1568); using the wrong tier's limits recovers the wrong dimensions and misaligns everything. Also: Claude's own docs state coordinate outputs are *approximate* — which is precisely why they are never on the warm path here.
- **Each adapter has a unit test using a synthetic image with a known-position rectangle.** Non-negotiable.

---

### 3.5 Pure-TS CV primitives — build checklist

Legend: ✅ exists and is tested in `lib/vision/` · 🔨 to write in pure TS · 🅾️ provided by OpenCV.js · 🌐 browser only.

**Core buffers and types**
- [x] ✅ `Gray`/`Mask`/`Rgb`/`F32`/`Rect`/`Quad`/`RotatedRect`/`Matrix3` — `types.ts`
- [x] ✅ `toGray`, `saturation`, `valueChannel`, `cropGray/Rgb`, `resizeGray`, `fitWithin`, `sampleBilinear`, `histogram`, `percentile` — `gray.ts`
- [x] ✅ `integralOf`, `integralPairOf`, `boxMean`, `boxVariance`, `rectFillRatio` — `integral.ts`
- [x] ✅ image header sniffing, decode guards, `MAX_INPUT_PIXELS` — `image-header.ts`, `io.ts`

**Binarisation and morphology**
- [x] ✅ `otsuThreshold`, `binarize`, `sauvola`, `adaptiveMean`, `estimateIllumination`, `flattenIllumination`, `binarizeDocument`, mask set-ops — `threshold.ts`
- [x] ✅ `dilate/erode/open/close` + rect variants, `removeRules`, `extractRules`, `boundary` — `morphology.ts`
- [ ] 🔨 `morphologicalReconstruction(marker, mask)` — needed for rule-crossing stroke repair (§7 step f)
- [x] ✅ `labToImages(rgb) → {L, a, b, chroma}` — sRGB→linear (0.04045/12.92) → XYZ D65 → Lab — `colour.ts`
- [x] ✅ `whiteBalanceByPaper(rgb, inkMask)` — p95 per channel over non-ink — `colour.ts`
- [x] ✅ `highFrequencyEnergy(gray)` — `|I − boxBlur3|` then 9×9 mean — `colour.ts`

**Components and shape**
- [x] ✅ `connectedComponents` (union-find), `componentMask`, `componentsWithin`, `groupByProximity` — `components.ts`
- [ ] 🔨 `completeLinkCluster(components, gapX_mm, gapY_mm, capRect)` — replaces `groupByProximity` for signatures
- [x] ✅ shipped as `distanceTransform(mask)` — 3-4 two-pass; feeds stroke width and chamfer score — `features.ts`
- [x] ✅ `zhangSuenThin(mask)` + branch metrics shipped as `skeletonShape(skel)` → branch lengths, turning angles, sign changes — `thinning.ts`
- [x] ✅ `convexHull`, `minAreaRect`, `approxPolygon`, `orderQuad` — `geometry.ts`

**Geometry and warping**
- [x] ✅ `estimateHomography` (DLT), `multiply3`, `invert3`, `applyHomography`, `reprojectionError`, `warpQuad`, `warpPerspective` (Gray, bilinear), `quadOutputSize` — `geometry.ts`
- [x] ✅ shipped as `warpQuadRgb(...)` in `warp-rgb.ts` — Catmull-Rom a = −0.5, 4×4 taps, edge clamp. **Required because sharp cannot do a projective transform** — `sharp.affine()` takes a **2×2 matrix only**; maintainer confirmed 4-point projection is not supported and the request has been open since Feb 2020.
- [ ] 🔨 `composeCrop(origRgb, quadMM, H, outDpi)` — the single-resample crop path
- [ ] 🅾️ RANSAC homography, ORB pyramid, matchTemplate, HoughLinesP, APAP cell solve
- [ ] 🌐 `image-js` `getPerspectiveWarp` + `transform` for the client preview

**Detector-specific**
- [x] ✅ `edgeStepProfile(detailBand, channelWeights, halfWindowMM)` → per-row argmax + response — `lines.ts`
- [x] ✅ `ransacLineFit(points, tolMM, iters)` → line + inlier ratio (PROSAC ordering) — `lines.ts`
- [x] ✅ `intersectLinesToQuad(l0..l3)` — `lines.ts`
- [x] ✅ `paperStatistics(...)` — shipped as `lib/ink/paper-stats.ts` — **the self-normalisation source; everything depends on it**
- [ ] 🔨 `tileMatchedDifference(scan, template, tileMM)` → `Δ` map (robust per-tile gain/offset)
- [x] ✅ `strokeWidthStats(mask)` → median, CV via chamfer DT — `features.ts`
- [x] ✅ `pitchRegularity(mask)` → max normalised autocorrelation peak of column-sum profile, lag band — `thinning.ts`
- [ ] 🔨 `ssimWithVarianceFloor(a, b, floor)` → `{ ssim, bothFlat: boolean }`
- [ ] 🔨 `hungarian(costMatrix)` — n ≤ 8
- [ ] 🔨 `moransI(residuals, positions, permutations)` — APAP trigger

**Statistics / calibration**
- [ ] 🔨 `isotonicRegression(x, y, weights)` — PAVA, ~40 lines
- [ ] 🔨 `logisticIRLS(X, y, weights, l2)` — 9 features, trivial
- [ ] 🔨 `expectedCalibrationError(preds, labels, bins)` + bootstrap CI

**Explicitly not written:** SIFT/AKAZE (absent from the OpenCV.js build anyway), full 3-D dewarp, any background-removal network (every convenient one is AGPL or a proprietary Bria licence, and they are *salient-object matting* models solving a different problem — CLAHE → background division → adaptive threshold → morphological open → CC gets cleaner ink masks at ~1000× less weight and zero licence risk).

**Count, as planned: 22 new pure-TS functions, 9 of them ≤ 40 lines, on top of the 2,160 tested lines that existed when this plan was written.** Most have since shipped — the unchecked 🔨 rows above are what remains — and note the plan's cost argument has partly inverted: two of the pieces this sentence originally deferred to OpenCV.js, the projective warp and the distance transform, were in the end written in pure TS anyway, while OpenCV.js itself has not been adopted at all.

---

## 4. The text-extraction engine

### 4.1 Structure: crop-and-read, never whole-page (warm path)

Two structural wins, both from geometry rather than prompting.

**Resolution.** A name in a 60×8 mm box sampled at 300 dpi is 709×94 px — ~70 px character height. The same name inside a whole page downsampled to a model's ~1024 px input is ~180 px wide with ~12 px characters. **That is roughly a 6× increase in effective character height**, and character height is the dominant term in handwriting accuracy.

**Attribution.** A model that never sees the name and mobile boxes in the same image **physically cannot swap them**. Cross-field value misassignment is the most common whole-page failure and registration eliminates it by construction.

### 4.2 Pre-model CV gating (the primary hallucination defence)

Before a single token is spent:

- **Checkboxes and radios never reach a model.** `inkFrac` from `INK` inside the box vs the blank template's fill at the same ROI: `Δfill > 0.12` → checked. ~99.5 % accurate, free, deterministic.
- **Blank-field gate — with an absolute floor, not a fraction.** The fractional gate (`inkFrac < 0.008`) deletes single-character answers: a 60×8 mm ROI at 300 dpi is 66,646 px, so 0.008 is 533 ink pixels, while a single handwritten digit is ~350–450 ink pixels. "Age: 5" would be silently declared blank and never reviewed — worse than a hallucination, because a hallucinated value gets checked and an empty one does not (judge D1#3). **Corrected rule:**
  ```
  inkArea_mm2 = |INK ∩ ROI| / (dpi/25.4)²
  blank      : inkArea_mm2 < 2.0        AND  no CC with area ≥ 1.2 mm²
  ambiguous  : 2.0 ≤ inkArea_mm2 < 6.0  → send to model AND force review
  written    : otherwise                → send to model
  ```
  Absolute mm², identical sensitivity on a 12 mm-wide "Age" box and a 120 mm-wide "Address" box.
- **Devanagari routing.** Detect the *shirorekha* via the row-projection profile of `INK` (a peak > 3× median in the top 25 % of the ink band), corroborated by Azure's `detectedLanguages`. Flagged strips go to Gemini with a transliteration request and are **always** review-required.

### 4.3 Model lineup — chosen against the research, not against habit

**Groq is not the vision path.** The research is decisive: Groq serves exactly **one** image-capable model (`qwen/qwen3.6-27b`); it is **preview status** with documented precedent for sudden removal (Llama 4 Scout and Qwen3 32B were pulled from the rate card and catalog on 2026-07-21); it is capped at **8,000 TPM / 1,000 RPD** on the paid Developer plan, which is roughly 1–2 form scans per minute; and **strict structured outputs are supported only on the text-only `openai/gpt-oss-*` models**, so you cannot get schema-guaranteed JSON out of an image on Groq. Any one is disqualifying for a multi-tenant production platform; together they are decisive. Groq remains available behind `ENABLE_GROQ_FASTPATH=false` for low-stakes text fields only, with a non-Groq fallback and defensive parsing.

Also note: the sibling project's two model IDs are **two different vendors**. `qwen/qwen3.6-27b` is Groq; `gemini-3.5-flash-lite` is Google's Gemini API. The existing Groq key does not cover both — a separate Google AI/Vertex credential is required, server-side only, never `NEXT_PUBLIC_`.

| Role | Model | Rationale |
|---|---|---|
| **Primary reader** | `gemini-3.5-flash-lite` | $0.30/M in, $2.50/M out; minimal thinking by default; explicitly positioned for "high-throughput classification, routing, or JSON extraction" and document parsing. The right tool for reading a 700×90 px crop. |
| **Decorrelated reader (critical fields)** | Claude vision (Haiku-tier default; escalate to Opus-tier on disagreement) | Different family, different failure modes. Pre-resized by us; `oversized_image: error` set. |
| **Cold-start whole page & detection** | `gemini-3.7-flash` | Stable; strong document performance; thinking disabled for detection calls. |
| **Lexical reader (third opinion)** | Azure `prebuilt-read` words in ROI | **Structurally incapable of inventing a plausible Indian name.** This property is the point. |
| **Devanagari** | `gemini-3.7-flash` | Led the only rigorous 2026 Devanagari benchmark (chrF++ 86.3 vs Claude 82.2 on *printed* real scans). Always review. |

Model IDs and weights live in `model_config` **in the database**, not in code, with a boot-time capability probe and a nightly golden-set regression. Provider lineups in this space change on a scale of weeks; the Gemini 3.7/3.6 promotional pricing has a hard documented expiry of 2026-12-31 after which rates double.

### 4.4 Prompt and schema

```
SYSTEM
You transcribe a single handwritten value from a cropped region of an Indian paper form.
1) Transcribe EXACTLY what is written. Do not correct, complete, expand or infer.
2) If the region is blank, or contains only the printed label or the printed line,
   set is_empty=true and value="".
3) Never invent a plausible value. An empty answer is correct and expected.
4) If a character is ambiguous, choose the most likely and list its 0-based index
   in ambiguous_chars.
5) Do not include printed label text in the value.
6) Echo the printed label you can see in label_echo.
```

USER carries: the admin's **exact field label**, the declared field **type stated as a constraint in words** ("Indian mobile number, 10 digits, first digit 6–9"), and for dropdown/radio the **exact option list**.

```ts
const FieldRead = z.object({
  label_echo: z.string(),                 // ← misattribution detector
  verbatim: z.string(),                   // exactly the ink, pre-normalisation
  value: z.string(),                      // normalised
  is_empty: z.boolean(),
  script: z.enum(['latin','devanagari','mixed']),
  legibility: z.enum(['clear','partly_legible','illegible']),
  ambiguous_chars: z.array(z.number().int()),
});
```

Two deliberate design choices:

- **`verbatim` AND `value` are both required.** The gap between them is how you catch a model silently "correcting" *Rahol* to *Rahul*. Any divergence beyond whitespace/case is surfaced to the verifier.
- **No numeric self-confidence is requested.** `legibility` — a categorical perceptual judgement models handle acceptably — becomes one weak feature in the calibrator. It is never the answer.

`label_echo` is compared against the known printed label for that ROI. A mismatch means the crop or the index is wrong, and forces review. This is the guard the montage path needs (below).

Schema delivered via `zod` → `zod-to-json-schema` → Gemini `responseSchema` / Claude structured output. Where a provider offers only best-effort JSON, parse defensively with **exactly one repair retry** (re-send with the validation error appended), then fail closed to review-required.

### 4.5 Multi-pass structure

1. **Pass A** — every non-blank field, individually, `gemini-3.5-flash-lite`, on the flat-fielded `DETAIL` crop with printed context intact (the printed label and rule are useful *context for reading* even though they were noise for detection).
2. **Pass B (critical fields only)** — a **decorrelated** second read. Decorrelation is by **preprocessing and model family**, not temperature: Claude, on a Sauvola-binarised black-on-white version of the same field with the printed rule removed via `INK` and 2× upscale. Sampling noise at temperature 0.35 barely decorrelates anything — a VLM reproduces its own reading of an illegible scrawl near-deterministically, so `p_agree` reads ~1.0 on correct *and* incorrect hard cases (judge D2#14). Preprocessing + family decorrelates errors materially.
3. **Pass C (escalation)** — on disagreement, a third read on a larger Claude tier on Pass-A imagery. Majority of three wins. No majority → confidence capped at 0.45, forced review, **all three candidates shown to the operator as one-tap chips**. That converts a failure into a two-second choice, which is a much better UX than a blank box.
4. **Digit-wise pass (phone / Aadhaar / PIN).** We segment digits ourselves and never trust string-level cursive reading: `INK` CCs sorted by x; merge CCs whose x-ranges overlap > 40 %; split any CC wider than 1.8× median at the minimum of its vertical projection profile (handles two touching digits). Render each digit centred on a 64×64 white patch, tile horizontally with gutters, request N isolated digits with a top-2 alternative each. Isolated-digit reading is dramatically more reliable than cursive-string reading. If the string read fails the pattern and the digit-wise read passes, prefer digit-wise and record the substitution in the audit trail.
5. **Ink cross-check.** For every field, `inkArea_mm2` from `INK` is compared against the returned value:
   - non-empty value on a field with essentially zero handwriting ink → **probable hallucination**, forced red regardless of agreement;
   - substantial ink with `is_empty=true` → **probable miss**, triggers a re-read at +20 % crop and +15 % contrast.
   This is a model-independent check no whole-page architecture can perform, because it requires knowing exactly which pixels are printed.

**Budget mode (montage).** Under a per-org spend cap or a provider incident, up to 10 short-text crops composite into a **single-column** sheet with an index numeral rendered in the left gutter *and the printed label visible in each strip*. Both `label_echo` and index must agree or the field is forced to review. Two-column montages are banned (reading-order confusion), and montage is never used for safety-critical fields. Off-by-one attribution on numbered composites is a well-documented VLM behaviour; the label echo is what makes it detectable.

### 4.6 Validation and normalisation per field type

Pure TypeScript, `lib/text/normalize/*.ts`, run before anything is displayed or scored. **Every normaliser raises or lowers confidence; none silently rewrites.** Every repair is surfaced.

| Type | Normalisation | Validation | Confidence effect |
|---|---|---|---|
| `phone` | strip non-digits; drop leading `+91` / `91` / `0` | `/^[6-9]\d{9}$/` | fail → ×0.35 and forced review. Generate ≤ 8 single-substitution repairs over the standard confusion set (1↔7, 0↔O/D, 5↔S, 9↔g/q, 4↔9, 2↔Z); if exactly one repair is valid, offer it as a **chip**, never auto-apply, and cap at 0.60 (**red**, not amber — a silently substituted but syntactically valid mobile number means the hospital calls the wrong patient) |
| `blood_group` | map `B positive`/`B ve`/`B+ve`/`बी+` → `B+` | enum `{A,B,AB,O}×{+,−}` ∪ `__unreadable__` | **Always review, always shows evidence crop, no auto-green at any confidence** |
| `date` | `dd/MM/yyyy`, `dd-MM-yyyy`, `dd.MM.yy`, `d MMM yyyy`, Devanagari digits mapped to ASCII | reject impossible calendar dates; 2-digit year window 00–30 → 20xx | `dd/MM` vs `MM/dd` ambiguity when both ≤ 12: resolve against sibling date fields and scan date; unresolvable → keep `dd/MM` (Indian convention), −0.15 |
| `age` | integer | 0–120; **cross-validate against DOB** when both exist | mismatch > 1 year flags **both** fields — catches real transcription errors no single-field check can |
| `email` | lowercase, trim | RFC-lite regex + Levenshtein ≤ 2 against ~50 common Indian providers | confusable repairs (`gmial`→`gmail`, `.corn`→`.com`, `rn`→`m`) offered as chips, never applied |
| `pincode` | digits | `/^[1-9]\d{5}$/` | — |
| `name` | Title Case + whitespace collapse **only**; strip `s/o`, `d/o`, `w/o` into a relation field | flag if it contains digits | **No dictionary correction.** Inventing a plausible Indian name is precisely the fabrication the spec forbids. A ~20k Indian-name list is a *soft feature* for confidence, never a filter. **For name fields, 2-of-3 fusion requires the lexical OCR reader in the majority, or the field goes to review** — two correlated VLMs agreeing on *Rahul* over *Rahol* must not outvote the one reader structurally incapable of inventing a name (judge D3#12) |
| `dropdown` / `radio` | snap to nearest option by normalised Levenshtein | **hard distance floor 0.25**; beyond it → `Not Detected`, never a wrong option | The enum **must include `__unreadable__` as a real member.** A strict enum without it removes the model's ability to refuse, and then the validator *rewards* the coerced answer with a passing multiplier — an invented blood group scoring higher than an honest illegible read (judge D1#4). Enum-satisfaction only counts toward confidence when `verbatim` also matched pre-snap within the floor |
| `doctor` | snap to the org's roster | normalised edit distance ≥ 0.75, hard floor | Roster snapping is the single highest-ROI configuration ask: doctor names go from roughly 70 % to roughly 93 % on a bounded roster. **The snap is always visible in the UI with its distance.** Below the floor → `Not Detected`, not a plausible fabrication |
| `disease` | fuzzy-map to an ICD-10 shortlist | — | **suggestion chip only, never a replacement** |
| `address` | whitespace/line normalisation | — | multi-line ROI; overflow ink outside the box surfaced as "unassigned ink" warning |

---

## 5. Confidence model

### 5.1 Principle

**We never ask a model how confident it is.** No provider exposes logprobs for image *input* tokens (OpenAI's chat endpoints never have; vLLM routes multimodal through `/chat/completions` which does not parse `prompt_logprobs`; Anthropic exposes no logprobs parameter at all). Output-token logprobs are gated per-model and unconfirmed on current Gemini vision calls. A VLM's "0.85 confidence" is **generated text**, uncalibrated, and systematically overconfident on exactly the illegible cases where a warning matters most.

Every number displayed is either a **measured image statistic**, an **externally calibrated vendor confidence**, or an **agreement statistic** — passed through a calibration curve fitted on **audited** outcomes.

### 5.2 Features

**Text fields** (`lib/confidence/features/text.ts`):

| # | Feature | Source |
|---|---|---|
| f1 | `p_agree` | fraction of decorrelated reads agreeing after normalisation. Same-model-same-image repeats are **excluded** — they measure nothing |
| f2 | `charAgree` | per-character agreement after Levenshtein alignment (also drives per-character underlining) |
| f3 | `c_ocr` | min and mean **Azure per-word confidence** over words whose polygons fall in the ROI. *The only externally calibrated number for text.* |
| f4 | `q_reg_local` | `clamp01(1 − rmse/6) × localAnchorDensity` — inliers within 40 mm of this box. A field in a glare-blown corner scores low even when page-level RMSE looks fine |
| f5 | `inkEvidence` | logistic on `inkArea_mm2` vs this field's historical distribution. Direct, model-independent hallucination detector |
| f6 | `validatorScore` | regex/enum/checksum outcome **on `verbatim`**, plus cross-field consistency (age↔DOB) |
| f7 | `legibility` | categorical, from the model. Weak feature, learned weight |
| f8 | `captureQuality` | strip-level Laplacian ratio, ink-to-paper contrast, glare overlap, strike-through detection |
| f9 | `p_lp` | output-token logprob mean **if the provider exposes it**. Absent → the calibrator learns weight 0. **Nothing depends on it.** |

**Image fields** (`lib/confidence/features/image.ts`) — a separate, smaller model with no text features:

| Feature | Source |
|---|---|
| `edgeQuality` | mean inlier ratio and mean normalised step response across the four fitted edges (photo) |
| `contentScore` | §3 content score |
| `q_reg_local` | as above |
| `priorAgreement` | `exp(−½·mahalanobis²(detectedQuad, learnedPrior)/4)` over `[cx, cy, w, h, θ]` in CTS mm |
| `marginToRunnerUp` | best − second-best class score. The classic "was this a close call" signal |
| `externalDetector` | Textract `SIGNATURE.Confidence / 100`. **Externally calibrated.** |
| `glareOverlap` | specular mask ∩ crop |
| `samAgreement` | SlimSAM IoU, when run |
| `adjudication` | VLM votes / 3, only when invoked and the negative control passed |

**Explicitly removed:** the client/server crop cross-check. Running the same deterministic library on the same pixels twice and adding +0.05 when they agree is confidence *inflation*, not validation — the only varying input is the page quad, so it detects quad disagreement and nothing else. Kept as a diagnostic log line only.

### 5.3 Fusion and calibration

```
z        = w·x + b                       (logistic, IRLS with L2, per field kind)
conf_raw = sigmoid(z)
conf     = isotonic(conf_raw)            (PAVA, fitted on held-out audited data)
```

**The label problem, and its fix.** "Did the human save this unedited" conflates *correct* with *not scrutinised*. Ward staff under time pressure rubber-stamp; the curve then learns their diligence and reads as well-calibrated while being systematically optimistic on exactly the illegible fields where scrutiny is skipped. Worse, high confidence → green → not examined → "correct" → higher confidence is a **closed loop with no breaker**, and it runs fastest on name, phone and blood group.

**Mandatory blind audit sampling** is the breaker, and it is about thirty lines of code:
- **3 % of fields that would otherwise render green are forced to review**, randomly, invisibly to the operator (they simply see one more amber field). Their outcomes are the *unbiased* calibration labels.
- One rotating **audit form per week per org** is 100 % double-entered by a second operator; disagreements adjudicated.
- Calibration is fitted on **audited samples only**, with edited-field outcomes included under **inverse-propensity weighting** (weight = 1/P(audited | conf-bin)).
- A drift monitor tracks the learned geometric prior's mean; any systematic shift beyond 0.6 × MAD raises an alert rather than being absorbed.

**Hierarchical pooling.** A global calibrator per field kind across all orgs, plus a per-org offset with shrinkage proportional to `n_org`. A new hospital inherits a sane curve on day one and diverges from it as evidence accumulates.

**Statistical honesty about N.** Isotonic on 60 held-out points overfits badly and produces a step function worse-calibrated out-of-sample than plain Platt scaling; ECE over 10 bins at that N has a standard error around ±0.1, i.e. twice the target (judge D3#14). Therefore:

| Audited samples for a field kind | Display |
|---|---|
| < 400 | **High / Medium / Low** buckets. No number. Labelled "provisional". |
| 400 – 1,500 | Number shown, marked *provisional*, from the pooled global curve + shrunk org offset |
| ≥ 1,500 with bootstrap 95 % CI on ECE entirely below 0.08 | Number shown unqualified |
| ECE for a field kind rises above 0.08 | **Automatic reversion to buckets** for that kind, plus an alert |

Showing "96 %" on day one is a fabricated number, and a clerk who learns the number is meaningless stops reading all of them — which destroys the entire verification premise the product rests on.

### 5.4 Thresholds and display

- Review threshold τ per field kind is **read off the calibration curve**, not chosen by taste: the smallest τ with `P(correct | conf ≥ τ) ≥ 0.99` for safety-critical kinds and `≥ 0.95` otherwise. The review burden becomes a direct consequence of a stated safety target, tunable by moving one number that has an actual meaning, and it shrinks automatically as priors improve.
- Bands: green ≥ 0.90, amber 0.70–0.90 ("Check"), red < 0.70 ("Review Required").
- **Safety-critical fields never render green**: name, blood group, phone, doctor, drug/dose, allergy, ID numbers.
- Every below-threshold field shows a **plain-language reason** — "two reads disagreed", "glare over 22 % of this field", "ink too faint", "value not in your options list", "OCR and AI disagree on the spelling". A reason gets acted on; a bare number gets ignored.
- **`Not Detected` never carries a percentage.**
- Image-field confidence is shown as High/Medium/Low with the **crop itself and an Adjust handle** next to it. A percentage on an image is not interpretable by a clerk; the crop is.
- Reliability diagram, Brier score and 10-bin ECE with bootstrap CI on an admin page. ECE is a **shipped metric**, alerting above 0.08.

---

## 6. Template learning and registration

### 6.1 Three acquisition paths, one artifact

**(A) Blank-form upload — best, and pushed hard at onboarding.** Admin uploads the blank printed form (PDF via `pdfjs-dist` legacy Node build, or a scan/photo). Quad-detected, warped to CTS at 200 dpi → `T`, the canonical blank.

**Auto-anchoring assist — the central trick of this architecture applied to setup.** We do not make the admin start from nothing, and we do not ask a VLM to predict boxes.
1. Hough for horizontal rulings (θ within ±2° of horizontal, length ≥ 15 mm) — the "write here" lines.
2. `extractRules` on horizontal and vertical runs, unioned and CC'd → printed rectangles (photo/thumb candidates at area > 400 mm²).
3. `tesseract.js` v7 **in the browser**, on the admin editor page only, lazy-loaded — never on Vercel, so it contributes zero bytes to the runtime bundle and never runs in a request path. Cost on first load: `tesseract-core-simd-lstm.wasm` 2.73 MB + `eng.traineddata.gz` 2.95 MB ≈ 5.7 MB, then IndexedDB-cached. Pass `output: { blocks: true }` (**`blocks` defaults to `false`** and `page.blocks` is `null` without it), use `rectangle` to OCR only the band where a label is expected, constrain PSM and `tessedit_char_whitelist`. `Word.bbox {x0,y0,x1,y1}` + `Word.confidence` + `Word.choices` give anchor points and a cheap ambiguity signal. **Printed labels only — never handwriting;** Tesseract's own FAQ is blunt that handwriting "won't work very well".
4. **One** VLM call on the blank template rendered with each detected text-line group **outlined and numbered 1..N**, asking only: *"which numbered region is the printed label for field X?"* The model returns integers. This replaces "predict a bounding box" — which VLMs do badly — with "choose from a list of boxes we computed" — which they do very well.
5. The answer ROI is then derived **deterministically** as the ruled-line span or whitespace immediately right of (or below) the chosen label, bounded by the next detected label and the ruling extent.
6. Admin confirms or nudges in ~30 seconds instead of drawing 25 boxes. Typical total: 3–5 minutes for a 25-field form, once, ever.

**Publish-time validation** — catches misconfiguration at the only moment it is cheap:
- a `text` anchor containing > 40 % printed ink ⇒ the admin dragged over the *label*, not the answer line;
- an image anchor with no detected printed rectangle;
- two anchors overlapping by > 30 %;
- an anchor whose physical size is implausible for the declared photo size;
- fewer than 8 usable constellation labels;
- the periodicity autocorrelation test flags a highly repetitive layout ⇒ warn the admin that operators may occasionally be asked to tap a landmark.

**(B) Draw over a filled sample.** Same editor, on a rectified filled scan. Geometry identical; the initial anchor set is mined from an image containing handwriting, so some anchors sit on ink that varies. Self-correcting via anchor health, and fully repaired once path (C) produces a clean consensus blank.

**(C) Auto-derive from corrected scans** — the cold-start path, requiring nothing but the field list. See §6.4.

### 6.2 Anchor pack

From `T`: 48–80 anchors (Shi-Tomasi λ_min ≥ p90, **isotropy ≥ 0.15**, top-1 per cell of an 8×10 grid), packed into one greyscale PNG atlas (640×512, ~40 KB) plus JSON `{ id, cx_mm, cy_mm, atlasPos, health }`. Fetched once, held in Node module scope (LRU 5) keyed by `template_version_id`; cached client-side in `idb-keyval` for offline preview registration. Plus the constellation label set, the printed-ink mask, the printed-rectangle list, the ruling list, and the isotonic calibration curve — roughly 400 KB per template.

### 6.3 Registration contract (summary of Stages 3–5)

```
quad (4 cyclic orderings) → H₀
  → matchTemplate ZNCC anchors, coarse-to-fine ±16/±5/±2, parabolic subpixel
  → accept peak ≥ 0.55 AND peakRatio ≥ 1.15
  → findHomography(RANSAC, τ = 3.0 CTS px)
  → refit normalized DLT on inliers
  → Moran's I > 0.30 ⇒ APAP 4×5
  → TRUST GATE: geometric ∧ structural ∧ constellation ∧ periodicity
fallback when no quad or < 8 matches:
  ORB (8 pyramid levels) + BFMatcher(HAMMING) + ratio 0.80 + crosscheck
  → findHomography(RANSAC, 6.0) → replaces H₀ → re-enter
```

**Disambiguating similar templates.** When an org has several near-identical layouts (an OPD and an IPD form differing in three labels), register against every candidate and require the winner to beat the runner-up by **1.4×** on inlier count. Below that margin, ask the operator which form it is rather than guessing. Also gated by which published link the operator opened, which is normally decisive.

### 6.4 The consensus blank — and how not to poison it

**The idea.** Every 50 scans, take 15–30 `STRICT` registrations, warp all into CTS, and compute a per-pixel statistic. Handwriting differs between forms; printing does not. This manufactures a pristine blank `T` with zero admin effort and repairs templates originally built from a filled sample.

**The trap (judge D1#7).** A per-pixel **median** removes handwriting only where ≥ half the scans are blank at that pixel. But **people write in the same place** — that is the entire premise of the fixed-layout advantage. Five signatures in a 40×15 mm box overlap heavily near the baseline; five thumbprints overlap almost completely. The median would bake ghost ink into the synthetic template inside exactly the three highest-value ROIs, and the differential ink map would then subtract real signatures away as "printed".

**The fix — occupancy, not median, and ROI exclusion:**
```
occupancy(x) = fraction of the N registered scans in which pixel x is ink
printed(x)   ⇔ occupancy(x) ≥ 0.80          (not 0.50)
N ≥ 9 required (not 5)

Image-field ROIs and answer ROIs are EXCLUDED from the occupancy-derived
printed mask entirely.  Inside those ROIs the printed layer comes ONLY from:
  - the admin's blank upload, if one exists; or
  - deterministic printed-rectangle / ruling extraction (extractRules + Hough),
    which finds the box border and the baseline without needing occupancy.

Per-ROI learnability check: if occupancy inside an image ROI stays ≥ 0.8 across
a majority of its area, mark the ROI 'not_learnable' and fall back permanently
to printed-rectangle extraction there, with an admin nudge to upload a blank.
```
**Scan-to-scan registration circularity, resolved.** Registering scan N against scan 1 cannot mask to printed ink, because printed ink is precisely what is unknown. So bootstrap registration uses ORB on the **full** image for the first 3 scans, then switches to the provisional printed mask (occupancy ≥ 0.8 from those 3) for subsequent scans, and re-derives once N ≥ 9. Promotion gate: synthesised ink < 25 % of any individual scan's ink **and** cross-registration p95 RMSE across the set < 2 px **and** the constellation check passes against the synthesised blank.

### 6.5 Human-in-the-loop feedback — with the bias breakers

**What counts as a label.**
- A **drag or resize** on the crop handle → a geometry correction. Stored as `after_quad_mm` in CTS.
- A **one-click accept of a dashed suggestion does NOT update geometry.** Nothing distinguishes "human verified this is right" from "human did not object", and a tired operator one-clicking a systematically wrong crop — say the 3 mm outset from locking onto a hand-drawn border — would make the next identical wrong crop score *higher*, pushing it above threshold into auto-accept (judge D1#8). One-click accept updates the *value*, not the *prior*.
- Text edits → `before_value` / `after_value`.

**Geometry update.**
- Only from `STRICT` registrations. Never from `LOOSE` (a biased `H` under LOOSE launders a systematic offset into "learned" geometry, and trimmed means limit *variance*, not *bias*).
- Last 50 corrections per field; each ROI edge = **20 %-trimmed mean**; auto-applied only when `n ≥ 5` **and** `MAD ≤ 3 mm`; otherwise surfaced as an admin *suggestion*, not silently moved.
- **Bias detector:** the mean *signed* residual across corrections must be ≈ 0. If `|mean| > 0.6 × MAD`, that is a systematic offset (paper-size mismatch, one operator's phone, a reprint) — do not auto-apply; raise `systematic_offset_suspected` with the measured direction and magnitude.
- `search_pad_mm = p95(|correction − box|) + 2 mm`, so habitually-overflowed fields (signatures) widen automatically from real usage.

**Appearance prior.** Mean and covariance of the photo content features measured inside human-confirmed photo crops, per template. Mahalanobis distance of a new candidate becomes an extra local score — this is how the system adapts to an org that always uses greyscale photocopied photos.

**Anchor health.** Per-anchor inlier rate over a trailing 200-scan window; retire below 0.35 (stamps, staples, regions people write over); mine replacements from the refreshed consensus blank while preserving 8×10 spread.

**Promotion — per element type, not uniform.**

| Element | Promotion behaviour |
|---|---|
| **Photograph** | After 20 confirmed detections with MAD ≤ 2 mm, the ROI prior is tight enough that the edge fit converges in one pass. Cold-start VLM detection is dropped entirely. Accuracy up, cost down. |
| **Signature** | **Never skips local detection.** Ink extent is signer-dependent — a short "S. Kumar" versus a full-width flourish. Real signature-extent MAD is comfortably 8–12 mm, so a promotion guard set at 8 % of page width (13 mm) would never demote and the field would silently degrade to a mediocre average box (judge D3#8). What promotion *does* buy is dropping the Textract call when local score ≥ 0.80 and the prior agrees, which is a cost win, not a geometry win. |
| **Thumb** | Same as signature. Never promoted past local detection. |

**Drift and versioning.** If mean RMSE over a trailing 3-day window exceeds 2× the version baseline for > 20 % of scans, or chamfer drops below 0.45 for > 20 %, or the constellation pass rate drops below 0.6, raise **"this form's layout may have changed"**. Cluster recent registrations by residual signature; auto-build a v2 candidate from a consensus blank over the divergent cluster; offer one-click adoption with field geometry seeded through the median v1→v2 warp. **Old scans stay bound to the version that produced them**, so archived records remain reproducible.

---

## 7. Data model

Postgres via Supabase. **RLS on every table.** All policies route through one function:

```sql
create or replace function auth.org_ids() returns setof uuid
language sql stable security definer as $$
  select org_id from public.org_members where user_id = auth.uid()
$$;
-- typical policy
create policy org_read on public.scans for select
  using (org_id in (select auth.org_ids()));
```

Service-role access (the pipeline worker) bypasses RLS but every write carries `org_id` and is asserted against the parent row's `org_id` by a trigger.

### 7.1 Tables

```sql
-- ── Tenancy ────────────────────────────────────────────────────────────────
organizations(id uuid pk, name text, slug text unique, region text default 'in',
              settings jsonb, dpdp_consent_template text, retention_days int default 2555,
              created_at timestamptz)
org_members(org_id uuid fk, user_id uuid fk, role text check (role in
              ('owner','admin','staff','auditor')), primary key(org_id,user_id))

-- ── Form definition (admin-authored) ───────────────────────────────────────
forms(id uuid pk, org_id uuid fk, name text, slug text, status text
        check (status in ('draft','published','archived')), created_by uuid, created_at)
form_versions(id uuid pk, form_id uuid fk, version int, published_at timestamptz,
              schema jsonb,                    -- denormalised snapshot for reproducibility
              unique(form_id, version))
form_sections(id uuid pk, form_version_id uuid fk, title text, ordinal int)
form_fields(id uuid pk, form_version_id uuid fk, section_id uuid fk, field_key text,
            label text, label_hi text, kind text,   -- 17 types from spec §3.4
            required bool, options jsonb,           -- includes '__unreadable__'
            constraints jsonb,                      -- regex, min/max, date format
            is_critical bool default false,         -- forces review always
            photo_spec text,                        -- '35x45'|'25x35'|'51x51'|'custom'
            photo_w_mm numeric, photo_h_mm numeric,
            ordinal int, unique(form_version_id, field_key))

-- ── Template geometry (the learned layer) ──────────────────────────────────
template_versions(id uuid pk, form_version_id uuid fk, page_index int default 0,
  page_w_mm numeric default 210, page_h_mm numeric default 297, cts_dpi int default 200,
  blank_image_path text, blank_source text check (blank_source in
      ('admin_upload','filled_sample','consensus','none')),
  printed_mask_path text, anchor_atlas_path text,
  anchors jsonb,               -- [{id, cx_mm, cy_mm, atlas, health}]
  constellation jsonb,         -- [{text, cx_mm, cy_mm}]
  printed_rects jsonb, rulings jsonb,
  row_period_mm numeric,       -- periodicity autocorrelation peak, null if none
  maturity text check (maturity in ('cold','warm','strict')),
  n_registrations int default 0, mean_rmse numeric, is_synthetic bool,
  created_at timestamptz, unique(form_version_id, page_index))

template_fields(id uuid pk, template_version_id uuid fk, field_id uuid fk,
  kind text, box_mm jsonb,             -- {x,y,w,h} in CTS mm
  printed_box_mm jsonb, baseline_mm jsonb,
  search_pad_mm numeric default 8,
  prior jsonb,                          -- {mean:[cx,cy,w,h,theta], cov:[[..]], n}
  appearance_prior jsonb,               -- photo feature mean/cov
  geom_source text check (geom_source in ('admin','auto','learned')),
  n_corrections int default 0, learnable bool default true, version int)

-- ── Scans ──────────────────────────────────────────────────────────────────
scans(id uuid pk, org_id uuid fk, form_version_id uuid fk, template_version_id uuid,
  original_path text not null, original_sha256 text, original_bytes bigint,
  capture_tier text check (capture_tier in ('good','usable','degraded')),
  quality jsonb,                        -- client QualityReport
  status text check (status in ('queued','running','review','saved','failed')),
  lease_expires_at timestamptz, stage text, error jsonb,
  processed_by uuid, saved_by uuid, saved_at timestamptz,
  created_at timestamptz)

scan_geometry(scan_id uuid pk fk, template_version_id uuid,
  h_matrix float8[9], warp_model text, apap_cells jsonb,
  reg_trust text check (reg_trust in ('strict','loose','ambiguous','unregistered')),
  inliers int, inlier_ratio numeric, rmse numeric, p95_residual numeric,
  anchor_coverage numeric, chamfer numeric, constellation_hit numeric,
  periodicity_ambiguous bool, rotation_hypothesis int,
  effective_dpi numeric, stroke_growth_mm numeric, photocopy_generation text,
  paper_stats jsonb,                    -- σ_L, σ_C, σ_HF, varP85, MAD(Δ)
  quality_report jsonb)

scan_fields(id uuid pk, scan_id uuid fk, field_id uuid fk, field_key text,
  value text, value_native text,        -- Devanagari original
  verbatim text,                        -- exactly the ink, pre-normalisation
  is_empty bool, not_detected_reason text
      check (not_detected_reason in ('box_empty','below_threshold','geometry_unknown')),
  crop_path text, crop_display_path text, crop_alpha_path text,
  crop_quad_mm jsonb,                   -- 4 points in CTS mm — the audit record
  crop_out_dpi int, low_resolution bool,
  detector jsonb,                       -- every measured feature value
  reader jsonb,                         -- per-pass raw outputs, label_echo, models used
  features jsonb,                       -- the confidence feature vector
  conf_raw numeric, conf numeric, conf_band text,
  needs_review bool, review_reason text,
  edited_by_human bool default false, audited bool default false)

-- ── Learning + calibration ─────────────────────────────────────────────────
corrections(id uuid pk, org_id uuid, scan_id uuid fk, template_version_id uuid,
  field_id uuid, kind text check (kind in ('value','geometry')),
  before_value text, after_value text,
  before_quad_mm jsonb, after_quad_mm jsonb,
  interaction text check (interaction in ('drag','resize','type','one_click_accept')),
  reg_trust text,                        -- only 'strict' feeds geometry learning
  corrected_by uuid, created_at timestamptz)

audit_samples(id uuid pk, org_id uuid, scan_field_id uuid fk,
  selection text check (selection in ('blind_green','weekly_full','disagreement')),
  propensity numeric,                    -- for inverse-propensity weighting
  ground_truth text, ground_truth_quad_mm jsonb,
  adjudicated_by uuid, verdict text check (verdict in ('correct','incorrect','ambiguous')),
  created_at timestamptz)

calibrators(id uuid pk, org_id uuid null, field_kind text, scope text
      check (scope in ('global','org')),
  weights jsonb, isotonic_knots jsonb, n_audited int,
  ece numeric, ece_ci_low numeric, ece_ci_high numeric, brier numeric,
  tau_review numeric, display_mode text check (display_mode in ('buckets','provisional','numeric')),
  fitted_at timestamptz, promoted bool)

model_config(id uuid pk, org_id uuid null, role text, provider text, model_id text,
  params jsonb, weight numeric, enabled bool, updated_at timestamptz)

detector_events(id uuid pk, scan_id uuid fk, field_key text, element text,
  gate_clause_failed text, feature_snapshot jsonb, created_at timestamptz)
  -- powers "38% of Not Detected failed the still-looks-blank check"

anchor_health(template_version_id uuid, anchor_id text, window_start date,
  attempts int, inliers int, primary key(template_version_id, anchor_id, window_start))

consent_records(id uuid pk, org_id uuid, scan_id uuid, subject_ref text,
  consent_kind text, captured_by uuid, captured_at timestamptz, evidence_path text)
```

**Indexes:** `scans(org_id, created_at desc)`, `scans(status, lease_expires_at)` for the sweeper, `scan_fields(scan_id)`, `corrections(template_version_id, field_id, created_at desc)`, `audit_samples(org_id, created_at)`, `detector_events(scan_id)`.

**Reproducibility invariant.** `scan_geometry.h_matrix` + `scan_fields.crop_quad_mm` + the immutable original means **any crop can be re-derived from the archive at any future date at any DPI**. That is both the product requirement (permanent archive) and the audit requirement for a medical record.

### 7.2 Storage buckets

| Bucket | Public | Contents | Path | Lifecycle |
|---|---|---|---|---|
| `originals` | no | The unmodified capture. Immutable. | `{org}/{form}/{scan}/original.{ext}` | Retained per `retention_days`; never overwritten |
| `working` | no | CTS rectified page (lossless PNG), `INK` mask, `Δ` map, debug overlays | `{org}/{scan}/…` | **TTL 7 days**, then purged by cron. Lossless during processing because JPEG ringing destroys thin ink strokes and repeated compression passes compound the damage |
| `crops` | no | `photo_raw.png`, `photo_display.jpg`, `signature_alpha.png`, `signature_flat.png`, `thumb.png`, `field_{key}.png` | `{org}/{form}/{scan}/{field_key}/…` | With the record |
| `templates` | no | blank raster, printed mask, anchor atlas PNG + JSON, consensus blanks | `{org}/{template_version}/…` | With the template |
| `exports` | no | generated receipts / doctor views | `{org}/{scan}/…` | 30-day TTL |

Served **only** via short-TTL signed URLs (default 300 s). Storage RLS mirrors table RLS by path prefix.

**Storage cost is the sleeper.** At ~3 MB per scan of working artifacts, 1,000 scans/day is 3 GB/day. The 7-day TTL on `working` and re-encoding the display rectified page to WebP q90 is what keeps this bounded.

---

## 8. Module / file layout

> **Status.** This tree is the INTENDED end state and most of it does not exist. What does: `lib/vision/` (16 files), `lib/ink/` (`normalize.ts`, `paper-stats.ts`, `text-lines.ts`), `lib/regions/` (`photo.ts`, `signature.ts`, `thumb.ts`, `postprocess.ts`, `params.ts`, plus two this tree never anticipated — `form-presence.ts` and `template-anchors.ts`), `lib/geometry/frames.ts`, `lib/pipeline/extract-regions.ts`, `lib/templates/` (`types.ts`, `seed.ts`, and the taught-template pair `custom.ts` + `drawn.ts`), `lib/client/prepare-upload.ts`, `lib/reader/` (a module this tree never anticipated — the interim single-pass handwriting reader of Stage 9's status note: types, prompt, parse, crop, composite, provider, provider-types, groq, anthropic, read-text-fields, throttle), and in `app/`: `page.tsx`, `ScanWorkbench.tsx`, `TemplateEditor.tsx`, `api/extract/route.ts`. Everything else below — `lib/cv/`, `lib/registration/`, `lib/text/` (the full fusion engine; `lib/reader/` is its substituted interim), `lib/models/`, `lib/confidence/`, `lib/db|storage|auth|realtime/`, every admin and record route — is NOT BUILT. Note `lib/regions/edge-fit.ts` is SUBSTITUTED by `lib/vision/lines.ts`.

```
app/
  (marketing)/page.tsx
  (admin)/
    orgs/[orgId]/forms/page.tsx
    orgs/[orgId]/forms/[formId]/builder/page.tsx        # sections + 17 field types
    orgs/[orgId]/forms/[formId]/template/page.tsx       # blank upload + anchoring editor
    orgs/[orgId]/calibration/page.tsx                   # reliability diagram, ECE, drift
    orgs/[orgId]/insights/page.tsx                      # detector_events rollups
  f/[slug]/
    page.tsx                                            # published link landing
    capture/page.tsx                                    # camera + gallery + quality gate
    scan/[scanId]/page.tsx                              # processing (Realtime stages)
    scan/[scanId]/verify/page.tsx                       # split-screen verification
  r/[recordId]/doctor/page.tsx                          # hospital tenant views
  r/[recordId]/patient/page.tsx                         # printable receipt
  api/
    scans/route.ts                                      # POST create job
    scans/process/route.ts                              # worker entry (waitUntil)
    scans/[id]/route.ts
    scans/[id]/corrections/route.ts
    templates/[id]/anchor-assist/route.ts               # numbered-region VLM call
    cron/sweep/route.ts                                 # orphaned jobs
    cron/calibrate/route.ts                             # nightly refit
    cron/consensus/route.ts                             # consensus blank rebuild
    cron/retention/route.ts

lib/
  vision/            # ✅ EXISTS — pure TS primitives, browser+server isomorphic
    types.ts gray.ts integral.ts threshold.ts morphology.ts components.ts
    geometry.ts io.ts image-header.ts
    lab.ts  hf.ts  reconstruct.ts  chamfer.ts  thinning.ts        # 🔨 new
    cluster.ts  ssim.ts  hungarian.ts  stats.ts                   # 🔨 new
    warp-rgb.ts                                                   # 🔨 bicubic projective
  cv/
    opencv.ts        # thenable loader, module-scope cache, capability probe
    mat-bridge.ts    # sharp raw ⇄ cv.matFromImageData, Mat lifetime helpers (delete())
  registration/
    quad.ts  rotation.ts  anchors.ts  match.ts  homography.ts
    apap.ts  trust-gate.ts  constellation.ts  periodicity.ts
  ink/
    normalize.ts     # FLAT / TONE / HF / Δ
    paper-stats.ts   # THE self-normalisation source
    differential.ts  # component-wise INK
    stroke-growth.ts
  regions/
    photo.ts  signature.ts  thumb.ts
    edge-fit.ts      # step profile + RANSAC line + quad intersect
    fusion.ts        # Hungarian + the G1..G6 gate
    negative-control.ts
    postprocess.ts
    params.ts        # ★ every tunable constant, frozen, exported once
  text/
    crops.ts  gate.ts  read.ts  montage.ts  digits.ts
    normalize/{phone,date,bloodgroup,name,email,age,pincode,dropdown,doctor}.ts
    lexicon.ts       # roster / ICD snapping with hard distance floors
  models/
    provider.ts      # timeout, retry, circuit breaker, spend cap
    gemini.ts  claude.ts  azure-read.ts  textract.ts  groq.ts
    bbox/{gemini,qwen,claude}.ts        # ★ three adapters, three unit tests
    schema.ts        # zod → provider JSON schema
  confidence/
    features/{text,image}.ts
    logistic.ts  isotonic.ts  calibrate.ts  audit-sampler.ts  ece.ts
  templates/
    build.ts  anchor-mine.ts  consensus.ts  learn.ts  drift.ts
  db/  storage/  auth/  realtime/
  client/
    capture.ts  quality.ts  imagejs-adapter.ts  worker.ts
    slimsam.ts       # transformers.js, lazy, browser-only
    tesseract.ts     # lazy, admin editor only

scripts/
  synth/             # ★ synthetic form generator — see §10
    render-template.ts  handwriting.ts  signature.ts  thumb.ts  photo.ts
    degrade.ts       # perspective, curl, illumination, glare, blur, noise, jpeg,
                     # photocopy, whatsapp-recompress
    generate.ts      # emits image + exact ground-truth JSON sidecar
  tune.ts            # coordinate descent over params.ts, nested CV
  golden.ts          # nightly provider regression on labelled crops

tests/
  vision-*.test.ts   # ✅ EXISTS
  registration/  regions/  text/  confidence/  adapters/  e2e/
fixtures/
  synthetic/  real/  golden/
```

`next.config.ts`:
```ts
serverExternalPackages: ['sharp', '@techstark/opencv-js'],
outputFileTracingIncludes: {
  'app/api/scans/process/route': ['node_modules/@techstark/opencv-js/dist/**'],
},
```

---

## 9. Dependencies with justification

### Server (Vercel function)

| Package | Why | Notes |
|---|---|---|
| `sharp@^0.35` | Decode/encode, EXIF `autoOrient`, lanczos3 resize, `extract`, `clahe`, `linear`/`recomb`, `raw()` zero-copy bridge, SVG compositing for overlays | **Cannot do perspective warp.** `affine()` takes a 2×2 matrix; maintainer confirmed 4-point projection is unsupported (lovell/sharp#2095, open since Feb 2020). `trim()` is an edge-crop, not a blob detector — it cannot find a pasted photo. Already in Next's default `serverExternalPackages`. |
| `@techstark/opencv-js@5.0.0-release.1` | ORB (8-level pyramid), BFMatcher, `findHomography(RANSAC)`, `matchTemplate`, `warpPerspective`, `HoughLinesP`, `connectedComponentsWithStats`, `CLAHE`, `distanceTransform`, `inpaint`, `minAreaRect`, `approxPolyDP`, `morphologyEx` | Apache-2.0. **13.3 MB single JS, wasm base64-embedded — no separate `.wasm` for Next's tracer to miss.** Measured 153 ms init, 152 MB peak RSS, warpPerspective 56 ms @2000×1500. **5.x is a thenable: `const cv = await require(...)`.** No `imgcodecs`. SIFT/AKAZE/FLANN absent. |
| `@google/genai` | Gemini 3.5 Flash-Lite (primary reader), 3.7 Flash (cold-start, detection, Devanagari) | Separate credential from Groq. Server-side env var only. Detection calls: thinking off, native resolution, documented trigger phrasing. |
| `@anthropic-ai/sdk` | Decorrelated second reader, escalation, verification adjudication | Pre-resize with Anthropic's `resizedSize()`; `transformations: { oversized_image: 'error' }` on coordinate-bearing blocks. Images are ephemeral and not used for training — relevant for PII. |
| `@azure-rest/ai-document-intelligence` | `prebuilt-read`: per-word polygon + **calibrated confidence** + `isHandwritten` | The only externally calibrated text confidence in the system. Region Central India. Handwriting = 12 languages, **no Hindi**. |
| `@aws-sdk/client-textract` | `AnalyzeDocument` `FeatureTypes:['SIGNATURES']` | Purpose-built visual signature detector with real `Confidence`. **Script-agnostic** — works on Hindi forms despite English-only OCR. $3.50/1k pages. `ap-south-1`. |
| `@supabase/supabase-js`, `@supabase/ssr` | Postgres, Auth, RLS, Storage signed URLs, Realtime | Already in `package.json` |
| `zod`, `zod-to-json-schema` | Admin's dynamic field list → runtime schema → provider JSON schema. Constraint and validator can never drift apart | |
| `pdfjs-dist` (legacy Node build) | Render an admin blank-template PDF to a 300 dpi raster | Pure JS, no native dep |
| `date-fns` | Indian date formats with impossible-date rejection | |
| `fastest-levenshtein` | Option snapping, label matching, character alignment | |
| `p-limit` | Bound concurrent model calls and Storage uploads | |
| `groq-sdk` | **Optional, flag-off.** Low-stakes text fast path only | Documented reasons in §4.3 |

### Browser

| Package | Why |
|---|---|
| `image-js@^1.7` | **Pure TypeScript** `getPerspectiveWarp` (true homography via SVD) + `transform` (bilinear/bicubic). MIT. No wasm, **no COOP/COEP requirement**. Measured 70 ms perspective on 2000×1500. Avoid its `cannyEdgeDetector` (513 ms, 15× slower than OpenCV) — do edges on a downscaled proxy. **`{column,row}` not `{x,y}` — wrap it.** |
| `comlink` | Web Worker for the capture loop so the camera UI never janks |
| `exifr` | Orientation without a full decode, so the gate runs before heavy work |
| `heic-to` | iPhone HEIC → JPEG, removing any dependency on libheif in the Vercel sharp build |
| `idb-keyval` | Cache the anchor atlas + template geometry for instant repeat scans |
| `tesseract.js@^7` | **Admin template editor only, lazy.** Printed label word boxes + confidence. 2.73 MB core + 2.95 MB eng data, IndexedDB-cached. `corePath` must point at a **directory**. `blocks: true` required. Never handwriting; never on Vercel. |
| `@huggingface/transformers` + `Xenova/slimsam-77-uniform` | **Optional Tier-2 photo refiner, lazy, agreement-only.** Apache-2.0, 13.2 MB quantised. |

### Explicitly rejected, with reasons

| Rejected | Reason |
|---|---|
| `opencv-wasm` | Last published **2022-05-12**, pinned to OpenCV 4.3.0. Abandoned. |
| `@u4/opencv4nodejs` | Requires `node-gyp` + compiling OpenCV at install. No prebuilt linux-x64 path survives Vercel's build container. |
| `jscanify` | 30.4 MB unpacked (≈20 MB of demo images), vendors a stale 9 MB OpenCV 4.x, hard-depends on native `canvas` + `jsdom`. Worse, its corner extraction uses **`minAreaRect`** — a rotated *rectangle* — which structurally **cannot represent perspective foreshortening**, i.e. our dominant input condition. It also Cannys before blurring. Reimplement its ~120 lines with `approxPolyDP` to a true quad. |
| `tech4humans/yolov8s-signature-detector` | Best-performing signature model (mAP@50 94.5 %) but **AGPL-3.0** via Ultralytics; §13 network copyleft is fatal for hosted SaaS. Licence-safe alternative if ever needed: `mdefrance/yolos-tiny-signature-detection` (Apache-2.0, ~7–9 MB after Optimum ONNX export + quantisation). Not needed in v1 — Textract covers it. |
| DocLayout-YOLO / Armaggheddon YOLO weights | Model cards say Apache/MIT; upstream repos are AGPL-3.0 Ultralytics derivatives. An Apache tag does not launder an AGPL derivative. Needs legal review before any use. |
| `@imgly/background-removal-node`, `briaai/RMBG-*` | AGPL-3.0 and a proprietary Bria licence respectively. Also the wrong tool: these are *salient-object matting* models; ink isolation is illumination-corrected local binarisation. |
| `onnxruntime-node` (server) | 296 MB tarball; needs `--arch=x64 --platform=linux` at build plus surgical `outputFileTracingIncludes`; documented failure `libonnxruntime.so.1: cannot open shared object file`. Prefer `onnxruntime-web` if server ONNX is ever needed. (Vercel's Large Functions beta allows 5 GB bundles with `VERCEL_SUPPORT_LARGE_FUNCTIONS=1`, which removes the size objection but not the fragility.) |
| `wasm-vips` | Kept **in reserve**, server-side only, for one job nothing else in JS can do: nonlinear dewarp of curved paper via `mapim()`. Not in v1. In the browser it needs SharedArrayBuffer ⇒ COOP/COEP cross-origin isolation, which would break Supabase Storage image loads and third-party scripts. README still says "under early development". |
| `moondream`, OpenRouter/Qwen | US-hosted / arbitrary third-party routing of handwritten patient names, blood groups and diagnoses. Fails DPDP §11. |

---

## 10. Test strategy

### 10.1 The core insight

The single biggest failure mode of all three candidate designs was ~40–50 hand-set constants with no derivation and a labelled corpus that does not exist. And the research is explicit that synthetic *text* renders are useless for discrimination: on clean rendered Devanagari, all ten evaluated systems cluster at chrF++ 91–98; on real scans they spread across 76 points.

**But that critique applies to model accuracy, not to geometry.** For geometry, a synthetic generator is the highest-leverage tool available, because it produces **pixel-exact ground truth homographies, quads and ink masks for free, in unlimited quantity, across every degradation axis**. So:

> **Geometry is validated on synthetic data with exact ground truth. Reading accuracy is validated only on real forms. Thresholds are tuned on synthetic + a 60 % real split and gated on a held-out 40 % real split.**

### 10.2 The synthetic form generator (`scripts/synth/`) — a required Phase-1 deliverable

**Render a blank template.** Parameterised SVG → PNG at 300 dpi. Knobs: page size, number of sections, field count, label language (en / hi / mixed), ruled-line vs boxed-field style, presence of a character-grid field, **row pitch** (to generate the repetitive-layout adversarial case), logo, table blocks, an "Affix Photo" box of the declared size, a signature rule, a thumb box.

**Synthesise content.**
- *Handwriting*: a stroke-path renderer with per-character jitter (baseline drift, slant, pressure→width, ligature noise), driven by a set of Latin and Devanagari stroke templates. Real names from a public Indian name list. **Deliberately not used for model accuracy claims** — only for ink-map, blank-gate, digit-segmentation and grouping tests, where the *statistics* matter and the letterforms do not.
- *Signature*: composed Bézier flourishes with controlled turning-angle statistics, stroke-width CV and fragment counts; rendered with configurable overlap onto the printed rule and into adjacent text.
- *Thumb*: elliptical blobs with parameterised fill, smear kernel and a synthetic ridge field (used to prove the v1 detector ignores ridges and to build the v1.2 gate later).
- *Photo*: composited from a bank of licensed/CC stock portraits **and** synthetic ones, with the critical adversarial variants — white backdrop on white paper, pale-blue backdrop, greyscale photocopy of a photo, crooked ±15°, overlapping the printed border, with staples, with a hand-drawn ink border, with a tape glare band.

**Degradation chain (composable, seeded, each with recorded parameters):**
`perspective(H)` → `pageCurl(cylindrical/creased remap)` → `illuminationField(low-order polynomial)` → `glareHotspot(gaussian, position)` → `shadow(hand/phone silhouette)` → `motionBlur(kernel, angle)` → `sensorNoise(ISO model)` → `jpeg(q ∈ {95,85,70,55})` → `photocopy(gamma + speckle + stroke dilation by n generations)` → `whatsappRecompress(scale to 1 MP + chroma subsample + q65)` → `rotate90/180/270`.

**Sidecar JSON:** exact `H`, exact photo quad, exact signature ink mask, exact thumb mask, per-field value strings, per-field ink area in mm², degradation parameters. **Zero labelling cost.**

**This makes every geometric claim in this document falsifiable before launch** — which is exactly what all three judges said was missing.

### 10.3 Real fixture corpus

200–300 real photographs of real filled forms, ~12 template families × conditions (clean flatbed, phone flat, phone skewed, phone shadow, phone glare, photocopy, creased, 2-up, WhatsApp-forwarded, partially-cropped page, low light). Each with a JSON sidecar.

**Labelling protocol — precisely specified, because the metric definition was self-refuting in two designs:**
- **Photograph:** label the **four corners of the photo's physical boundary** as a quad. Metric: quad IoU. Not "a box a human drew loosely around it."
- **Signature / thumb:** label an **ink mask** (paint tool). Metric: *"contains ≥ 98 % of labelled ink AND excess area ≤ 25 % of the labelled ink's bounding box"* — because signature boundaries are inherently fuzzy and IoU against a padded human box would score a correctly-tight crop as a failure.
- **Text:** exact ground-truth strings, double-entered by two labellers, disagreements adjudicated.
- **Absence:** explicitly labelled `absent` vs `present` per image element, so false-negative rate is measurable.

Consent and de-identification obtained before any real form enters the corpus. Corpus is stored encrypted, access-logged, and **never sent to a third-party API during testing** except through the same redaction path as production.

### 10.4 What is testable without any real form

| Component | Test |
|---|---|
| All `lib/vision` primitives | ✅ already tested; extend with property tests (idempotence of open/close, DT triangle inequality, thinning preserves connectivity) |
| Homography estimation, warp | Round-trip: known `H` → warp → recover → residual < 0.05 px |
| **Registration end-to-end** | Synthetic: apply a known `H` + full degradation chain, recover, assert RMSE and that the trust gate returns the right state |
| **Row-shift adversarial** | Synthetic repetitive-pitch template; feed a deliberately row-shifted `H`; **assert the constellation check and periodicity test both fire** |
| Photo edge fit | Synthetic photo at known quad under all adversarial variants; assert quad IoU ≥ 0.95 on clean, ≥ 0.85 on degraded |
| White-on-white photo | Synthetic white backdrop on white paper; assert the `HF` channel carries the detection |
| Differential ink | Synthetic: exact known handwriting mask; assert `INK` recall ≥ 0.95 and that strokes **along** the rule survive (the specific regression that killed the naive AND-NOT) |
| Photocopy stroke growth | 1–5 generation synthetic photocopy; assert `Δsw` measured within 20 % and `INK` precision holds |
| Blank-field gate | Synthetic single-digit answers; **assert "Age: 5" is not declared blank** |
| Signature grouping | Synthetic signature adjacent to a date at controlled gaps; assert no merge at ≥ 4 mm, defined behaviour on cap breach |
| **BBox adapters** | Synthetic image with a rectangle at a known position; one test per convention (Gemini yxyx, Qwen xyxy, Claude absolute-px). Non-negotiable |
| SSIM gate | Two synthetic flat white patches → assert `bothFlat` returns, not a random NCC value |
| Hungarian assignment | Constructed cost matrices incl. the "one blob wins two classes" case |
| Normalisers | Table-driven: ~400 cases across phone / date / blood group / age-DOB / email / enum floors |
| **Enum refusal** | Assert `__unreadable__` survives the schema and does **not** receive a validator bonus |
| **Label echo** | Mutate a montage index; assert the mismatch forces review |
| Isotonic + logistic | Known monotone generators; ECE bootstrap CI width sanity |
| Model layer | Recorded-fixture replay (no network in CI); malformed-JSON, refusal, timeout and 429 paths |
| Storage/RLS | pgTAP: cross-org read attempts must fail on every table and every bucket prefix |

### 10.5 CI gates

Run on synthetic (every commit) and on the held-out **40 % real split** (nightly + pre-release):

```
registration: strict-rate ≥ 0.90 phone / ≥ 0.99 flatbed ; p95 RMSE ≤ 3.0 CTS px
              row-shift adversarial detection rate = 1.00     ← hard gate
photo:        quad IoU@0.85 ≥ 0.92 ; FALSE-CROP RATE ≤ 0.005  ← hard gate
signature:    ink-containment metric ≥ 0.88 ; false-crop ≤ 0.010
thumb:        presence F1 ≥ 0.85 (no crop-accuracy gate in v1)
not-detected: false-crop rate over the whole corpus ≤ 0.01    ← the product rule
text:         per-type CER/exact-match budgets, no regression > 2 points
calibration:  ECE ≤ 0.08 with bootstrap CI on the audited set
golden:       nightly provider regression on 200 labelled field crops;
              refuse to promote a deploy where per-field exact-match drops > 3 points
```

**Golden-image tests** hash output crop bytes so any change to the CV stack surfaces as a visual diff in review.

### 10.6 Tuning without overfitting

- **Every threshold lives in one frozen exported object: `lib/regions/params.ts`.**
- Most thresholds are **self-normalised** (expressed against paper statistics measured in the same scan) and therefore are **not tunable** — they are structural. That is deliberate, and it is what shrinks the tuning surface from ~50 constants to **14**.
- The 14 tunable constants: `photo.contentThreshold`, `photo.edgeInlierMin`, `photo.edgeResponseSigma`, `photo.covFracMin`, `sig.scoreThreshold`, `sig.gapMM`, `sig.solidityBand[2]`, `thumb.scoreThreshold`, `ink.covDropThreshold`, `blank.inkAreaMM2[2]`, `trust.chamferMin`, `trust.constellationMin`.
- `npm run tune

`npm run tune` runs coordinate descent over exactly those 14 against the **synthetic corpus plus the 60 % real training split**, and prints the Pareto front of false-accept versus false-reject. Gating happens on the untouched 40 % real split. Nested cross-validation on the training split guards against the failure the judges named: coordinate descent over 50 coupled thresholds against 300 samples passes CI and disappoints in production. Fourteen loosely-coupled constants against thousands of synthetic samples plus 180 real ones is a defensible ratio.

- A tuning run that improves the training split but degrades the held-out split by more than 1 point is **rejected automatically** and the previous params ship.

---

## 11. Build order

> **Status.** Phases 0-2 are NOT complete as written — there is no Supabase project, no job runner, no OpenCV.js, no anchor atlas or homography refit. Phase 1's synthetic generator IS built ([`tests/helpers/synthetic-form.ts`](../tests/helpers/synthetic-form.ts)), though as a single module rather than `scripts/synth/*`. **Phase 3 is substantially complete and is what the product currently is** — photo, signature and thumb detection, the params, the three absence reasons, 236 tests. Phase 4 (text extraction) has its interim substitute: the single-pass reader of Stage 9's status note reads every declared text field behind an optional API key, always for review — the fusion, validation and confidence machinery this phase actually specifies is NOT started. Phase 5's verify screen IS built with editable text values (edits live only on the screen — nothing persists), and its correction-capture half ships as the taught-template editor rather than as drag-to-correct plus a learning loop.

Each phase produces something demonstrable to a non-engineer. No phase is longer than roughly three weeks. Nothing depends on a corpus that does not yet exist.

### Phase 0 — Foundations (≈1 week)

**Ship:** `npm run typecheck && npm test` green; a deployed preview at `bom1` that decodes an uploaded image and echoes its dimensions, EXIF orientation and a quality report.

- Supabase project, all tables from §7 with RLS, pgTAP cross-org denial tests.
- Storage buckets + signed-upload flow + the 4.5 MB-bypass path (browser → Storage → JSON job).
- `vercel.json` (`bom1`, `maxDuration 300`, `memory 4096`, Fluid + Active CPU).
- Job runner: route handler + `waitUntil` + `pg_cron` lease sweeper. Realtime stage streaming.
- `lib/cv/opencv.ts` thenable loader + capability probe, deployed and verified on a real preview build (the one integration the research flagged as unverified on Vercel). Log `cv.getBuildInformation()` and the presence/absence of every symbol §3 depends on.

**Demo:** upload a photo from a phone, watch stage names stream, see a JSON quality report.

### Phase 1 — Synthetic generator + geometry ground truth (≈2 weeks)

**Ship:** `npm run fixtures -- --n 2000` producing images + exact sidecars, and a test suite that already fails meaningfully.

- `scripts/synth/*` per §10.2, including the repetitive-pitch adversarial template and all photo adversarial variants.
- The 22 new pure-TS primitives from §3.5 with unit tests.
- The three bbox adapters with their synthetic-rectangle tests.

**Demo:** a contact sheet of 40 generated forms across the degradation axes, side by side with their ground-truth overlays. This is the artifact that makes every later accuracy claim checkable.

### Phase 2 — Registration and trust (≈2–3 weeks)

**Ship:** given a synthetic or real scan and a template, a correct `H`, a trust verdict, and a rendered overlay proving alignment.

- Quad detection + four cyclic corner orderings + rotation resolution.
- Anchor mining, atlas pack, `matchTemplate` coarse-to-fine, RANSAC homography, DLT refit.
- ORB content-registration fallback (8 pyramid levels).
- Moran's I → APAP upgrade.
- All four trust families including the **constellation check** and the **periodicity ambiguity test**.
- CI gate: **row-shift adversarial detection rate = 1.00.**

**Demo:** a skewed, shadowed, creased phone photo of a synthetic form, with the template's printed layer overlaid in magenta landing on the printed ink to within a pixel — and a deliberately row-shifted case being caught and refused.

### Phase 3 — Ink, photo, signature (≈3 weeks) — **the product**

**Ship:** correct crops.

- `paper-stats.ts` (the self-normalisation source), `FLAT`/`TONE`/`HF`/`Δ`, stroke-growth measurement.
- Component-wise `INK` + rule reconstruction.
- Photo: edge step profile → RANSAC lines → quad → content acceptance → post-processing → 413×531 output.
- Signature: complete-link grouping → feature scoring → ink-on-transparent PNG.
- Thumb: v1 blob detector, capped confidence.
- Fusion: Hungarian + the G1–G6 gate + three absence reasons + `detector_events` telemetry.
- CI gates: photo quad IoU@0.85 ≥ 0.92 and **false-crop ≤ 0.005** on synthetic.

**Demo:** the money shot. A phone photo of a filled form on the left; on the right, a pixel-tight deskewed passport photo, a signature as ink-on-transparent PNG composited onto a letterhead, and a thumb crop — plus one deliberately empty form producing three high-confidence `Not Detected` results with the box-empty reason. **This is the demo that sells the product**, and it needs no model call at all.

### Phase 4 — Text extraction (≈2 weeks)

**Ship:** filled fields with `verbatim`/`value`, validated and normalised.

- Field crops (single decode, single resample), blank/checkbox CV gating with the mm² floor.
- Azure `prebuilt-read` integration (word polygons, confidence, `isHandwritten`).
- Gemini Flash-Lite per-field reads with the anti-fabrication prompt, `label_echo`, and zod→JSON-schema.
- Claude decorrelated pass on critical fields; escalation; digit-wise pass.
- All normalisers with the `__unreadable__` enum member and hard lexicon distance floors.
- Ink cross-check (hallucination + miss detectors).

**Demo:** a 15-field hospital form filled in by hand, digitised, with two deliberately illegible fields correctly reporting review-required rather than plausible fabrications.

### Phase 5 — Verification UI and correction capture (≈2 weeks)

**Ship:** the split screen, and the loop closing.

- Left pane with overlays and click-to-zoom; right pane editable form.
- Red fields render empty and focused with inline crops. Safety-critical always review.
- Crop drag/rotate handle writing `after_quad_mm` in CTS.
- Three-reason `Not Detected` chips with the true-negative/false-negative distinction.
- Per-character underlining; candidate chips on disagreement.
- `corrections` written with `interaction` type (drag vs one-click).

**Demo:** a full operator run — scan, verify, correct one crop, save — in under 40 seconds, with the correction visibly persisted in CTS millimetres.

### Phase 6 — Template learning and Textract (≈2 weeks)

**Ship:** measurable improvement between scan 1 and scan 15 of the same form.

- Blank-template upload + auto-anchoring assist (Hough + `extractRules` + browser Tesseract + the numbered-region VLM call) + publish-time validation.
- AWS Textract `SIGNATURES` integration and the four-quadrant cross-check table.
- Geometry learning from `STRICT` drags only, with the bias detector; anchor health; search-pad growth.
- Consensus blank by **occupancy ≥ 0.80 over N ≥ 9**, with image-ROI exclusion and the learnability check.
- Drift detection and v2 offer.

**Demo:** a chart of RMSE and manual-correction count over the first 20 scans of one form, dropping monotonically; and an org that never uploaded a blank template graduating to STRICT automatically.

### Phase 7 — Confidence, audit and calibration (≈2 weeks)

**Ship:** numbers that mean something, or honest buckets.

- Feature extraction for text and image fields.
- Logistic IRLS + PAVA isotonic; hierarchical pooling with per-org shrinkage.
- **Blind audit sampler (3 % of would-be-green) and the weekly full-audit form.**
- ECE with bootstrap CI, reliability diagram, automatic reversion to buckets above 0.08.
- τ derived from the curve per field kind.

**Demo:** the admin calibration page showing a reliability diagram and the sentence *"87 % means 87 out of 100 audited fields scoring like this were correct"* — with the buckets still showing for field kinds that have not earned a number.

### Phase 8 — Tenant surfaces, compliance, hardening (≈2 weeks)

- Doctor View / Patient View / printable receipt + QR (spec §2.6).
- Real fixture corpus collection begins **in parallel from Phase 3 onward** — it is a background activity, not a blocker.
- `npm run tune` nested CV on the real split; ship measured constants.
- DPDP: consent capture, retention jobs, redaction-before-third-party, DPA status per vendor, access logging, deletion.
- Per-org spend caps, circuit breakers, degradation matrix, nightly golden-set provider regression.

### Cost and latency budget (targets, tracked from Phase 4)

| Item | p50 | Notes |
|---|---|---|
| Client capture + gate | 0.3 s | free |
| Upload (2–6 MB, 4G, bom1) | 2–5 s | direct to Storage |
| Decode + pyramid | 0.4 s | single decode |
| OpenCV init | 0.3 s cold / 0 s warm | module-scope cache |
| Registration + trust | 0.9 s | |
| Azure Read ∥ Textract | 1.5–3 s | parallel |
| Ink + 3 region detectors | 1.2 s | |
| Field reads (15 fields, p-limit 6) | 3–6 s | Flash-Lite, small crops |
| Critical second pass (6 fields) | 1.5–3 s | Claude |
| Crops + encode + upload | 0.8 s | |
| **End to end** | **10–16 s p50, 25–35 s p90** | Not "seconds". Stated honestly on the processing screen with real stage names. |

**Cost per scan:** Azure Read $0.0015 + Textract SIGNATURES $0.0035 + Gemini Flash-Lite ~$0.005 + Claude critical pass ~$0.010 ≈ **$0.02**, rising to ~$0.06 with full escalation on a bad scan, falling to ~$0.012 once a template is mature (Textract dropped when local score is high). At 1,000 scans/day that is **$20–40/day**, plus Vercel Active CPU (~5 CPU-seconds/scan) and Storage. The earlier candidate estimates of $0.115 were 3–5× optimistic; these are computed from the actual call list.

---

## 12. Honest accuracy expectations and known limits

### 12.1 Status of these numbers

**These are engineering targets derived from the algorithms' operating characteristics. They are not measurements.** No published benchmark exists for handwritten Indian names on forms, or for passport-photo/signature crop accuracy on Indian paper forms. Phase 1's synthetic corpus replaces the geometric numbers with measurements in week 3; the real corpus replaces the reading numbers by roughly week 12. **None of these should be quoted to a customer before then.**

### 12.2 Geometry (mature template, STRICT registration)

| Element | Metric | Target | Weak class |
|---|---|---|---|
| Registration | STRICT rate, phone photos passing the gate | 90–95 % | Sharp creases through an image box; no visible page edge on a white desk |
| Registration | p95 residual | ≤ 3 CTS px (0.38 mm) | |
| **Photograph** | quad IoU ≥ 0.90 vs labelled physical boundary | **93–96 %** | Photocopy of a photo: 82–90 %. White-on-white recovered by the `HF` channel but ~4 % still fail |
| Photograph | **false-crop rate** | **≤ 0.5 %** | This is the number that matters, and it is the one the gate optimises |
| **Signature** | ink-containment ≥ 98 % and excess ≤ 25 % | **90–94 %** | Signature written across a printed terms paragraph |
| Signature | presence/absence | 96–98 % | `INK` hands us the ink on a clean background — this is the easy part |
| **Thumb** | presence/absence | 88–92 % | Crop quality not gated in v1; always review |
| Cold start (scan 1–3) | photo usable | 78–86 % | Textract carries signature; photo leans on printed-box priors |

### 12.3 Text (mature template, per-field exact match after normalisation)

| Field type | Target | Note |
|---|---|---|
| Checkbox / radio | **> 99 %** | Pure CV, no model, zero cost |
| Blood group | 95–98 % | **Always review regardless.** `B+` vs `B−` is one short stroke a photocopy loses, and two passes will agree on the wrong one |
| Dropdown / enum | 96–99 % | Classification, not generation — but only because `__unreadable__` exists |
| Phone (all 10 digits) | 92–96 % | With the digit-wise pass and `^[6-9]\d{9}$`. Almost every remaining error is *caught* by the validator and surfaces as review-required rather than silent wrong data. Without the pattern rule and digit segmentation this drops to ~78 % |
| Date | 92–96 % | `DD/MM` vs `MM/DD` when both ≤ 12 is the residual |
| Age / number | 95–98 % | Cross-validated against DOB |
| Clear Indian names | 86–92 % exact; ~93 % under "first and last both correct" | Human transcriber ≈ 97 % |
| Doctor (with roster) | 92–96 % | **~80 % without a roster.** The single highest-ROI configuration ask |
| Email (handwritten) | 78–86 % | Long, case-sensitive, no useful prior, no lexicon. It will not get much better |
| Free-text disease/complaint | 60–78 % exact; ~88 % with a per-org lexicon snap | Doctor handwriting plus open vocabulary. **This number is bad and we state it in the sales conversation, not in the post-mortem** |
| **Handwritten Devanagari** | **55–72 %** | **Always review.** No document-AI vendor supports handwritten Devanagari at all — Azure's 12 handwriting languages exclude Hindi, Textract handwriting is English-only. Frontier VLM numbers of chrF++ 86.3 (Gemini) / 82.2 (Claude) are for **printed** Devanagari on real scans and are an optimistic upper bound. We digitise Hindi forms *with human assistance*; we do not automate them |

### 12.4 The number that actually matters

**Fraction of scans requiring zero corrections: realistically 45–60 % for a 15-field hospital form on a mature template with a good capture.** Anyone quoting 90 % no-touch on handwritten Indian paper forms is measuring on clean synthetic data or lying.

**The defensible claim is: 3–4 minutes of typing becomes 20–40 seconds of checking — a 6–10× throughput win, with the original form archived and every field auditable and re-derivable.** That claim survives contact with a real hospital. "95 % accurate" does not.

### 12.5 Known limits, stated plainly

1. **The first scan of a brand-new form has no template**, so it falls back to roughly what a plain VLM pipeline would do, plus the latency of having tried. For a genuinely one-off form this architecture offers nothing. The bet is that organisations scan the same layout hundreds of times.
2. **Ridge-based thumb verification is not in v1.** Over-inked stamp-pad impressions have no resolvable ridges at any DPI, phone ISPs destroy the 0.4–0.6 mm band, and JPEG 8×8 blocking sits adjacent to it. Thumb crops are presence-detected and always human-confirmed. **Accepted risk.**
3. **Handwritten Devanagari is a human-assisted path, permanently, until a vendor ships handwritten Indic support.** No amount of architecture fixes this.
4. **Genuinely illegible handwriting** — doctor-written disease and medicine names being canonical — is not solvable. The honest answer is the review screen, and per-org lexicon snapping is the only real lever.
5. **An element drawn entirely outside its ROI** (staff signed in the wrong box) is reported `Not Detected`. We search `ROI ⊕ pad`, not the page, because page-wide search materially raises false accepts. This surfaces a genuine human error rather than hiding it. **Deliberate trade.**
6. **A field genuinely relocated in a reprint** can register successfully and crop confidently wrong. Mitigated by drift monitoring on trailing RMSE/chamfer/constellation, and by per-field ink sanity (a box that suddenly has zero ink across many scans signals relocation). **This is the most dangerous residual risk in any registration-first design, and drift monitoring is therefore not optional.**
7. **A sharp crease running through a photo or signature box** produces a locally torn warp that neither the homography nor APAP fixes. p95 residual catches most and routes to LOOSE or UNREGISTERED.
8. **Address and long-text overflow** below its box is truncated. Learned `search_pad_mm` grows habitually-overflowed boxes; a one-off spill is surfaced as an "unassigned ink" warning but never auto-assigned.
9. **Pre-printed character-grid fields** (Aadhaar/bank style) are handled by the generic path, suboptimally. Given a dedicated path — detect the grid from the template, segment each cell deterministically, read isolated characters — they would reach ~99 %. Flagged as a v1.1 win, not shipped in v1.
10. **Model provider drift is real.** Groq removed preview models from the rate card without warning; Gemini's segmentation behaviour has changed between generations; Gemini 3.7/3.6 pricing doubles on 2027-01-01. Model IDs and weights live in the database, a boot-time capability probe runs on every deploy, and a nightly golden-set regression refuses to promote a deploy that drops more than 3 points. That is operational discipline, not an architectural guarantee.
11. **PHI leaves India on every third-party call.** Azure Central India and AWS `ap-south-1` are in-region; Gemini must be pinned to `asia-south1` via Vertex and Anthropic to an India inference geo where available. Consent capture, retention limits, redaction before third-party calls, DPAs and access logging are Phase-8 deliverables and are **procurement blockers for hospital deployment, not nice-to-haves**. Thumb impressions are biometric data under DPDP 2023 and are treated as the most sensitive class in the system.

---

## 13. Judge-raised fatal flaws — resolution register

Every flaw, and where it is resolved. Six are accepted risks, stated as such.

| # | Flaw | Resolution | §
|---|---|---|---|
| D1-1 | Silent one-row-shift homography passes every geometric gate | **Semantic constellation check** (≥70 % of known printed labels within 3 mm) + **periodicity ambiguity test** (re-evaluate chamfer at ±row-pitch; within 8 % ⇒ AMBIGUOUS ⇒ one-tap operator landmark) | 2.5 |
| D1-2 | Photocopy stroke thickening breaks `Fg`; label halos flood it | **Measured** stroke growth `Δsw` per scan; `r_adapt = 0.15 mm + rmse + Δsw`; **component-wise** subtraction, not pixel-wise | 2.7 |
| D1-3 | Fractional blank gate deletes single-character answers | Absolute **mm²** floor (`< 2.0 mm²` blank, `2.0–6.0` ambiguous→model+review) | 4.2 |
| D1-4 | Enum coercion removes refusal and is then rewarded by the validator | Mandatory **`__unreadable__`** enum member; validator bonus only when `verbatim` matched pre-snap; **hard distance floors** on every lexicon snap | 4.6 |
| D1-5 | Composite index misattribution unguarded | Mandatory **`label_echo`** in the schema, compared against the known printed label; single-column montages only; montage banned for critical fields | 4.4/4.5 |
| D1-6 | `Dmap` photometrically undefined | Explicit `FLAT`/`TONE` split; **per-tile robust gain/offset matching**; threshold at `4×MAD(Δ_paper)` measured in-scan | 2.7 |
| D1-7 | Consensus blank poisons image ROIs (people write in the same place) | **Occupancy ≥ 0.80** not median; **N ≥ 9**; **image/answer ROIs excluded** from occupancy-derived printed mask; per-ROI learnability check | 6.4 |
| D1-8 | One-click accept of a bad crop raises its own future confidence | One-click accept **does not update the prior**; only drag/resize does; `interaction` recorded; drift monitor on prior mean | 6.5 |
| D1-9 | Calibration on "saved unedited" measures diligence | **3 % blind audit sample** + weekly full-audit form; calibration fitted on audited labels with inverse-propensity weighting | 5.3 |
| D1-10 | Latency 2–4× understated; integral-image rules self-contradictory | Single decode into a 36 MB buffer held for the job; CTS integrals explicitly budgeted (300 MB peak of 4 GB); realistic p50/p90 table published | 2.2 / 11 |
| D1-11 | Thumb ridge analysis dead on phone captures | **Descoped from v1.** Blob + geometry + chroma, capped 0.70, always review. v1.2 gated on ≥350 dpi with a JPEG-8px notch and may only raise confidence | 3.3 |
| D1-12 | Signature area cap has undefined behaviour | Defined: keep sub-cluster nearest the baseline anchor, drop the rest, `reason='adjacent_content_excluded'`, force review | 3.2 |
| D1-13 | 3,500-line CV library and 50 constants are fantasy-scheduled | **Adopt `@techstark/opencv-js`** (13.3 MB, 153 ms init, measured); 22 new pure-TS functions on top of the 2,160 tested lines existing at planning time; **14** tunable constants (rest self-normalised); synthetic generator supplies unlimited exact-ground-truth data. (Since overtaken: most of those functions shipped in pure TS and OpenCV.js was never adopted — see §3.5.) | 3.5 / 9 / 10 |
| D1-14 | Client/server crop agreement is not independent evidence | **Removed from the confidence expression.** Diagnostic log only | 5.2 |
| D1-15 | `skinFrac` contaminated by cream paper under tungsten | **Feature deleted.** Replaced by `chromaClusterCount` + `toneSpread`. Also removes the person-identification prompt hazard | 3.1 |
| D2-1 | Rotation resolved by rotating an already-squashed raster | **Four cyclic corner orderings of the quad**, each yielding its own `H₀` | 2.3 |
| D2-2 | ORB bootstrap has no scale pyramid | OpenCV ORB, `nlevels=8`, `scaleFactor=1.2` | 2.4 |
| D2-3 | Partially-cropped page is modal and routes to the broken path | **Content registration (Path B) needs no page border.** Client gate warns, never blocks above 110 dpi. Gallery/WhatsApp uploads are first-class | 2.0 / 2.3 |
| D2-4 | Ink dilation erases handwriting written *on* the rule | Component-wise subtraction + `extractRules` + **morphological reconstruction** to reconnect crossing strokes | 2.7 |
| D2-5 | Emptiness assertion compares to the template's noise floor and never fires | Compared to **the scan's own paper-patch variance p85** | 3.1 |
| D2-6 | Photo detector fails on white backdrop / white paper | **Boundary-first** detection with an `HF` paper-texture channel; appearance is acceptance-only | 3.1 |
| D2-7 | Gabor ridge test below Nyquist for the stated capture path | Descoped (see D1-11) | 3.3 |
| D2-8 | No job runner named | `waitUntil` + `pg_cron` lease sweeper; `maxDuration 300`, `memory 4096`, `bom1` | 2.1 |
| D2-9 | Per-field crop re-decodes the JPEG 25× | **One decode**, buffer held for the job | 2.2 |
| D2-10 | OpenCV rejection asserted, not evaluated | Evaluated against the measured research and **overturned** | 9 |
| D2-11 | Latency understated | Budget table with p50/p90 | 11 |
| D2-12 | Montage reintroduces swapping | Budget mode only, single column, `label_echo` + index must agree, never for critical fields | 4.5 |
| D2-13 | Blood group has no safety treatment | **Never renders green at any confidence.** Always review, always shows evidence crop. Same for name, phone, doctor, drug/dose, allergy, IDs | 5.4 |
| D2-14 | Self-consistency weighted highest but weakest on handwriting | Decorrelation by **preprocessing + model family**, not temperature; same-model repeats excluded from `p_agree` | 4.5 |
| D2-15 | Client gate hard-blocks with no escape | Blocks only below 110 dpi; "Upload anyway" with `capture_tier` penalty | 2.0 |
| D2-16 | Sharpness threshold is content-dependent | Normalised against the template's own printed-text Laplacian statistic | 2.0 |
| D2-17 | Level-2 search radius sits exactly at the `H₀` error bound | Widened to ±16 at ¼ res, 3 levels, with ORB fallback | 2.4 |
| D2-18 | No test-data plan; magic numbers unjustifiable | Synthetic generator as a **Phase-1 deliverable** with exact ground truth; 14 tunable constants; nested CV; held-out real split | 10 |
| D2-19 | Biometric/health compliance absent | Dedicated limits entry + Phase-8 deliverables: consent, residency, retention, redaction, DPA, access logging | 12.5 / 11 |
| D2-20 | Feedback loop launders a biased homography | Geometry learning **only from STRICT**; **signed-residual bias detector** (`|mean| > 0.6×MAD` ⇒ flag, do not apply) | 6.5 |
| D3-1 | Flat-field kernel destroys the contrast the photo test measures | **Kernel radius ≥ 1.5× the largest image field**; separate `TONE` image for tone features | 2.7 |
| D3-2 | Gemini `mask` treated as a tighter polygon | Documented correctly as a base64 PNG probability map **inside** `box_2d`; decoded if used | 3.4 |
| D3-3 | Kalman fusion discards the prior when MAD = 0 | Cold path only; `σ_ens` floored at 0.5 % of page dimension; cluster size ≥ 3 required, else prior-dominant | 3.4 |
| D3-4 | NCC "still looks blank" gate inverted on flat patches | **SSIM with an explicit variance floor** returning `bothFlat` | 3.4 |
| D3-5 | Morphological opening sign error deletes the signature | `extractRules`/`removeRules` (already correct in the codebase), SE length capped at 8 mm, plus reconstruction | 2.7 |
| D3-6 | Single-link CC grouping chains through registration residue | **Complete-link** + absolute mm caps + ROI⊕12 mm bound | 3.2 |
| D3-7 | "Tighter than a human" crop is scored against human boxes | **Metric redefined**: photo = quad IoU vs labelled *physical boundary*; signature/thumb = ink-containment ≥98 % with ≤25 % excess | 10.3 |
| D3-8 | Template-first promotion degrades signatures | **Per-element promotion.** Photo may promote; signature/thumb **never** skip local detection | 6.5 |
| D3-9 | Ridge FFT corrupted by JPEG 8-px blocking | Descoped; v1.2 has an explicit 8-px notch | 3.3 |
| D3-10 | No server-side rectification fallback | Server always re-derives geometry; client rectification is a hint | 2.0 |
| D3-11 | ORB weakest on repetitive ruled forms | `matchTemplate` ZNCC anchors are **primary**; ORB is the bootstrap; isotropy rejection excludes rule-line patches | 2.4 |
| D3-12 | 2-of-3 fusion launders correlated VLM name errors | **Name fields require the lexical OCR reader in the majority**, else review | 4.6 |
| D3-13 | Confidence feedback loop with no breaker | Blind audit sampling | 5.3 |
| D3-14 | Calibration statistics unmeasurable at N=300 | Buckets < 400; provisional 400–1,500; unqualified only ≥ 1,500 **with bootstrap CI below 0.08**; hierarchical pooling | 5.3 |
| D3-15 | Call budget internally inconsistent; cost 3–5× off | Call list enumerated; ~$0.02/scan computed, ~$0.06 worst case; per-org spend cap | 11 |
| D3-16 | Latency 3× off; critical path serial | Budget table; Azure ∥ Textract ∥ local CV; repair loop capped at 2 iterations | 11 |
| D3-17 | Compliance section kills the ensemble | Moondream and OpenRouter **removed**. Two in-region vendors (Azure Central India, AWS ap-south-1) + two model families with regional pinning | 4.3 / 9 |
| D3-18 | OpenCV rejection self-contradictory | Overturned | 9 |
| D3-19 | No MVP path | Eight phases, each with a named demo; Phase 3 is a sellable demo with **zero model calls** | 11 |
| D3-20 | VLM `evidence_bbox` shown to the clerk as proof | **Text evidence boxes come from Azure word polygons only** | 2.11 |
| D3-21 | Negative control fires on legitimately-inked control regions | Control chosen from **empirically blank** history (occupancy < 2 %), ink-checked before use, falls through to `below_threshold` rather than nuking the scan | 3.4 |
| D3-22 | Two-page splitting listed but never implemented | Explicit stage; ambiguous splits **ask the operator** | 2.2 |

**Accepted risks, not resolved:** (1) v1 thumb crop accuracy is not gated — always human-confirmed. (2) Handwritten Devanagari is human-assisted, permanently, until a vendor ships it. (3) An element written entirely outside its ROI is reported `Not Detected` by design. (4) A field relocated in a reprint can crop confidently wrong until drift monitoring fires. (5) A sharp crease through an image box is not recoverable by homography or APAP. (6) Free-text illegible clinical handwriting stays at 60–78 % and no architecture fixes it.

---

## 14. The five rules that override everything

Pinned at the top of `lib/regions/params.ts` and enforced by tests.

1. **No VLM coordinate ever reaches a stored crop.** Models supply search regions and classifications. Geometry comes from registration and deterministic CV. Every `bbox` adapter has a synthetic-rectangle unit test.
2. **A wrong crop is worse than no crop.** The gate is conjunctive and biased toward false negatives. `false_crop_rate ≤ 0.005` is a hard CI gate, and a below-threshold candidate is never emitted as an answer.
3. **`Not Detected` never carries a percentage**, and always carries one of exactly three reasons.
4. **No number on screen is a model's opinion of itself.** Every confidence is a measured statistic, a vendor-calibrated confidence, or an agreement statistic, passed through an isotonic curve fitted on **audited** outcomes — and shown as a bucket until that curve is statistically measurable.
5. **No record is written without an explicit human Save**, and safety-critical fields are never green.