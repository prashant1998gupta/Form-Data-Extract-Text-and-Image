/**
 * Every tunable constant in region extraction, in one frozen object.
 *
 * ===========================================================================
 * THE FIVE RULES THAT OVERRIDE EVERYTHING
 * ===========================================================================
 *
 * 1. **No model coordinate ever reaches a stored crop.** Vision-language models
 *    supply search regions and classifications. Geometry comes from
 *    registration and deterministic image processing. Anthropic's own
 *    documentation says Claude's coordinate outputs are approximate; Gemini and
 *    Qwen use three mutually incompatible conventions. None of them belongs on
 *    the path that decides where to cut a photograph.
 *
 * 2. **A wrong crop is worse than no crop.** The acceptance gate is
 *    conjunctive and deliberately biased toward false negatives. A miss is
 *    visible on the verification screen and takes one drag to fix; a plausible
 *    wrong crop slips through review and lands in a patient record.
 *
 * 3. **"Not Detected" never carries a percentage**, and always carries one of
 *    exactly three reasons. We have no calibrated probability for a non-event,
 *    and false precision destroys trust in every other number on the screen.
 *
 * 4. **No number on screen is a model's opinion of itself.** Every confidence
 *    is a measured statistic or an externally calibrated one. No provider
 *    exposes input-token logprobs for a vision call; a model's self-reported
 *    confidence is just generated text that happens to look like a number.
 *
 * 5. **No record is written without an explicit human Save**, and
 *    safety-critical fields are never shown as settled.
 *
 * ===========================================================================
 *
 * **Units.** Every threshold here is in millimetres, in mm², or is a ratio
 * against a statistic measured in the same scan. There are no raw pixel
 * constants. That is precisely what lets the same numbers work on a 170 dpi
 * WhatsApp recompression and a 600 dpi flatbed scan — a pixel constant tuned on
 * one is wrong by a factor of three on the other.
 *
 * **Provenance.** These are starting values derived from the physical
 * properties they describe (photo sizes, pen widths, thumb-pad dimensions), not
 * measurements from a corpus. `scripts/tune.ts` refits them against the
 * synthetic corpus and a held-out real split. Until that has run, treat them as
 * defensible defaults rather than as evidence.
 */

