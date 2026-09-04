/**
 * Passport-photograph detection.
 *
 * The product's headline capability, and the one place where getting the
 * general approach wrong costs the most.
 *
 * WHY BOUNDARY, NOT APPEARANCE. The obvious design is to find the photo by
 * looking for photo-like pixels: colour, texture, faces, darkness. That design
 * fails on the single most common real input. The modal Indian passport photo
 * is a person on a white or pale-blue studio backdrop, printed on white photo
 * paper, pasted onto white form paper. Segment any appearance map correctly and
 * you get the head and shoulders — not the rectangle. A head-and-shoulders blob
 * then fails every aspect-ratio and rectangularity check, so the detector
 * either rejects a photo that is plainly there, or "fixes" it by snapping to
 * the printed box, which is a guess wearing a measurement's clothes.
 *
 * A pasted photograph always has a hard physical boundary. There is a step in
 * lightness, or in chroma, or — when the tones genuinely match — in
 * high-frequency texture energy, because emulsion and paper fibre never share a
 * grain. Usually there is a drop shadow on at least one edge too.
 *
 * And because the template tells us roughly where the box is, we never have to
 * FIND a rectangle. We measure four lines. That is a much easier problem, it
 * yields the paste angle for free, and it fails loudly — an edge that cannot be
 * measured is reported as such, rather than being quietly replaced by the
 * template's own edge.
 *
 * The prior may be a REGISTERED box, accurate to a fraction of a millimetre, or
 * one a person DRAGGED with a finger, accurate to a few. The detector is told
 * which and widens its sigma and search band accordingly — see
 * `PhotoDetectionInput.prior` below and `drawnPriorSigmaMM` in params.ts. With
 * the registered prior applied to a drawn box it refuses at 4 mm of error.
 *
 * Appearance is still used, but only to ACCEPT OR REJECT the quadrilateral the
 * boundary fit produced. It never decides where the boundary is.
 */

import { chromaClusterCount, type LabImages } from "../vision/colour.ts";
import {
  angleDifference,
  edgeStepProfile,
  intersectLinesToQuad,
  lineAngleDegrees,
  fitLineCandidates,
  type EdgeSide,
  type Line,
  type LineFit,
  type StepSample,
  type WeightedChannel,
} from "../vision/lines.ts";
import { minAreaRect } from "../vision/geometry.ts";
import { inkDensity } from "../vision/features.ts";
import { boundsOf, quadPoints, type Gray, type Mask, type Quad, type Rect } from "../vision/types.ts";
import {
  localVarianceCoverage,
  textureContrastRatio,
  toneSpread,
  type PaperStatistics,
} from "../ink/paper-stats.ts";
import { REGION_PARAMS, type AbsenceReason, type GateClause } from "./params.ts";

export interface PhotoDetectionInput {
  readonly lab: LabImages;
  /** High-frequency texture energy channel. */
  readonly texture: Gray;
  readonly ink: Mask;
  readonly paper: PaperStatistics;
  /** Expected photo box, in working pixels, from the registered template. */
  readonly expected: Rect;
  /**
   * Declared physical size. Chosen by the admin at template build time, or
   * taken from the box a person drew — never guessed by this file.
   */
  readonly sizeMM: { readonly widthMM: number; readonly heightMM: number };
  /**
   * Accepted ratio of measured size to declared size. Defaults to the window
   * for a NAMED size, which is tight because a named size is a fact about the
   * paper. A size inferred from a dragged box arrives with its own, looser
   * window — see `photoSizeTolerance` in `templates/types.ts`.
   */
  readonly sizeTolerance?: { readonly min: number; readonly max: number };
  /** Working-image pixels per millimetre of paper. */
  readonly pxPerMM: number;
  /** The pre-printed "Affix Photo" rectangle, if the template records one. */
  readonly printedBorder?: Rect;
  /**
   * How much stronger the printed border's edge must be than an inner
   * parallel candidate to keep the fit. Defaults to the measured value in
   * `params.ts`; a caller that has already established the fitted rectangle
   * IS the frame — because there was blank paper just inside it — raises it,
   * so the print's fainter edge inside wins.
   */
  readonly printedBorderMargin?: number;
  /** How far a fitted edge may lie from the declared border to count as it, in millimetres. Defaults to `params.ts`. */
  readonly printedBorderMM?: number;
  /** Fraction of the whole page carrying colour. Below ~2 %, chroma features are dropped. */
  readonly pageSaturatedFraction: number;
  /**
   * How much to trust `expected`, and therefore how far to look.
   *
   * The defaults describe a REGISTERED prior — a template box mapped through a
   * homography, out by a fraction of a millimetre. A box a person dragged with
   * a finger on a phone is a different kind of object: it means "the photo is
   * around here", not "the photo's top edge is at 30.3 mm". Measured, the
   * defaults recover a box 2 mm out and refuse one 4 mm out, which is well
   * inside the error a hand-drawn box carries — so a template taught by drawing
   * would appear simply not to work.
   *
   * `bandMM` is the harder limit of the two: an edge outside the searched band
   * is not scored badly, it is never seen at all.
   */
  readonly prior?: { readonly sigmaMM?: number; readonly bandMM?: number };
}

