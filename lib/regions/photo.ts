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
 * And because registration tells us where the box is to a fraction of a
 * millimetre, we never have to FIND a rectangle. We measure four lines. That is
 * a much easier problem, it yields the paste angle for free, and it fails
 * loudly — an edge that cannot be measured is reported as such, rather than
 * being quietly replaced by the template's own edge.
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
  /** Declared physical size. Chosen by the admin at template build time, never guessed. */
  readonly sizeMM: { readonly widthMM: number; readonly heightMM: number };
  /** Working-image pixels per millimetre of paper. */
  readonly pxPerMM: number;
  /** The pre-printed "Affix Photo" rectangle, if the template records one. */
  readonly printedBorder?: Rect;
  /** Fraction of the whole page carrying colour. Below ~2 %, chroma features are dropped. */
  readonly pageSaturatedFraction: number;
}

export interface EdgeReport {
  readonly side: EdgeSide;
  readonly fitted: boolean;
  readonly inlierRatio: number;
  readonly responseSigma: number;
  /** Set when a second, parallel candidate existed and the inner one was chosen. */
  readonly preferredInner?: boolean;
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

  const bandPx = P.edgeBandMM * pxPerMM;
  const windowPx = Math.max(2, Math.round(P.stepWindowMM * pxPerMM));
  // The inside window must be long enough that a printed rule or box border
  // cannot fill it, but short enough to fit inside the photo's own body.
  const sustainPx = Math.max(windowPx * 2, Math.round(P.sustainWindowMM * pxPerMM));
  const tolerancePx = Math.max(1, P.lineToleranceMM * pxPerMM);

  const sides: EdgeSide[] = ["left", "top", "right", "bottom"];
  const fits: Partial<Record<EdgeSide, LineFit>> = {};
  const reports: EdgeReport[] = [];

  for (const side of sides) {
    const band = bandFor(expected, side, bandPx);
    // The outermost qualifying step is the object's boundary; anything further
    // in is its content. The floor is a comfortable multiple of the acceptance
    // threshold so paper grain can never qualify, while a genuine paper-to-photo
    // transition — even a low-contrast one — always does.
    const samples = edgeStepProfile(channels, side, band, windowPx, {
      minResponse: P.minResponseSigma * 2.5,
      sustainWindow: sustainPx,
      peaksPerLine: 3,
    });
    const result = fitEdge(samples, side, tolerancePx, input, expected);

    if (!result) {
      reports.push({ side, fitted: false, inlierRatio: 0, responseSigma: 0 });
      continue;
    }
    fits[side] = result.fit;
    reports.push({
      side,
      fitted: true,
      inlierRatio: result.fit.inlierRatio,
      responseSigma: result.fit.meanResponse,
      preferredInner: result.preferredInner,
    });
  }

  const unfitted = reports.filter((r) => !r.fitted);
  if (unfitted.length > 0) {
    // An edge that could not be measured is NOT replaced by the template's own
    // edge. Substituting the prior here is exactly how a detector starts
    // returning the printed box every time and calling it a photograph.
    const emptiness = assessEmptiness(input);
    return {
      found: false,
      reason: emptiness.empty ? "box_empty" : "below_threshold",
      failedClause: "boundary",
      detail: emptiness.empty
        ? "the photo box was located and is empty"
        : `${unfitted.length} of 4 edges could not be measured (${unfitted.map((r) => r.side).join(", ")})`,
      edges: reports,
    };
  }