export const REGION_PARAMS = Object.freeze({
  /** Photograph detection. */
  photo: Object.freeze({
    /** Search box = template box expanded by max(this, fraction x size). */
    searchPadMM: 8,
    searchPadFraction: 0.3,
    /** Half-width of the median window on the OUTSIDE of a candidate step. */
    stepWindowMM: 0.8,
    /**
     * Length of the median window on the INSIDE of a candidate step.
     *
     * This is what separates a photograph's boundary from the form's printed
     * rules and box borders, which are otherwise indistinguishable — both are
     * strong, straight and correctly oriented. A rule is a step down and
     * immediately back up; a photo edge stays stepped for the whole height of
     * the photograph. Asking whether the difference PERSISTS for 3 mm answers
     * that directly, where no response threshold can.
     *
     * Long enough that no printed line can fill it, short enough to sit
     * comfortably inside a 35x45 mm photo.
     */
    sustainWindowMM: 3,
    /** Band searched perpendicular to each expected edge. */
    edgeBandMM: 6,
    /** RANSAC inlier distance. */
    lineToleranceMM: 0.25,
    ransacIterations: 200,
    /**
     * Hard floor on the fraction of scanlines agreeing on an edge. Below this
     * the line is a minority opinion whatever its strength.
     */
    minInlierRatioFloor: 0.45,
    /** Hard floor on step strength, in paper-sigma. Below this it is noise. */
    minResponseSigma: 3,
    /**
     * Combined evidence an edge must carry: support x strength.
     *
     * Gating on support alone is wrong in both directions — it passes a
     * barely-visible step that most scanlines happen to agree on, and refuses an
     * unmistakable one that a minority missed because a crooked photo overlaps
     * its printed border along part of a side. The product asks how much total
     * evidence exists, which is the real question.
     */
    minEdgeEvidence: 0.35,
    /** Channel weights for the step response: lightness, chroma, texture. */
    channelWeights: Object.freeze({ lightness: 1, chroma: 0.6, texture: 0.4 }),
    /**
     * A fitted line this close to a known printed border must beat the next
     * candidate by `printedBorderMargin` to be accepted. This is what stops the
     * detector locking onto the pre-printed "Affix Photo" rectangle instead of
     * the photo pasted over it.
     */
    printedBorderMM: 0.4,
    printedBorderMargin: 1.5,
    /** Two roughly-parallel candidates within this distance: prefer the inner. */
    parallelCandidateMM: 4,
    /**
     * How far registration is expected to be out, as a Gaussian sigma.
     *
     * Used to score competing candidate lines by agreement with the prior.
     * This is the term that separates a photograph edge from the printed rule a
     * few millimetres away — locally the two are indistinguishable, and every
     * purely local rule tried during development picked the wrong one on some
     * real input. It is deliberately generous enough that a well-measured edge
     * always beats a badly-measured one nearer the prior.
     */
    priorSigmaMM: 2.5,
    /** Accepted size relative to the declared photo size. */
    sizeFitRange: Object.freeze({ min: 0.72, max: 1.35 }),
    /** Accepted aspect deviation from the declared aspect. */
    aspectTolerance: 0.15,
    /** quadArea / minAreaRectArea. Below this the "rectangle" is not one. */
    minRectangularity: 0.8,
    /** Content score needed to accept. */
    contentThreshold: 0.55,
    /** Content score needed on a greyscale page, where chroma features are dead. */
    contentThresholdGreyscale: 0.48,
    /** Confidence ceiling when the page carries no colour at all. */
    greyscaleConfidenceCap: 0.72,
    /** Below this page-level saturated fraction, chroma features are dropped. */
    greyscaleSaturationFraction: 0.02,
    /** Inset applied to the fitted quad, as a fraction of each side. */
    insetFraction: 0.015,
    /** Beyond this upscale factor we emit at native size and flag low resolution. */
    maxHonestUpscale: 1.5,
    lowResolutionConfidenceCap: 0.72,
    /**
     * Positive absence. Both must hold for the box to be ASSERTED empty rather
     * than merely reported as "nothing found".
     *
     * Set well clear of both populations rather than at the midpoint: measured
     * on the reference fixtures, an empty printed box scores 0.31 coverage and
     * 0.18 spread while a pasted photograph scores 0.78 and 0.78. The gap is
     * wide, and sitting nearer the empty side keeps the confident TRUE-negative
     * claim conservative — a photo wrongly called "box empty" is a false
     * statement to the operator, whereas a genuinely empty box falling through
     * to "nothing found" is merely unhelpful.
     */
    emptyCoverageFraction: 0.45,
    emptyToneSpread: 0.35,
  }),

  /** Signature detection. */
  signature: Object.freeze({
    searchPadMM: 10,
    searchPadFraction: 0.4,
    /**
     * Complete-link clustering gaps. Horizontal is far more generous than
     * vertical on purpose: a signature's strokes are separated along the
     * writing direction, and a symmetric gap large enough to join them would
     * also reach the printed label above and the date beside it.
     */
    clusterGapXMM: 4,
    clusterGapYMM: 1.5,
    /** Absolute bound on a cluster, relative to the search ROI. */
    clusterCapMM: 12,
    /** Minimum ink to be a signature at all. Kept low so small initials survive. */
    minInkAreaMM2: 25,
    minWidthMM: 15,
    /** Feature score needed to accept without external agreement. */
    scoreThreshold: 0.55,
    /** Feature score that overrides an external detector's silence. */
    scoreThresholdUnsupported: 0.7,
    /** Ink / convex-hull area. A signature is open; a thumb and a photo are not. */
    solidityRange: Object.freeze({ min: 0.25, max: 0.65 }),
    /** Coefficient of variation of stroke width. Printed type sits below this. */
    strokeWidthCvRange: Object.freeze({ min: 0.3, max: 0.55 }),
    /** Aspect plateau: wide and short. */
    aspectRange: Object.freeze({ low: 1.4, lowFull: 2.5, highFull: 8, high: 12 }),
    longestBranchMM: Object.freeze({ min: 20, max: 45 }),
    /** Distance from the printed signature line, over which proximity decays to zero. */
    baselineFalloffMM: 15,
    /** Above this, the group is printed text and registration is probably wrong. */
    printedTextAlarm: 0.45,
    /**
     * Signature strokes are thin by construction. A distance-transform maximum
     * larger than this means a filled region — a photo or a pasted sticker.
     */
    maxStrokeHalfWidthMM: 1.7,
    /** Cluster larger than this multiple of the learned prior triggers the split rule. */
    areaCapMultiple: 3,
    areaCapMultipleNoPrior: 2,
    /** Alpha dilation and feather for the ink-on-transparent output. */
    alphaDilatePx: 2,
    alphaFeatherPx: 1,
    outputPadMM: 3,
  }),

  /**
   * Thumb impression — deliberately limited.
   *
   * Ridge-frequency analysis is NOT used, and that is a considered decision
   * rather than an omission. Real stamp-pad impressions are usually over-inked
   * into a solid smudge with no resolvable ridges at any resolution; mid-range
   * phone image pipelines denoise and sharpen away exactly the 0.4-0.6 mm band
   * a ridge detector needs; and JPEG's 8x8 block quantisation deposits spurious
   * energy immediately adjacent to that band, so the fallback fires on
   * compression artefacts. Elaborate machinery that works on flatbed scans and
   * almost never in the field is worse than none, because it produces confident
   * wrong answers instead of honest uncertainty.
   *
   * So: blob, geometry and ink colour. Confidence hard-capped, always reviewed.
   */
  thumb: Object.freeze({
    searchPadFraction: 0.3,
    /**
     * Physical EXTENT of the impression — its bounding box, not its ink area.
     * A thumb pad is roughly 15x20 mm to 25x30 mm.
     *
     * The distinction matters because a well-taken impression is RIDGED: ink on
     * the ridges, paper in the valleys, so only about half the extent is inked.
     * Gating ink area against a pad-size range rejects exactly the cleanest
     * impressions while admitting over-inked smudges, which is backwards. Fill
     * ratio measures the inked fraction separately, where it belongs.
     */
    areaRangeMM2: Object.freeze({ min: 150, max: 1200 }),
    aspectRange: Object.freeze({ min: 0.55, max: 1.8 }),
    /**
     * Ink over convex-hull area, for ACCEPTING a thumb.
     *
     * The admissible range is wide, and deliberately so, because solidity here
     * is RESOLUTION-DEPENDENT in a way most shape features are not. Friction
     * ridges are near the resolution limit: sample the same impression more
     * finely and the valleys between ridges resolve as empty, dropping
     * solidity; sample it coarsely and adjacent ridges blur together, raising
     * it. The same synthetic impression measured 0.47 at 150 dpi and 0.40 after
     * rectification to the 200 dpi canonical raster — the mark did not change,
     * only how it was sampled.
     *
     * An over-inked smudge, where the ink has filled the valleys, reaches 0.9
     * at any resolution. All of these are thumb impressions and all must pass,
     * so the floor sits below the whole band rather than in the middle of it.
     * Compactness and fill do the discriminating work; solidity only excludes
     * the genuinely open marks.
     */
    minSolidity: 0.35,
    /**
     * Ink over convex-hull area for REJECTING something as "too solid to be a
     * signature", used by the signature detector.
     *
     * Deliberately much higher than `minSolidity`. These answer different
     * questions — "is this solid enough to be a thumb?" and "is this so solid it
     * cannot be a signature?" — and a single threshold serving both would either
     * reject legitimate signatures or admit smudges as signatures. Compactness
     * and the absence of cursive structure do the rest of the separation.
     */
    crossRejectSolidity: 0.7,
    fillRange: Object.freeze({ min: 0.25, max: 0.85 }),
    /**
     * A mark this elongated AND this open is a signature written in the thumb
     * box — a human error the template lets us surface rather than absorb.
     *
     * Both conditions are required, because either alone has honest exceptions:
     * an over-inked smudge can be elongated, and a light impression can be
     * open. Neither is both. Measured on the reference fixtures, a thumb sits at
     * aspect 0.71 / solidity 0.47 and a signature at 5.75 / 0.14, so the
     * separation is wide.
     */
    wrongBoxAspect: 2.5,
    wrongBoxSolidity: 0.3,
    closeMM: 2.5,
    scoreThreshold: 0.55,
    /** Hard ceiling. A thumb crop is always confirmed by a human in this version. */
    confidenceCap: 0.7,
  }),

  /** Shared ink-map construction. */
  ink: Object.freeze({
    /** Sauvola window, as a fraction of the page's short edge. */
    sauvolaWindowFraction: 1 / 40,
    sauvolaK: 0.25,
    adaptiveMeanOffset: 12,
    /** Illumination flattening grid. */
    illuminationGrid: 32,
    /** Printed rules longer than this are removed before component analysis. */
    ruleMinLengthMM: 25,
    ruleThicknessMM: 0.4,
    /** Speckle smaller than this is dropped. */
    minComponentAreaMM2: 0.15,
    /**
     * Template subtraction tolerance. Registration residue plus photocopy
     * stroke thickening; measured per scan, this is the floor.
     */
    subtractionBaseMM: 0.15,
  }),

  /** The acceptance gate and the absence rules. */
  gate: Object.freeze({
    /** Structural similarity against the blank template's same region. */
    stillBlankSsim: 0.9,
    /** Below this variance, a patch is flat and SSIM is meaningless — report blank. */
    ssimVarianceFloor: 12,
    /** Registration reprojection error over which geometry is not trusted at all. */
    strictResidualMM: 0.4,
    looseResidualMM: 1.2,
    /** With only LOOSE registration, a detector must clear this to be believed. */
    looseScoreFloor: 0.7,
  }),
});