export interface EdgeReport {
  readonly side: EdgeSide;
  readonly fitted: boolean;
  readonly inlierRatio: number;
  readonly responseSigma: number;
  /** Set when a second, parallel candidate existed and the inner one was chosen. */
  readonly preferredInner?: boolean;
  /**
   * Set when the strict candidate floor found nothing and this edge was
   * measured on the relaxed pass instead. The measurement is real; it is
   * weaker, and the detection's confidence is capped because of it.
   */
  readonly relaxed?: boolean;
}

export interface PhotoContentScores {
  readonly varianceCoverage: number;
  readonly textureRatio: number;
  readonly toneSpread: number;
  readonly chromaModes: number;
  readonly rectangularity: number;
  readonly sizeFit: number;
  readonly aspectFit: number;
  readonly total: number;
}

export type PhotoDetection =
  | {
      readonly found: true;
      /** Exact boundary in working pixels. Carries the paste angle. */
      readonly quad: Quad;
      readonly rotationDegrees: number;
      readonly content: PhotoContentScores;
      readonly confidence: number;
      readonly edges: readonly EdgeReport[];
      readonly greyscale: boolean;
      /** Sides that only the relaxed pass could measure. Empty on a clean detection. */
      readonly faintEdges: readonly EdgeSide[];
    }
  | {
      readonly found: false;
      readonly reason: AbsenceReason;
      readonly failedClause: GateClause;
      readonly detail: string;
      readonly edges: readonly EdgeReport[];
      /** Best candidate, offered to the operator as a dashed suggestion. Never stored as an answer. */
      readonly suggestion?: Quad;
      readonly content?: PhotoContentScores;
    };

const P = REGION_PARAMS.photo;

