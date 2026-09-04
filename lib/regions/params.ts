/**
 * Every tunable constant in region extraction, in one frozen object.
 *
 * ===========================================================================
 * THE FIVE RULES THAT OVERRIDE EVERYTHING
 * ===========================================================================
 *
 * 1. **No model coordinate ever reaches a stored crop.** A vision-language
 *    model may supply, at most, search regions and classifications — today the
 *    image pipeline calls none. Geometry comes from registration and
 *    deterministic image processing. Anthropic's own
 *    documentation says Claude's coordinate outputs are approximate; Gemini and
 *    Qwen use three mutually incompatible conventions. None of them belongs on
 *    the path that decides where to cut a photograph. The handwriting reader
 *    (`lib/reader/`) obeys the same boundary from the other side: it supplies
 *    transcribed VALUES for review — one field per request, or keyed to strip
 *    numbers this pipeline printed into a composite image — and the crop it
 *    reads was cut by this pipeline's geometry: a model never chooses which
 *    pixels a value came from, nor which field a value lands under.
 *
 * 2. **A wrong crop is worse than no crop.** HARD BANDS reject outright and
 *    cannot be compensated for (`thumb.hardAspectRange`, `thumb.hardFillRange`,
 *    the boundary gates in `photo.ts`). The weighted score only ranks and
 *    thresholds what survives them — inside the bands a weak term can still be
 *    bought off by strong ones, so the sum alone is NOT a conjunctive gate.
 *    Stating it as though it were is how the thumb detector shipped without
 *    one: a term at zero cost at most 0.30 of a 0.55 threshold, and a fragment
 *    of printed paragraph at aspect 2.70 was delivered as a thumb impression.
 *    Every gate is written as a negated `>=`, so a NaN rejects rather than
 *    skipping the gate.
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
 * measurements from a corpus. No tuning harness exists yet; a future
 * `scripts/tune.ts` would refit them against the synthetic corpus and a
 * held-out real split. Until it does, treat these as defensible defaults rather
 * than as evidence — with the exception of the drawn-prior sweep below, which
 * was measured.
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
     * Multiple of `minResponseSigma` a candidate step must clear on the FIRST
     * pass over an edge.
     *
     * Deliberately well above the acceptance floor: on a clean scan almost
     * anything qualifies, and letting paper grain into the candidate set makes
     * the line fit choose between a real edge and a hundred imaginary ones.
     *
     * But it was the only floor there was, which made `minResponseSigma`
     * unreachable — an edge between 3 and 7.5 sigma was not scored badly, it
     * was never generated. That is exactly the boundary a pale studio
     * backdrop makes against white paper, i.e. the input `photo.ts` opens by
     * naming as the most common one there is, and it came back as "this edge
     * could not be measured" and took the whole detection with it.
     *
     * So this is now the STRICT pass, and edges that fail it are re-measured
     * at `minResponseSigma` — the floor the acceptance test always claimed.
     */
    strictResponseMultiplier: 2.5,
    /**
     * Inlier floor on the RELAXED pass.
     *
     * The floor above asks "did most scanlines see this edge?", and on a
     * photograph where most of one side is genuinely invisible the honest
     * answer is no — while the line is still real. Measured on the pale-
     * backdrop fixture, the left edge's best candidate is a 93-sigma step at
     * 89.7 degrees, i.e. unmistakable and correctly oriented, supported by
     * 36% of scanlines because the backdrop matches the paper down the lower
     * half of that side. There is nothing wrong with the measurement; there
     * is simply less of the edge to measure.
     *
     * Lowering the floor alone would let a fit through noise in, so it is
     * lowered WITHOUT touching `minEdgeEvidence`: support times strength must
     * still clear 0.35, which at this floor demands a step of roughly 9 sigma.
     * Few scanlines, each seeing something unmistakable, is evidence. Few
     * scanlines each seeing something faint is not, and still fails.
     */
    relaxedInlierRatioFloor: 0.28,
    /**
     * A candidate step that keeps less than this fraction of its response when
     * the outside window is lengthened to match the inside one is MARKED as a
     * printed rule rather than a boundary. The mechanism and the measurement
     * are in `edgeStepProfile`'s `thinOutsideRatio`.
     *
     * Half, because a genuine edge with a rule a millimetre or two outside it
     * — the printed "Affix photo" border, on nearly every real form — has a
     * short-outside median polluted by that rule and a long-outside median of
     * paper, so its long response is typically HIGHER, never much lower. A
     * rule alone drops to a few percent.
     */
    thinOutsideRatio: 0.5,
    /**
     * How much of a candidate line's score is forfeited when ALL of its
     * inliers are rule-like steps (scaled by the fraction that are).
     *
     * Deliberately a penalty rather than a veto. Measured on the pale-backdrop
     * fixture, the header rule 4 mm above the photograph scored 0.87 against
     * the true top edge's 0.8 — a rule seen by every scanline beats a faint
     * edge seen by most — and this is what reverses that. But on an EMPTY
     * printed box the border is the only line there is, and fitting it is
     * how the detector goes on to say the box is empty. At 0.6 a rule-built
     * line still wins an uncontested edge and loses every contested one.
     */
    thinCandidatePenalty: 0.6,
    /**
     * A fitted edge whose inliers are more than this fraction rule-like steps
     * is a PRINTED LINE, and the strict pass does not get to call it the
     * boundary without the relaxed pass first looking for a real one. If the
     * relaxed pass finds nothing better the printed line stands — which is
     * how an empty box's border is still fitted and the box reported empty.
     */
    ruleLikeFraction: 0.5,
    /**
     * RANSAC tolerance on the relaxed pass, as a multiple of `lineToleranceMM`.
     *
     * A faint edge is also a SOFT one: a pale backdrop grades into the paper
     * over a couple of pixels rather than stepping, and the plateau-centre
     * estimate jitters with it. Measured on the pale-backdrop fixture, the
     * true top edge's 95 samples spread over 10 px (1.3 mm) around their mean
     * at 16-20 sigma each; a 2 px tolerance could gather a third of them, and
     * a diagonal through the scatter out-supported every horizontal slice. At
     * 3x the same samples fit one line at 180 degrees. The strict pass keeps
     * the tight tolerance, because on a sharp edge tight is exactly right.
     */
    relaxedToleranceMultiplier: 3,
    /**
     * Confidence ceiling when any edge needed the relaxed pass.
     *
     * A boundary measured at 4 sigma is a real measurement and a weaker one
     * than a boundary measured at 40. The crop is offered; the certainty is
     * not. Below the 0.8 that `extract-regions.ts` uses to force review, so
     * such a detection always reaches a human.
     */
    faintEdgeConfidenceCap: 0.7,
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
    /**
     * The same two quantities, for a box a PERSON DREW rather than one
     * registration produced.
     *
     * A dragged box means "the photo is around here", not "its top edge is at
     * 30.3 mm", and the defaults above are calibrated for the second kind of
     * claim. Measured on the reference fixture: the registered prior recovers a
     * box 2 mm out and REFUSES one 4 mm out, which is well inside the error a
     * finger on a phone carries — a template taught by drawing would simply
     * appear not to work.
     *
     * Measured across a sweep, and the shape of the result is the interesting
     * part: WIDER IS NOT BETTER. sigma 12 / band 20 and sigma 16 / band 26
     * refuse every case, because a band that wide starts admitting the printed
     * border and the surrounding rules, and the line fit has no way to prefer
     * the right one. There is a genuine optimum, not a monotonic trade:
     *
     *   drawing error   0mm    2mm    4mm    6mm    8mm
     *   sigma 8/band 14  0.987  0.984  0.986  0.988  refused   (IoU)
     *   sigma 6/band 12  0.980  0.975  refused 0.970 refused
     *   sigma 12/band 20 refused everywhere
     *
     * So 6 mm of hand-drawing error still yields a pixel-tight crop, and past
     * about 8 mm the honest answer is to ask the person to draw it again.
     *
     * THESE FIGURES ARE THE DETECTOR MEASURED ALONE, on the fixture at 150 dpi.
     * End to end through the pipeline — rectified page, CTS resolution, a
     * template built by `parseCustomTemplate` — the same sweep gives IoU
     * 0.92-0.99 across 0-8 mm, dipping to ~0.92 at 2-3 mm. The pipeline number
     * is the one to quote to anyone; this one is for tuning this constant.
     */
    drawnPriorSigmaMM: 8,
    drawnPriorBandMM: 14,
    /** Accepted size relative to the declared photo size. */
    sizeFitRange: Object.freeze({ min: 0.72, max: 1.35 }),
    /** Accepted aspect deviation from the declared aspect. */
    aspectTolerance: 0.15,
    /** quadArea / minAreaRectArea. Below this the "rectangle" is not one. */
    minRectangularity: 0.8,
    /**
     * How far the four fitted edges may disagree about the paste angle before
     * they stop being four sides of one rectangle.
     *
     * A photograph IS a rectangle — that is a fact about the object, not an
     * assumption about the image — so its four edges share a single angle, and
     * four independent line fits that agree on it to within a couple of
     * degrees have measured that angle four times. When one of them is well
     * outside the others it is not a fifth opinion about the paste angle; it
     * is a line fitted to something else, usually a strong interior contour on
     * the side where the boundary was faintest.
     *
     * So `squareUpEdges` re-lays every accepted edge on the consensus angle,
     * moving only its DIRECTION. Each line keeps the distance it was measured
     * at. And past this spread nothing is repaired: lines that disagree by more
     * than this are not a slightly noisy rectangle, and pretending otherwise is
     * how a detector manufactures a plausible quadrilateral out of unrelated
     * evidence.
     */
    maxEdgeAngleSpreadDegrees: 8,
    /**
     * Below this spread the four edges are treated as already agreeing and the
     * measured quad is delivered untouched. Four independent RANSAC fits of a
     * clean rectangle land within a degree or two of one another; anything
     * wider means at least one of them measured something else.
     */
    consistentEdgeSpreadDegrees: 3,
    /**
     * How far from horizontal or vertical a single fitted edge may lie and
     * still be believed as that edge.
     *
     * This was 20 degrees, which is not a crooked paste — it is a diagonal.
     * The crookedest photograph in the fixture set is 6 degrees, and a person
     * gluing one on cannot easily manage more than that without noticing.
     * What DOES lie at 11-20 degrees, reliably, is the outline of a head or a
     * shoulder inside the photograph: measured on the pale-backdrop fixture,
     * the right edge was accepted as a 190-sigma line at 72 degrees, running
     * from the hairline to the collar, and the crop warped that trapezoid
     * into a rectangle. At 12 degrees a hairline contour at 12.7 was still
     * returned as a candidate and, fitted first, swallowed enough of the true
     * top edge's samples to fail it on evidence. Eight leaves 2 degrees over
     * the tested paste and excludes every contour the fixtures produce.
     */
    maxEdgeAngleDegrees: 8,
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