export type RegionParams = typeof REGION_PARAMS;

/**
 * Why a crop was not produced. Exactly three, and the distinction is the whole
 * point: a located-and-verifiably-empty box is a confident TRUE negative and
 * should read as one, while a failed alignment is an apology and a re-scan
 * prompt. Collapsing them into one "not found" message throws away the only
 * information the operator needs to decide what to do next.
 */
export type AbsenceReason =
  /** The placeholder was located in the scan and is verifiably empty. High confidence. */
  | "box_empty"
  /** Candidates existed; none cleared the gate. Low confidence — offer the best as a suggestion. */
  | "below_threshold"
  /** Registration could not be trusted, so no region could be addressed at all. */
  | "geometry_unknown";

/** Which gate clause refused a candidate. Recorded for every refusal. */
export type GateClause =
  | "trust"
  | "boundary"
  | "content"
  | "still_blank"
  | "external"
  | "uniqueness";

export const GATE_CLAUSE_LABELS: Readonly<Record<GateClause, string>> = Object.freeze({
  trust: "Registration was not reliable enough to locate the region",
  boundary: "The element's outline could not be measured",
  content: "What was found does not look like this kind of element",
  still_blank: "The region is indistinguishable from the blank form",
  external: "The independent detector disagreed",
  uniqueness: "Another element claimed this region more strongly",
});