export function detectPhoto(input: PhotoDetectionInput): PhotoDetection {
  // `ink` is deliberately not destructured: the emptiness test reads it as
  // `input.ink` further down, and a second binding here reads as an unused
  // channel rather than one used elsewhere.
  const { lab, texture, paper, expected, sizeMM, pxPerMM } = input;
  const greyscale = input.pageSaturatedFraction < P.greyscaleSaturationFraction;

  // Three independent views of the same boundary. Each is divided by its own
  // noise level measured on paper in this scan, so the weights below compare
  // like with like regardless of capture quality.
  const channels: WeightedChannel[] = [
    { image: lab.L, weight: P.channelWeights.lightness, sigma: paper.sigmaLightness },
    { image: texture, weight: P.channelWeights.texture, sigma: paper.sigmaTexture },
  ];
  if (!greyscale) {
    channels.push({ image: lab.chroma, weight: P.channelWeights.chroma, sigma: paper.sigmaChroma });
  }

  const bandPx = (input.prior?.bandMM ?? P.edgeBandMM) * pxPerMM;
  const windowPx = Math.max(2, Math.round(P.stepWindowMM * pxPerMM));
  // The inside window must be long enough that a printed rule or box border
  // cannot fill it, but short enough to fit inside the photo's own body.
  const sustainPx = Math.max(windowPx * 2, Math.round(P.sustainWindowMM * pxPerMM));
  const tolerancePx = Math.max(1, P.lineToleranceMM * pxPerMM);

  const sides: EdgeSide[] = ["left", "top", "right", "bottom"];
  const fits: Partial<Record<EdgeSide, LineFit>> = {};
  const reports = new Map<EdgeSide, EdgeReport>();

  /**
   * Measures one edge at a given candidate floor. The outermost qualifying
   * step is the object's boundary; anything further in is its content.
   */
  const measure = (side: EdgeSide, floorSigma: number, relaxed: boolean): EdgeResult | null => {
    const band = bandFor(expected, side, bandPx);
    const samples = edgeStepProfile(channels, side, band, windowPx, {
      minResponse: floorSigma,
      sustainWindow: sustainPx,
      peaksPerLine: 3,
      thinOutsideRatio: P.thinOutsideRatio,
      // The per-scanline relative floor keeps paper grain out of the candidate
      // set on a clean edge, and on a faint one it does the opposite: a
      // boundary at 12 sigma is discarded on every scanline that also crosses
      // a 190-sigma hairline, because 12 is under 15 % of 190. Measured on the
      // pale-backdrop fixture, that left the right edge with candidates only
      // on the scanlines above the head. The relaxed pass is for edges the
      // strict one could not see, so here the absolute floor governs alone.
      ...(relaxed ? { outermostFraction: 0 } : {}),
    });
    return fitEdge(
      samples,
      side,
      relaxed ? tolerancePx * P.relaxedToleranceMultiplier : tolerancePx,
      input,
      expected,
      relaxed,
    );
  };

  const record = (side: EdgeSide, result: EdgeResult | null, relaxed: boolean) => {
    if (!result) {
      reports.set(side, { side, fitted: false, inlierRatio: 0, responseSigma: 0 });
      delete fits[side];
      return;
    }
    fits[side] = result.fit;
    reports.set(side, {
      side,
      fitted: true,
      inlierRatio: result.fit.inlierRatio,
      responseSigma: result.fit.meanResponse,
      preferredInner: result.preferredInner,
      ...(relaxed ? { relaxed: true } : {}),
    });
  };

  // STRICT PASS. The floor is a comfortable multiple of the acceptance
  // threshold so paper grain can never qualify. On a page where every boundary
  // is unmistakable — the common case — this is the only pass that runs, and
  // its answers are the confident ones.
  const strict = new Map<EdgeSide, EdgeResult | null>();
  for (const side of sides) {
    const result = measure(side, P.minResponseSigma * P.strictResponseMultiplier, false);
    strict.set(side, result);
    record(side, result, false);
  }

  // RELAXED PASS, for the sides the strict floor could not see.
  //
  // WHAT THIS IS NOT: it is not the prior. No template edge is substituted for
  // a measured one anywhere in this file, and that is not softened here. The
  // relaxed pass measures the same pixels of the same band against the floor
  // `acceptable()` has always claimed to apply, `minResponseSigma`. Until now
  // that floor was unreachable, because nothing below 7.5 sigma was ever
  // offered to it: an edge between 3 and 7.5 sigma was not scored badly, it was
  // never generated. A pale studio backdrop on white photo paper pasted onto
  // white form paper — the input this file opens by naming as the most common
  // one there is — steps by a handful of grey levels on the side where the
  // backdrop is lightest. That edge came back "could not be measured" and took
  // the whole detection with it, over a photograph plainly present on the page.
  //
  // It also runs for a side the strict pass fitted to a PRINTED LINE — a line
  // whose inliers are rule-like steps (`StepSample.thin`). A rule is not a
  // boundary, and accepting it as one because it was the strongest straight
  // thing in the band is the classic failure this file exists to avoid. The
  // relaxed pass looks for a real boundary there; if it finds one that is not
  // itself rule-like, that wins. If it finds nothing better, the printed line
  // stands — because on an EMPTY box the border is the only line there is,
  // and fitting it is how the box gets reported empty rather than shrugged at.
  //
  // The pass is skipped when NOTHING was measurable, because four faint edges
  // in a row is not a photograph seen dimly. It is a region with no object in
  // it, and searching harder there is how a detector talks itself into finding
  // one.
  const ruleLike = (result: EdgeResult | null) => result !== null && result.thinFraction > P.ruleLikeFraction;
  const strictFitted = sides.filter((side) => reports.get(side)!.fitted);
  const wanting = sides.filter((side) => !reports.get(side)!.fitted || ruleLike(strict.get(side)!));
  if (strictFitted.length > 0 && wanting.length > 0 && wanting.length < sides.length) {
    for (const side of wanting) {
      const relaxedResult = measure(side, P.minResponseSigma, true);
      const strictResult = strict.get(side)!;
      if (relaxedResult && !ruleLike(relaxedResult)) {
        record(side, relaxedResult, true);
      } else if (strictResult) {
        // Nothing better: the printed line stands, as measured by the strict pass.
        record(side, strictResult, false);
      } else {
        record(side, relaxedResult, true);
      }
    }
  }

  const ordered = sides.map((side) => reports.get(side)!);
  const faintEdges = ordered.filter((r) => r.fitted && r.relaxed).map((r) => r.side);
  const unfitted = ordered.filter((r) => !r.fitted);
  if (unfitted.length > 0) {
    // An edge that could not be measured is NOT replaced by the template's own
    // edge. Substituting the prior here is exactly how a detector starts
    // returning the printed box every time and calling it a photograph.
    //
    // AND THE REFUSAL MUST STAY WEAK. This branch used to call
    // `assessEmptiness(input)` and, when the patch looked blank, promote itself
    // to `box_empty` with the words "the photo box was located and is empty".
    // This is the branch where the box was NOT located — that is what an
    // unmeasurable edge means — so the object asserted both things at once: a
    // `failedClause` of "boundary", whose own label reads "The element's
    // outline could not be measured", beside a sentence claiming the box was
    // located. Worse, `assessEmptiness` re-measured `input.expected`, the
    // TEMPLATE'S PRIOR RECTANGLE, so on a misaligned page it was describing a
    // patch of paper the operator never asked about. That is how a photograph
    // plainly present on the form was reported as a box confidently verified
    // empty.
    //
    // `box_empty` is now reachable only from the branch below, where all four
    // edges fitted and the quad passed its checks — i.e. where a boundary
    // really was located and there is something to be empty.
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail: `${unfitted.length} of 4 edges could not be measured (${unfitted.map((r) => r.side).join(", ")}), so nothing can be said about whether this box is empty`,
      edges: ordered,
    };
  }

  let quad = intersectLinesToQuad(fits.left!.line, fits.top!.line, fits.right!.line, fits.bottom!.line);

  // A photograph is a rectangle, so its four edges share one angle. Four lines
  // fitted independently do not know that, and on the side where the boundary
  // was faintest the best available line is sometimes a strong interior
  // contour running a few degrees off true. That single line skews the whole
  // quadrilateral: measured on the pale-backdrop fixture it produced a
  // rectangularity of 0.79 against a 0.80 floor, so a photograph whose four
  // edges had all been located was refused for not being rectangular.
  //
  // Only tried when the measured quad actually fails, so the rectangularity
  // gate keeps its full meaning on every scan that never needed this.
  //
  // Also tried when the edges visibly disagree about the angle even though the
  // quad still clears the rectangularity floor: a trapezoid with one side 8
  // degrees off passes 0.8 comfortably, and warping it upright stretches the
  // portrait.
  let squaredUp = false;
  if (quad) {
    const rectangular = polygonArea(quadPoints(quad)) / Math.max(1, rectArea(quad)) >= P.minRectangularity;
    if (!rectangular || edgeAngleSpread(fits as Record<EdgeSide, LineFit>) > P.consistentEdgeSpreadDegrees) {
      const squared = squareUpEdges(fits as Record<EdgeSide, LineFit>, expected);
      if (squared) {
        quad = squared;
        squaredUp = true;
      }
    }
  }

  if (!quad) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail: "the fitted edges do not intersect into a quadrilateral",
      edges: ordered,
    };
  }

  const content = scoreContent(quad, input, greyscale);
  const threshold = greyscale ? P.contentThresholdGreyscale : P.contentThreshold;

  // Written as a negated `>=` rather than `<`, so a NaN score REJECTS. With
  // `content.total < threshold` a NaN silently passes — it does not fail the
  // test, it skips it — and the detector accepts whatever it was shown. That is
  // precisely how an empty printed box became a stored crop during development.
  // Every gate in this file uses the negated form for the same reason.
  if (!(content.total >= threshold)) {
    const emptiness = assessEmptiness(input);
    return {
      found: false,
      reason: emptiness.empty ? "box_empty" : "below_threshold",
      failedClause: emptiness.empty ? "still_blank" : "content",
      detail: emptiness.empty
        ? "the photo box was located and is empty"
        : `content score ${content.total.toFixed(2)} is below the ${threshold} threshold`,
      edges: ordered,
      suggestion: quad,
      content,
    };
  }

  // Geometric plausibility. A quadrilateral that is the right shape but the
  // wrong size is usually the printed border, or two boxes merged.
  if (!(content.rectangularity >= P.minRectangularity)) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail: `the outline is not rectangular enough (${content.rectangularity.toFixed(2)})`,
      edges: ordered,
      suggestion: quad,
      content,
    };
  }
  if (content.sizeFit <= 0 || content.aspectFit <= 0) {
    const measured = minAreaRect(quadPoints(quad));
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail:
        `measured ${(measured.width / pxPerMM).toFixed(1)}x${(measured.height / pxPerMM).toFixed(1)} mm, ` +
        `expected ${sizeMM.widthMM.toFixed(0)}x${sizeMM.heightMM.toFixed(0)} mm`,
      edges: ordered,
      suggestion: quad,
      content,
    };
  }

  const rotated = minAreaRect(quadPoints(quad));
  const rotationDegrees = (rotated.angle * 180) / Math.PI;

  // Confidence blends boundary evidence with content evidence, because they
  // come from independent feature families. A candidate strong on one and weak
  // on the other is exactly the ambiguous case that should not read as certain.
  const boundaryStrength =
    ordered.reduce((sum, r) => sum + Math.min(1, r.responseSigma / 8) * Math.min(1, r.inlierRatio / 0.85), 0) / 4;
  let confidence = 0.45 * boundaryStrength + 0.55 * Math.min(1, content.total);
  if (greyscale) confidence = Math.min(confidence, P.greyscaleConfidenceCap);
  // A boundary measured at 4 sigma is a real measurement, and a weaker one than
  // a boundary measured at 40. The crop is offered; the certainty is not.
  if (faintEdges.length > 0 || squaredUp) confidence = Math.min(confidence, P.faintEdgeConfidenceCap);

  return { found: true, quad, rotationDegrees, content, confidence, edges: ordered, greyscale, faintEdges };
}