  const quad = intersectLinesToQuad(fits.left!.line, fits.top!.line, fits.right!.line, fits.bottom!.line);
  if (!quad) {
    return {
      found: false,
      reason: "below_threshold",
      failedClause: "boundary",
      detail: "the fitted edges do not intersect into a quadrilateral",
      edges: reports,
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
      edges: reports,
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
      edges: reports,
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
        `expected ${sizeMM.widthMM}x${sizeMM.heightMM} mm`,
      edges: reports,
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
    reports.reduce((sum, r) => sum + Math.min(1, r.responseSigma / 8) * Math.min(1, r.inlierRatio / 0.85), 0) / 4;
  let confidence = 0.45 * boundaryStrength + 0.55 * Math.min(1, content.total);
  if (greyscale) confidence = Math.min(confidence, P.greyscaleConfidenceCap);

  return { found: true, quad, rotationDegrees, content, confidence, edges: reports, greyscale };
}

// ---------------------------------------------------------------------------
// Edge fitting with printed-border disambiguation
// ---------------------------------------------------------------------------

interface EdgeResult {
  readonly fit: LineFit;
  readonly preferredInner?: boolean;
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
): EdgeResult | null {
  // Support is measured against the number of SCANLINES, not the number of
  // samples. With three candidate peaks emitted per scanline, an edge that
  // every single scanline agrees on still only owns a third of the samples, so
  // a ratio computed over samples would put a perfect edge at 0.33 and fail it
  // against a 0.55 floor. The question the threshold is asking — "did most
  // scanlines see this edge?" — needs the scanline count as its denominator.
  const scanlines = countScanlines(samples, side);
  if (scanlines < 8) return null;

  const candidates = fitLineCandidates(samples, tolerancePx, 3, P.ransacIterations, 1)
    .map((fit) => ({ ...fit, inlierRatio: Math.min(1, fit.inliers / scanlines) }))
    .filter((fit) => acceptable(fit, side));
  if (candidates.length === 0) return null;

  // Where registration says this edge should be, and how far it might be out.
  const anchor = expectedEdgePoint(expected, side);
  const priorSigmaPx = Math.max(1, P.priorSigmaMM * input.pxPerMM);

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
  const scored = candidates.map((fit) => {
    const offset = Math.abs(distance(fit.line, anchor));
    const agreement = Math.exp(-0.5 * (offset / priorSigmaPx) ** 2);
    const strength = Math.min(1, fit.meanResponse / (P.minResponseSigma * 4));
    return { fit, score: fit.inlierRatio * strength * agreement, offset };
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
  if (!input.printedBorder) return { fit: best.fit };

  const bestOnBorder = distanceToRectEdge(input.printedBorder, side, best.fit.line);
  if (bestOnBorder > P.printedBorderMM * input.pxPerMM) return { fit: best.fit };

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
    if (best.fit.meanResponse >= other.fit.meanResponse * P.printedBorderMargin) continue;
    return { fit: other.fit, preferredInner: true };
  }

  return { fit: best.fit };
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
function acceptable(fit: LineFit, side: EdgeSide): boolean {
  if (fit.inlierRatio < P.minInlierRatioFloor) return false;
  if (fit.meanResponse < P.minResponseSigma) return false;

  // A "left edge" returned at 40 degrees is a fit through noise, not an edge.
  // Photos are pasted crooked but never diagonally.
  const expectedAngle = side === "left" || side === "right" ? 90 : 0;
  if (angleDifference(lineAngleDegrees(fit.line), expectedAngle) > 20) return false;

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
  switch (side) {
    case "left":
      return { x: expected.x - bandPx, y: expected.y + trimY, width: bandPx * 2, height: expected.height - trimY * 2 };
    case "right":
      return {
        x: expected.x + expected.width - bandPx,
        y: expected.y + trimY,
        width: bandPx * 2,
        height: expected.height - trimY * 2,
      };
    case "top":
      return { x: expected.x + trimX, y: expected.y - bandPx, width: expected.width - trimX * 2, height: bandPx * 2 };
    case "bottom":
      return {
        x: expected.x + trimX,
        y: expected.y + expected.height - bandPx,
        width: expected.width - trimX * 2,
        height: bandPx * 2,
      };
  }
}

// ---------------------------------------------------------------------------
// Content scoring — accept or reject only, never segment
// ---------------------------------------------------------------------------

function scoreContent(quad: Quad, input: PhotoDetectionInput, greyscale: boolean): PhotoContentScores {
  const { lab, texture, paper, sizeMM, pxPerMM } = input;
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
    shortRatio >= P.sizeFitRange.min &&
    shortRatio <= P.sizeFitRange.max &&
    longRatio >= P.sizeFitRange.min &&
    longRatio <= P.sizeFitRange.max
      ? 1 - Math.min(1, (Math.abs(1 - shortRatio) + Math.abs(1 - longRatio)) / 0.6)
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

function polygonArea(points: readonly { x: number; y: number }[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}