// ---------------------------------------------------------------------------
// Edge fitting with printed-border disambiguation
// ---------------------------------------------------------------------------

interface EdgeResult {
  readonly fit: LineFit;
  readonly preferredInner?: boolean;
  /** Fraction of the chosen line's inliers that were rule-like steps. */
  readonly thinFraction: number;
}

/**
 * Fits one edge, then handles the classic failure: locking onto the pre-printed
 * "Affix Photo" rectangle instead of the photograph pasted over it.
 *
 * Both are real, strong, parallel steps a few millimetres apart. The rule that
 * resolves them is physical rather than statistical — a photo is pasted INSIDE
 * its printed box, so of two parallel candidates the inner one is the photo.
 * The same rule handles the mirror-image case of somebody drawing an ink border
 * around the photo by hand.
 *
 * A second candidate is found by removing the first line's inliers and refitting
 * what remains, which is cheaper and more reliable than trying to make one
 * RANSAC pass return multiple hypotheses.
 */
function fitEdge(
  samples: readonly StepSample[],
  side: EdgeSide,
  tolerancePx: number,
  input: PhotoDetectionInput,
  expected: Rect,
  relaxed = false,
): EdgeResult | null {
  // Support is measured against the number of SCANLINES, not the number of
  // samples. With three candidate peaks emitted per scanline, an edge that
  // every single scanline agrees on still only owns a third of the samples, so
  // a ratio computed over samples would put a perfect edge at 0.33 and fail it
  // against a 0.55 floor. The question the threshold is asking — "did most
  // scanlines see this edge?" — needs the scanline count as its denominator.
  const scanlines = countScanlines(samples, side);
  if (scanlines < 8) return null;

  // The orientation goes INTO the fit. A "left edge" at 40 degrees is a fit
  // through noise and one at 18 degrees is the outline of a head; either can
  // out-support the real edge on inlier count alone, and letting it win a
  // candidate slot only to be refused below meant the real edge was never
  // fitted at all. See the note in `ransacLineFit`.
  const orientation = {
    angleDegrees: side === "left" || side === "right" ? 90 : 0,
    maxDeviationDegrees: P.maxEdgeAngleDegrees,
  };
  const candidates = fitLineCandidates(samples, tolerancePx, 3, P.ransacIterations, 1, orientation)
    .map((fit) => ({ ...fit, inlierRatio: Math.min(1, fit.inliers / scanlines) }))
    .filter((fit) => acceptable(fit, side, relaxed));
  if (candidates.length === 0) return null;

  // Where registration says this edge should be, and how far it might be out.
  const anchor = expectedEdgePoint(expected, side);
  const priorSigmaPx = Math.max(1, (input.prior?.sigmaMM ?? P.priorSigmaMM) * input.pxPerMM);

  // Score = support x strength x how well it agrees with the prior.
  //
  // The prior term is what makes this work. The printed rule above a photo box
  // and the photo's own edge are both strong straight lines; locally they are
  // indistinguishable, and every purely local rule tried here picked the wrong
  // one on some real input. Registration knows the answer to within a couple of
  // millimetres, and a Gaussian on that distance separates them decisively
  // without ever letting the prior override a well-measured edge — a strong fit
  // 1 mm away still beats a strong fit 4 mm away, but a WEAK fit near the prior
  // does not beat a strong one slightly further off.
  //
  // And a fourth term: how much of the line is built from steps that behave
  // like a printed rule rather than a boundary (`StepSample.thin`). A rule
  // beside a photo is seen by every scanline, so on support alone it beats a
  // faint real edge — the penalty is what lets the edge win. It is a penalty
  // and not a veto so that on an EMPTY box the border can still be fitted and
  // the box then confidently reported empty; see `thinCandidatePenalty`.
  const scored = candidates.map((fit) => {
    const offset = Math.abs(distance(fit.line, anchor));
    const agreement = Math.exp(-0.5 * (offset / priorSigmaPx) ** 2);
    const strength = Math.min(1, fit.meanResponse / (P.minResponseSigma * 4));
    const ruleLike = 1 - P.thinCandidatePenalty * thinFraction(fit.line, samples, tolerancePx);
    return { fit, score: fit.inlierRatio * strength * agreement * ruleLike, offset };
  });
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;

  // Printed-border disambiguation.
  //
  // A photo is pasted INSIDE its printed box, so of two roughly parallel
  // candidates a few millimetres apart, the inner one is the photograph and the
  // outer one is the box. But this only holds when the outer candidate really
  // IS the printed border — and interior content produces the same geometry
  // with the opposite meaning. On the reference fixture the subject's hairline
  // sits 3.5 mm inside the top edge, close enough to look like the same
  // relationship, and preferring the inner candidate moved the crop 20.7 px
  // down, cutting off the top of the head while every other edge was accurate
  // to within a pixel.
  //
  // So the rule requires the template to actually declare where its printed
  // border is, and requires the current best candidate to be sitting on it.
  // With no declared border there is no ambiguity to resolve, and the
  // prior-weighted score above is already the right answer.
  const bestThin = thinFraction(best.fit.line, samples, tolerancePx);
  if (!input.printedBorder) return { fit: best.fit, thinFraction: bestThin };

  const bestOnBorder = distanceToRectEdge(input.printedBorder, side, best.fit.line);
  if (bestOnBorder > (input.printedBorderMM ?? P.printedBorderMM) * input.pxPerMM) return { fit: best.fit, thinFraction: bestThin };

  const separationPx = P.parallelCandidateMM * input.pxPerMM;
  const centre = { x: expected.x + expected.width / 2, y: expected.y + expected.height / 2 };
  const bestDepth = Math.abs(distance(best.fit.line, centre));

  for (const other of scored.slice(1)) {
    const angleGap = angleDifference(lineAngleDegrees(best.fit.line), lineAngleDegrees(other.fit.line));
    if (angleGap > 4) continue;
    const otherDepth = Math.abs(distance(other.fit.line, centre));
    // Must be inner, and close enough to be the same feature seen twice.
    if (otherDepth >= bestDepth || bestDepth - otherDepth > separationPx) continue;
    // The border candidate keeps the edge only if it is decisively stronger.
    if (best.fit.meanResponse >= other.fit.meanResponse * (input.printedBorderMargin ?? P.printedBorderMargin)) continue;
    return { fit: other.fit, preferredInner: true, thinFraction: thinFraction(other.fit.line, samples, tolerancePx) };
  }

  return { fit: best.fit, thinFraction: bestThin };
}

/** The fraction of a line's inliers that were marked as rule-like steps. */
function thinFraction(line: Line, samples: readonly StepSample[], tolerancePx: number): number {
  const norm = Math.hypot(line.a, line.b) || 1;
  let inliers = 0;
  let thin = 0;
  for (const sample of samples) {
    if (Math.abs(distance(line, sample.point)) / norm > tolerancePx) continue;
    inliers += 1;
    if (sample.thin) thin += 1;
  }
  return inliers === 0 ? 0 : thin / inliers;
}

/** Distinct scanline positions represented in a sample set. */
function countScanlines(samples: readonly StepSample[], side: EdgeSide): number {
  const vertical = side === "left" || side === "right";
  const seen = new Set<number>();
  for (const sample of samples) seen.add(Math.round(vertical ? sample.point.y : sample.point.x));
  return seen.size;
}

/** The point on the expected box where this edge should cross. */
function expectedEdgePoint(expected: Rect, side: EdgeSide): { x: number; y: number } {
  switch (side) {
    case "left":
      return { x: expected.x, y: expected.y + expected.height / 2 };
    case "right":
      return { x: expected.x + expected.width, y: expected.y + expected.height / 2 };
    case "top":
      return { x: expected.x + expected.width / 2, y: expected.y };
    case "bottom":
      return { x: expected.x + expected.width / 2, y: expected.y + expected.height };
  }
}

/**
 * Whether a fitted line is credible as this edge.
 *
 * Support and strength are combined rather than gated separately, because a
 * bare inlier-ratio threshold gets both directions wrong.
 *
 * It is too permissive on weak edges: a line that 56 % of scanlines agree on,
 * each seeing a barely-there 4-sigma step, passes a 0.55 floor while being
 * almost no evidence at all.
 *
 * And it is too strict on overwhelming ones. A crooked pasted photo overlaps
 * its printed border along part of one side, so some scanlines legitimately see
 * the border instead of the photo. Measured on the 6-degree fixture, the
 * correct left edge — 93 degrees, 2.5 px from where registration predicted, a
 * 79-sigma step — was supported by 53 % of scanlines and refused for missing
 * 0.55 by two points, while the whole detection failed as a result.
 *
 * The product of the two asks the question that actually matters: how much
 * total evidence is there for this line? Hard floors remain on each factor
 * individually, so a strong-but-unsupported line and a well-supported-but-faint
 * one are both still refused outright, and the combination cannot rescue
 * either.
 *
 * Note that the registration prior is deliberately NOT part of this. Agreement
 * with the prior selects among candidates that have already been judged
 * credible on their own evidence; letting it into acceptance would allow a
 * measurement too weak to believe to be believed because it landed where we
 * expected. That is the failure mode this whole design exists to avoid.
 */
function acceptable(fit: LineFit, side: EdgeSide, relaxed = false): boolean {
  // On the relaxed pass the support floor drops but `minEdgeEvidence` below
  // does not, so the missing support has to be paid for in step strength. See
  // `relaxedInlierRatioFloor` in params.ts for the measurement behind it.
  if (fit.inlierRatio < (relaxed ? P.relaxedInlierRatioFloor : P.minInlierRatioFloor)) return false;
  if (fit.meanResponse < P.minResponseSigma) return false;

  // A "left edge" returned at 40 degrees is a fit through noise, not an edge —
  // and one at 18 degrees is the outline of a head. Photos are pasted crooked
  // but never diagonally; see `maxEdgeAngleDegrees`.
  const expectedAngle = side === "left" || side === "right" ? 90 : 0;
  if (angleDifference(lineAngleDegrees(fit.line), expectedAngle) > P.maxEdgeAngleDegrees) return false;

  const strength = Math.min(1, fit.meanResponse / (P.minResponseSigma * 3));
  return fit.inlierRatio * strength >= P.minEdgeEvidence;
}

function distance(line: Line, point: { x: number; y: number }): number {
  return line.a * point.x + line.b * point.y + line.c;
}

function distanceToRectEdge(rect: Rect, side: EdgeSide, line: Line): number {
  const point =
    side === "left"
      ? { x: rect.x, y: rect.y + rect.height / 2 }
      : side === "right"
        ? { x: rect.x + rect.width, y: rect.y + rect.height / 2 }
        : side === "top"
          ? { x: rect.x + rect.width / 2, y: rect.y }
          : { x: rect.x + rect.width / 2, y: rect.y + rect.height };
  return Math.abs(distance(line, point));
}

/**
 * The band searched for one edge.
 *
 * Deliberately short of the corners: the corner region contains BOTH edges, so
 * a scanline there sees two steps and the argmax may pick either. Trimming 15 %
 * from each end costs a little evidence and removes a systematic source of
 * outliers near the ends of every line — which is where they do most damage to
 * a fitted angle.
 */
function bandFor(expected: Rect, side: EdgeSide, bandPx: number): Rect {
  const trimX = expected.width * 0.15;
  const trimY = expected.height * 0.15;
  const span = bandPx * 2;
  switch (side) {
    case "left":
      return { x: expected.x - bandPx, y: expected.y + trimY, width: span, height: expected.height - trimY * 2 };
    case "right":
      return {
        x: expected.x + expected.width - bandPx,
        y: expected.y + trimY,
        width: span,
        height: expected.height - trimY * 2,
      };
    case "top":
      return { x: expected.x + trimX, y: expected.y - bandPx, width: expected.width - trimX * 2, height: span };
    case "bottom":
      return {
        x: expected.x + trimX,
        y: expected.y + expected.height - bandPx,
        width: expected.width - trimX * 2,
        height: span,
      };
  }
}

// ---------------------------------------------------------------------------
// Content scoring — accept or reject only, never segment
// ---------------------------------------------------------------------------

function scoreContent(quad: Quad, input: PhotoDetectionInput, greyscale: boolean): PhotoContentScores {
  const { lab, texture, paper, sizeMM, pxPerMM } = input;
  const sizeRange = input.sizeTolerance ?? P.sizeFitRange;
  const bounds = boundsOf(quadPoints(quad));
  const rotated = minAreaRect(quadPoints(quad));

  const varianceCoverage = localVarianceCoverage(lab.L, bounds, paper);
  const textureRatio = textureContrastRatio(texture, bounds, paper);
  const spread = toneSpread(lab.L, bounds);
  const chromaModes = greyscale ? 0 : chromaClusterCount(lab, bounds);

  const quadArea = polygonArea(quadPoints(quad));
  const rectangularity = quadArea / Math.max(1, rotated.width * rotated.height);

  // Size and aspect are checked against the DECLARED physical size, which the
  // admin picked from a dropdown. Guessing it would let a detector accept
  // whatever it found and then rationalise the dimensions.
  const measuredWidthMM = Math.min(rotated.width, rotated.height) / pxPerMM;
  const measuredHeightMM = Math.max(rotated.width, rotated.height) / pxPerMM;
  const expectedShort = Math.min(sizeMM.widthMM, sizeMM.heightMM);
  const expectedLong = Math.max(sizeMM.widthMM, sizeMM.heightMM);

  const shortRatio = measuredWidthMM / expectedShort;
  const longRatio = measuredHeightMM / expectedLong;
  const sizeFit =
    shortRatio >= sizeRange.min &&
    shortRatio <= sizeRange.max &&
    longRatio >= sizeRange.min &&
    longRatio <= sizeRange.max
      ? // Scored against the width of the window it was admitted through, so a
        // drawn declaration's deliberate looseness does not also flatten every
        // candidate's score to zero and take the whole content total with it.
        1 - Math.min(1, (Math.abs(1 - shortRatio) + Math.abs(1 - longRatio)) / (sizeRange.max - sizeRange.min))
      : 0;

  const measuredAspect = measuredWidthMM / Math.max(1e-6, measuredHeightMM);
  const expectedAspect = expectedShort / expectedLong;
  const aspectError = Math.abs(measuredAspect - expectedAspect) / expectedAspect;
  const aspectFit = aspectError <= P.aspectTolerance ? 1 - aspectError / P.aspectTolerance : 0;

  // Ramp between "definitely not" and "definitely yes" rather than a hard step,
  // so a candidate just past a boundary is not scored identically to one far
  // beyond it.
  const ramp = (value: number, low: number, high: number) => Math.max(0, Math.min(1, (value - low) / (high - low)));

  let total =
    0.3 * ramp(varianceCoverage, 0.35, 0.8) +
    0.22 * ramp(textureRatio, 1.15, 1.8) +
    0.2 * ramp(spread, 0.2, 0.5) +
    0.16 * (0.5 * ramp(rectangularity, 0.7, 0.95) + 0.5 * Math.max(sizeFit, aspectFit));

  if (greyscale) {
    // On a page with no colour anywhere, a chroma feature measures nothing. Its
    // weight is redistributed rather than contributing a confident zero to
    // every candidate equally, which would just lower the whole distribution
    // and make the threshold meaningless.
    total += 0.12 * ramp(spread, 0.18, 0.45);
  } else {
    total += 0.12 * ramp(chromaModes, 1, 3);
  }

  return {
    varianceCoverage,
    textureRatio,
    toneSpread: spread,
    chromaModes,
    rectangularity,
    sizeFit,
    aspectFit,
    total,
  };
}

// ---------------------------------------------------------------------------
// Positive absence
// ---------------------------------------------------------------------------

/**
 * Asserts that the box is EMPTY, rather than merely failing to find something.
 *
 * The difference matters to the operator. "The box is empty" is a confident
 * true negative and needs no action if the patient genuinely brought no photo.
 * "I could not find it" is an apology that requires someone to go and look.
 * Showing the second when the first is true trains staff to ignore the message.
 *
 * Every comparison is against THIS SCAN's own paper statistics. Comparing a
 * phone JPEG against a clean template's noise floor is a test that essentially
 * never passes, which silently converts the assertion back into a shrug.
 */
function assessEmptiness(input: PhotoDetectionInput): {
  empty: boolean;
  coverage: number;
  spread: number;
  ink: number;
} {
  const coverage = localVarianceCoverage(input.lab.L, input.expected, input.paper);
  const spread = toneSpread(input.lab.L, input.expected);
  const ink = inkDensity(input.ink, input.expected);

  // The question is "is there a PHOTOGRAPH here", not "is there anything here".
  // Those differ, and the difference is the common case: a printed photo box
  // almost always contains the words "Affix Photograph Here". Requiring the
  // region to be literally unmarked would classify every such box as merely
  // uncertain, and the operator would be asked to go and check a box the system
  // could see perfectly well was empty.
  //
  // A photograph is continuous-tone and covers its whole area. Print is
  // two-valued and sparse — a few thin strokes on paper, occupying almost no
  // tonal range however dark the ink. So emptiness is asserted on the ABSENCE
  // of continuous tone, which printed text cannot fake, rather than on the
  // absence of marks.
  //
  // Ink is reported for telemetry but is deliberately not a gate: it is exactly
  // the signal that printed placeholder text trips.
  const empty = coverage < P.emptyCoverageFraction && spread < P.emptyToneSpread;
  return { empty, coverage, spread, ink };
}

/**
 * Re-lays four fitted edges on the single angle they collectively measured.
 *
 * WHAT MOVES AND WHAT DOES NOT. Only each line's DIRECTION is changed. Its
 * distance from the page origin along its new normal is set so that it still
 * passes through the point where the ORIGINAL fit crossed the middle of that
 * edge — so the offset every line was measured at survives untouched, and the
 * prior contributes nothing but the choice of pivot point along a line it did
 * not place. The template's own edge is never substituted for a measured one,
 * here or anywhere else in this file.
 *
 * Returns null when the four edges disagree about the angle by more than
 * `maxEdgeAngleSpreadDegrees`, because at that point they are not four sides
 * of one rectangle and forcing them into one would invent the answer.
 */
function squareUpEdges(fits: Record<EdgeSide, LineFit>, expected: Rect): Quad | null {
  const sides: EdgeSide[] = ["left", "top", "right", "bottom"];

  /** Each side's opinion of the paste angle, as a rotation in (-90, 90]. */
  const opinions = sides.map((side) => {
    const nominal = side === "left" || side === "right" ? 90 : 0;
    let delta = lineAngleDegrees(fits[side].line) - nominal;
    while (delta <= -90) delta += 180;
    while (delta > 90) delta -= 180;
    const fit = fits[side];
    const weight = fit.inlierRatio * Math.min(1, fit.meanResponse / (P.minResponseSigma * 4));
    return { side, delta, weight };
  });

  // Anchor on the best-evidenced edge rather than on a mean, which a single
  // wild line drags with it — that line is exactly what this exists to correct.
  const anchor = opinions.reduce((best, o) => (o.weight > best.weight ? o : best));
  const agreeing = opinions.filter((o) => Math.abs(o.delta - anchor.delta) <= P.maxEdgeAngleSpreadDegrees);
  // Two adjacent sides are the least that can establish a rectangle's angle
  // from more than one measurement.
  if (agreeing.length < 2) return null;

  const totalWeight = agreeing.reduce((sum, o) => sum + o.weight, 0);
  if (!(totalWeight > 0)) return null;
  const consensus = agreeing.reduce((sum, o) => sum + o.delta * o.weight, 0) / totalWeight;

  const rebuilt = {} as Record<EdgeSide, Line>;
  for (const side of sides) {
    const nominal = side === "left" || side === "right" ? 90 : 0;
    const phi = ((nominal + consensus) * Math.PI) / 180;
    // lineAngleDegrees is atan2(-a, b), so a direction of phi has this normal.
    const a = -Math.sin(phi);
    const b = Math.cos(phi);

    const original = fits[side].line;
    const norm = Math.hypot(original.a, original.b) || 1;
    const unit = { a: original.a / norm, b: original.b / norm, c: original.c / norm };
    // The pivot: where the measured line crosses the middle of this edge.
    const mid = expectedEdgePoint(expected, side);
    const signed = unit.a * mid.x + unit.b * mid.y + unit.c;
    const pivot = { x: mid.x - signed * unit.a, y: mid.y - signed * unit.b };

    rebuilt[side] = { a, b, c: -(a * pivot.x + b * pivot.y) };
  }

  return intersectLinesToQuad(rebuilt.left, rebuilt.top, rebuilt.right, rebuilt.bottom);
}

/** The largest disagreement, in degrees, between any two edges' opinions of the paste angle. */
function edgeAngleSpread(fits: Record<EdgeSide, LineFit>): number {
  const sides: EdgeSide[] = ["left", "top", "right", "bottom"];
  const deltas = sides.map((side) => {
    const nominal = side === "left" || side === "right" ? 90 : 0;
    let delta = lineAngleDegrees(fits[side].line) - nominal;
    while (delta <= -90) delta += 180;
    while (delta > 90) delta -= 180;
    return delta;
  });
  return Math.max(...deltas) - Math.min(...deltas);
}

/** Area of the minimum-area rectangle enclosing a quad. */
function rectArea(quad: Quad): number {
  const rect = minAreaRect(quadPoints(quad));
  return rect.width * rect.height;
}

function polygonArea(points: readonly { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}
