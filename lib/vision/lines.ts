/**
 * Edge-step profiling and RANSAC line fitting.
 *
 * This is the core of photograph detection, and the reason it works where
 * appearance-based segmentation does not.
 *
 * The modal Indian passport photo is a person on a white or pale-blue studio
 * backdrop, printed on white photo paper, pasted onto white form paper. Every
 * appearance score — chroma, local variance, darkness, ink density — collapses
 * over the photo's own backdrop. Segmenting an appearance map correctly yields
 * the head and shoulders, not the rectangle, and a head-and-shoulders blob then
 * fails every aspect and rectangularity test. Appearance cannot find this photo.
 *
 * But a pasted photo ALWAYS has a hard physical boundary. There is a step in
 * lightness, or in chroma, or — when the tones genuinely match — in
 * high-frequency texture energy, because emulsion and paper fibre never share a
 * grain. Usually there is also a drop shadow on at least one edge.
 *
 * And because registration already tells us where the box is to within a
 * fraction of a millimetre, we do not have to FIND a rectangle. We only have to
 * MEASURE FOUR LINES. That is a far easier problem, and it degrades gracefully:
 * an edge that cannot be measured fails loudly instead of being silently
 * replaced by a guess.
 *
 * Two design choices carry most of the robustness:
 *
 *  - **Medians, not means**, on both sides of the step. A staple, a dust speck,
 *    a shadow line or one blown-out pixel cannot drag a median. With means, a
 *    single specular row shifts the detected edge by millimetres.
 *  - **Every channel is divided by its own standard deviation measured on
 *    paper in this same scan.** There is no absolute constant anywhere. That is
 *    what makes the same thresholds work on a 170 dpi WhatsApp recompression
 *    and a 600 dpi flatbed scan.
 */

import type { Gray, Point, Quad } from "./types.ts";

/** A line as `a·x + b·y + c = 0`, normalised so `a² + b² = 1` (so `|a·x+b·y+c|` is a true distance). */
export interface Line {
  readonly a: number;
  readonly b: number;
  readonly c: number;
}

export type EdgeSide = "left" | "right" | "top" | "bottom";

/** One channel's contribution to the step response, with its own paper-noise scale. */
export interface WeightedChannel {
  readonly image: Gray;
  readonly weight: number;
  /** Standard deviation of this channel over paper in THIS scan. Never a constant. */
  readonly sigma: number;
}

/**
 * One measured step: the strongest transition found along one scanline.
 *
 * The position is stored as a real (x, y) point rather than as (along, across).
 * The scan axis swaps between vertical and horizontal edges, so carrying the
 * pair around unlabelled invites exactly one bug — fitting the top and bottom
 * edges through transposed coordinates — and that bug produces a quadrilateral
 * that is merely wrong rather than obviously broken.
 */
export interface StepSample {
  readonly point: Point;
  /** Step strength in units of paper sigma. 3.0 is the acceptance floor. */
  readonly response: number;
  /**
   * Set when this step collapses once the outside window is lengthened to
   * match the inside one — the signature of a printed rule sitting in the
   * short outside window rather than a boundary. See `thinOutsideRatio`.
   */
  readonly thin?: boolean;
}

export interface LineFit {
  readonly line: Line;
  readonly inlierRatio: number;
  /** Mean response of the inliers, in paper sigma. */
  readonly meanResponse: number;
  readonly inliers: number;
  readonly samples: number;
}

/**
 * Measures the strongest intensity step across a band, one scanline at a time.
 *
 * @param channels    Independent views of the same region, each with its own paper sigma.
 * @param side        Which edge of the box this band belongs to. Decides the scan axis.
 * @param band        Region to search, in the channels' pixel coordinates.
 * @param halfWindow  Half-width of the median windows either side of the step, in pixels.
 *                    Should be ~0.8 mm at the working resolution.
 */
export function edgeStepProfile(
  channels: readonly WeightedChannel[],
  side: EdgeSide,
  band: { x: number; y: number; width: number; height: number },
  halfWindow: number,
  options: {
    minResponse?: number;
    outermostFraction?: number;
    sustainWindow?: number;
    /**
     * How many candidate steps to keep per scanline.
     *
     * One is not enough, and no threshold makes it enough. A scanline crossing
     * a photo's top edge typically contains three real steps: the form's
     * printed rule above it, the photo boundary, and a strong interior contour
     * such as a hairline. Picking the strongest returns the hairline; picking
     * the outermost returns the printed rule; picking by any absolute threshold
     * depends on paper noise that varies by an order of magnitude between a
     * flatbed scan and a phone capture.
     *
     * Keeping all three and letting a global fit decide is what actually works,
     * because the three competitors differ in a way a single scanline cannot
     * see but a whole edge can: only one of them forms a line at the distance
     * registration predicts.
     */
    peaksPerLine?: number;
    /**
     * MARKS a candidate step whose response collapses when the OUTSIDE window
     * is lengthened to match the inside one (`StepSample.thin`). 0 disables.
     *
     * The sustain window below is one-sided. It rejects a printed rule that
     * falls INSIDE the object — three dark pixels cannot move the median of a
     * 3 mm window — but a rule that falls in the short OUTSIDE window makes
     * that median dark, and a dark outside against a bright inside is exactly
     * what a boundary looks like. Measured on the pale-backdrop fixture, the
     * form's header rule 4 mm above the photograph produced a 50-sigma step
     * seen by 100 % of scanlines, while the photograph's own faint top edge
     * lost to it. Every printed "Affix photo" border is a rule a few
     * millimetres outside a photograph, so this is not a corner case.
     *
     * A real boundary has paper for the whole of a 3 mm outside window and
     * object for the whole of a 3 mm inside window, so lengthening the outside
     * window leaves its response alone. A rule's response vanishes. A sample
     * whose long-outside response is under this fraction of its short-outside
     * one is marked `thin`.
     *
     * MARKED, NOT DROPPED, and the difference is a product behaviour. An
     * EMPTY printed photo box has nothing in it but its border, and the only
     * way the detector can say "this box was located and is empty" — the
     * confident true negative the verify screen is built around — is to fit
     * that border. Dropping rule-like steps here turned that into "an edge
     * could not be measured", which is an apology where a fact was available.
     * So the caller decides what a rule-built line is worth: `photo.ts`
     * penalises it in the edge score, so a real boundary beats it whenever
     * one exists, and it is still there to be fitted when nothing else is.
     */
    thinOutsideRatio?: number;
  } = {},
): StepSample[] {
  if (channels.length === 0) throw new Error("edgeStepProfile: no channels");
  const vertical = side === "left" || side === "right";
  const first = channels[0]!.image;

  const x0 = Math.max(0, Math.floor(band.x));
  const y0 = Math.max(0, Math.floor(band.y));
  const x1 = Math.min(first.width, Math.ceil(band.x + band.width));
  const y1 = Math.min(first.height, Math.ceil(band.y + band.height));
  if (x1 - x0 < 3 || y1 - y0 < 3) return [];

  // Scan along the edge; search across it.
  const alongStart = vertical ? y0 : x0;
  const alongEnd = vertical ? y1 : x1;
  const acrossStart = vertical ? x0 : y0;
  const acrossEnd = vertical ? x1 : y1;

  const window = Math.max(1, Math.round(halfWindow));

  /**
   * SUSTAIN — the window that separates a boundary from a printed line.
   *
   * A pasted photograph and a printed rule both produce a strong, straight,
   * correctly-oriented step, and no amount of tuning a response threshold tells
   * them apart: on a clean scan where paper noise is ~1 grey level, even a 2 px
   * rule that a median has largely suppressed still clears any floor a faint
   * photo edge also has to clear. Measured on the reference fixture, 58 of 146
   * scanlines locked onto the form's printed header rule instead of the photo
   * 29 px below it.
   *
   * The difference is physical, not statistical. A rule is a step down and
   * immediately back up — a few tenths of a millimetre of ink. A photo edge is
   * a step that STAYS stepped for the entire height of the photograph. So the
   * inside window is made much longer than the outside one: a rule fails
   * because its long inside window is mostly paper again, while a photo edge
   * passes because everything inside it really is photograph.
   *
   * This also makes the detector robust to the form's box borders, underlines
   * and table gridlines generally, which is most of what surrounds a photo box.
   */
  const sustain = Math.max(window, Math.round(options.sustainWindow ?? window));
  const buffer = new Float64Array(Math.max(window, sustain));
  const samples: StepSample[] = [];

  // Which direction is "inside" the object? For a left or top edge the band
  // runs outside -> inside, so the inside is the higher index.
  const insideIsHigher = side === "left" || side === "top";

  // Leave room for a full window on both sides; a truncated window biases the
  // median and would pull every edge toward the band's centre. The inside
  // window is the long one, so the margin it needs depends on which side it is.
  const leadingWindow = insideIsHigher ? window : sustain;
  const trailingWindow = insideIsHigher ? sustain : window;
  const searchStart = acrossStart + leadingWindow - 1;
  const searchEnd = acrossEnd - trailingWindow;
  if (searchEnd - searchStart < 3) return [];
  const responses = new Float64Array(searchEnd - searchStart);

  for (let along = alongStart; along < alongEnd; along += 1) {
    let bestIndex = -1;
    let bestResponse = 0;

    for (let across = searchStart; across < searchEnd; across += 1) {
      let response = 0;
      for (const channel of channels) {
        // The two windows ABUT: they meet between `across` and `across+1` and
        // must not skip the pixel at `across`. With a gap, two adjacent
        // positions score identically on a clean step and the tie resolves to
        // whichever came first — a systematic one-pixel bias toward the start
        // of the scan, which on a 35 mm photo is a visible sliver of paper.
        const before = medianAlong(channel.image, vertical, along, across - leadingWindow + 1, leadingWindow, buffer);
        const after = medianAlong(channel.image, vertical, along, across + 1, trailingWindow, buffer);
        response += (channel.weight * Math.abs(before - after)) / Math.max(1e-6, channel.sigma);
      }
      const index = across - searchStart;
      responses[index] = response;
      if (response > bestResponse) {
        bestResponse = response;
        bestIndex = index;
      }
    }

    if (bestIndex < 0) continue;

    // Emit up to `peaksPerLine` candidate steps from this scanline.
    //
    // Each is a PLATEAU CENTRE, not an argmax. A median is robust precisely
    // because it ignores a minority, which is why the step response does not
    // peak at a point: the trailing median does not flip until more than half
    // its window has crossed the edge. A window of length T therefore produces
    // a flat maximum, and any single position on it scores the same as any
    // other. Taking the first index found lands anywhere within that run — on a
    // 35 mm photo that is a visible strip of paper down one side.
    const floor = Math.max(options.minResponse ?? 8, bestResponse * (options.outermostFraction ?? 0.15));
    const wanted = Math.max(1, options.peaksPerLine ?? 1);
    const thinOutsideRatio = options.thinOutsideRatio ?? 0;
    // Plateaus already emitted, as index ranges. The next peak may not fall
    // inside one of these, or within a short window of it.
    //
    // THIS USED TO BE A FIXED RADIUS of `trailingWindow` around each peak's
    // argmax, and that radius was the long inside window — 3 mm. A second
    // real step beginning within 3 mm of the first peak's argmax was therefore
    // never emitted, whatever its plateau looked like. The step that begins
    // there, on nearly every real form, is the photograph's own edge just
    // inside its printed "Affix photo" border: measured on the pale-backdrop
    // fixture, the header rule's argmax sat 18 px from the start of the true
    // top edge's plateau, so the edge was never a candidate on any scanline
    // that also saw the rule — which was all of them — and the rule was fitted
    // as the boundary with 100 % support. The plateau IS the extent of a step;
    // excluding by plateau excludes exactly the same feature seen twice and
    // nothing else.
    const taken: { low: number; high: number }[] = [];
    let emitted = 0;

    // Bounded by the number of distinct plateaus a scanline can hold, so a
    // scanline of nothing but rejected candidates still terminates.
    for (let attempt = 0; emitted < wanted && attempt < responses.length; attempt += 1) {
      let index = -1;
      let value = 0;
      for (let i = 0; i < responses.length; i += 1) {
        const candidate = responses[i]!;
        if (candidate < floor || candidate <= value) continue;
        // Skip anything already claimed by an earlier peak's plateau.
        if (taken.some((t) => i >= t.low - window && i <= t.high + window)) continue;
        value = candidate;
        index = i;
      }
      if (index < 0) break;

      // A step that disappears when the outside window is lengthened was a
      // thin feature sitting in the short one, not a boundary. See
      // `thinOutsideRatio` above.
      let thin = false;
      if (thinOutsideRatio > 0) {
        const across = searchStart + index;
        const longResponse = longOutsideResponse(channels, vertical, along, across, insideIsHigher, acrossStart, acrossEnd, sustain, buffer);
        thin = longResponse < thinOutsideRatio * value;
      }
      emitted += 1;

      // Walk out while the response stays within 3 % of this peak: that run is
      // the plateau, and it is symmetric about the true edge.
      const plateauFloor = value * 0.97;
      let low = index;
      let high = index;
      while (low > 0 && responses[low - 1]! >= plateauFloor) low -= 1;
      while (high < responses.length - 1 && responses[high + 1]! >= plateauFloor) high += 1;

      taken.push({ low, high });

      let centre = (low + high) / 2;

      // A single-point maximum is a genuinely sharp edge against strong
      // contrast; a parabola through its neighbours is the better estimator
      // there, since there is real curvature to fit.
      if (low === high && index > 0 && index < responses.length - 1) {
        const previous = responses[index - 1]!;
        const next = responses[index + 1]!;
        const denominator = previous - 2 * value + next;
        if (denominator < -1e-9) {
          centre += Math.max(-0.5, Math.min(0.5, (0.5 * (previous - next)) / denominator));
        }
      }

      // ASYMMETRY CORRECTION. The plateau is only symmetric about the true edge
      // when both windows are the same length. Write e for the boundary, L for
      // the leading (outside) window and T for the trailing (inside) one. The
      // leading median flips once more than half of it has crossed the edge, at
      // across = e + L/2; the trailing median flips at across = e - T/2. So the
      // plateau runs from e - T/2 to e + L/2 and its centre sits at
      // e + (L - T)/4 — biased OUTWARD by 3.25 px for the 0.8 mm / 3 mm window
      // pair used here, which is a millimetre of extra paper on every edge.
      // Subtracting the term recovers e, and it is exactly zero when L == T, so
      // the symmetric path is unaffected.
      const asymmetry = (leadingWindow - trailingWindow) / 4;
      // +0.5 places the boundary BETWEEN the two abutting windows rather than
      // on the last pixel of the leading one.
      const across = searchStart + centre - asymmetry + 0.5;
      samples.push({
        point: vertical ? { x: across, y: along } : { x: along, y: across },
        response: value,
        ...(thin ? { thin } : {}),
      });
    }
  }

  return samples;
}

/**
 * The step response at `across` with BOTH windows the long (sustain) length,
 * clamped to the band. Used only to confirm a candidate found with the short
 * outside window; see `thinOutsideRatio`.
 */
function longOutsideResponse(
  channels: readonly WeightedChannel[],
  vertical: boolean,
  along: number,
  across: number,
  insideIsHigher: boolean,
  acrossStart: number,
  acrossEnd: number,
  sustain: number,
  buffer: Float64Array,
): number {
  // Outside is the leading side when the inside is the higher index.
  let outsideStart: number;
  let outsideCount: number;
  let insideStart: number;
  let insideCount: number;
  if (insideIsHigher) {
    outsideStart = Math.max(acrossStart, across - sustain + 1);
    outsideCount = across - outsideStart + 1;
    insideStart = across + 1;
    insideCount = Math.min(sustain, acrossEnd - insideStart);
  } else {
    insideStart = Math.max(acrossStart, across - sustain + 1);
    insideCount = across - insideStart + 1;
    outsideStart = across + 1;
    outsideCount = Math.min(sustain, acrossEnd - outsideStart);
  }
  if (outsideCount < 1 || insideCount < 1) return Number.POSITIVE_INFINITY;

  let response = 0;
  for (const channel of channels) {
    const outside = medianAlong(channel.image, vertical, along, outsideStart, outsideCount, buffer);
    const inside = medianAlong(channel.image, vertical, along, insideStart, insideCount, buffer);
    response += (channel.weight * Math.abs(outside - inside)) / Math.max(1e-6, channel.sigma);
  }
  return response;
}

/** Median of `count` samples starting at `start`, taken across the scan axis. */
function medianAlong(
  image: Gray,
  vertical: boolean,
  along: number,
  start: number,
  count: number,
  buffer: Float64Array,
): number {
  for (let i = 0; i < count; i += 1) {
    const x = vertical ? start + i : along;
    const y = vertical ? along : start + i;
    buffer[i] = image.data[y * image.width + x]!;
  }
  // Insertion sort. `count` is ~9; anything cleverer is slower at this size.
  for (let i = 1; i < count; i += 1) {
    const value = buffer[i]!;
    let j = i - 1;
    while (j >= 0 && buffer[j]! > value) {
      buffer[j + 1] = buffer[j]!;
      j -= 1;
    }
    buffer[j + 1] = value;
  }
  const middle = count >> 1;
  return count % 2 === 1 ? buffer[middle]! : (buffer[middle - 1]! + buffer[middle]!) / 2;
}

/**
 * Fits a line through step samples with RANSAC, ordered PROSAC-style.
 *
 * PROSAC ordering — trying the strongest-response samples first — matters here
 * because the inlier fraction can be low. A photo edge crossed by a glare band
 * or a staple may only produce clean steps on 60 % of its scanlines, and
 * uniform random sampling wastes most iterations drawing from the noisy 40 %.
 * Drawing preferentially from high-response samples finds the true line in a
 * handful of iterations instead of hundreds.
 *
 * @param tolerance Inlier distance in pixels. Should be ~0.25 mm at the working
 *                  resolution — tight, because the whole point is sub-pixel
 *                  boundary accuracy.
 */
export interface LineOrientation {
  /** The direction the line is expected to run, in degrees: 0 horizontal, 90 vertical. */
  readonly angleDegrees: number;
  /** How far from that a hypothesis may lie and still be considered. */
  readonly maxDeviationDegrees: number;
}

export function ransacLineFit(
  samples: readonly StepSample[],
  tolerance: number,
  iterations = 200,
  minResponse = 1.0,
  orientation?: LineOrientation,
): LineFit | null {
  const usable = samples.filter((s) => s.response >= minResponse);
  if (usable.length < 8) return null;

  // PROSAC ordering: strongest first.
  const ordered = [...usable].sort((a, b) => b.response - a.response);
  const points: Point[] = ordered.map((s) => s.point);

  let bestInliers: number[] = [];
  let bestLine: Line | null = null;

  // Deterministic pseudo-random draw. A seeded generator keeps the whole
  // pipeline reproducible: the same scan must always produce the same crop, or
  // a failure cannot be investigated.
  let state = 0x2f6e2b1 >>> 0;
  const nextRandom = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // Grow the sampling pool from the strongest samples outward.
    const poolSize = Math.min(points.length, Math.max(8, Math.floor((iteration / iterations) * points.length) + 8));
    const i = Math.floor(nextRandom() * poolSize);
    let j = Math.floor(nextRandom() * poolSize);
    if (i === j) j = (j + 1) % poolSize;

    const line = lineThrough(points[i]!, points[j]!);
    if (!line) continue;
    // ORIENTATION IS A CONSTRAINT, NOT A FILTER. Checking the angle after the
    // fit — which is what `photo.ts` used to do — lets a hypothesis that could
    // never be accepted win the inlier count anyway and consume a candidate
    // slot. Measured on the pale-backdrop fixture, the top band's three
    // candidates were the printed rule and two contours of the head at 15
    // degrees; the photograph's own edge, at 180 degrees with 95 samples, was
    // never returned because a diagonal through the scattered cloud always
    // collected more inliers than any horizontal slice of it. Refusing the
    // diagonals HERE leaves the slots for lines that can actually be edges.
    if (orientation && angleDifference(lineAngleDegrees(line), orientation.angleDegrees) > orientation.maxDeviationDegrees) {
      continue;
    }

    const inliers: number[] = [];
    for (let k = 0; k < points.length; k += 1) {
      if (Math.abs(distanceToLine(line, points[k]!)) <= tolerance) inliers.push(k);
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
      bestLine = line;
    }
  }

  if (!bestLine || bestInliers.length < 8) return null;

  // Refit on all inliers by total least squares — the two-point hypothesis is
  // only a seed, and using it as the answer throws away most of the evidence.
  //
  // Unless the refit leaves the permitted orientation: the hypothesis was
  // admitted on its angle, and a refined line that drifts past the limit is
  // no longer the line that was admitted. Measured, an 11.9-degree hypothesis
  // through a head contour refined to 12.7 and was returned past a 12-degree
  // cap. The seed line keeps the constraint honest; the evidence it loses is
  // the sub-pixel polish, which a contour was never going to deserve.
  const fitted = totalLeastSquaresLine(bestInliers.map((k) => points[k]!));
  if (!fitted) return null;
  const refined =
    orientation && angleDifference(lineAngleDegrees(fitted), orientation.angleDegrees) > orientation.maxDeviationDegrees
      ? bestLine
      : fitted;

  const finalInliers: number[] = [];
  let responseSum = 0;
  for (let k = 0; k < points.length; k += 1) {
    if (Math.abs(distanceToLine(refined, points[k]!)) <= tolerance) {
      finalInliers.push(k);
      responseSum += ordered[k]!.response;
    }
  }
  if (finalInliers.length === 0) return null;

  return {
    line: refined,
    inlierRatio: finalInliers.length / points.length,
    meanResponse: responseSum / finalInliers.length,
    inliers: finalInliers.length,
    samples: points.length,
  };
}

/**
 * Fits several competing lines to the same sample set, strongest first.
 *
 * A single RANSAC pass answers "what is the best-supported line here", which is
 * the wrong question when a scanline band legitimately contains more than one
 * real line. The band above a pasted photograph usually holds three: the form's
 * printed rule, the photo's boundary, and an interior contour such as a
 * hairline. All three are genuine, straight and well-supported; the strongest
 * is frequently not the one we want.
 *
 * So the caller gets all of them and decides using information this function
 * does not have — chiefly how far each sits from where registration predicted
 * the edge would be. That prior is what separates a photo edge from a printed
 * rule 4 mm away, and no purely local measurement can.
 *
 * Each pass removes its own inliers before the next runs, so the candidates are
 * genuinely distinct rather than three near-copies of the same line.
 */
export function fitLineCandidates(
  samples: readonly StepSample[],
  tolerance: number,
  maxLines = 3,
  iterations = 200,
  minResponse = 1,
  orientation?: LineOrientation,
): LineFit[] {
  const found: LineFit[] = [];
  let pool = [...samples];

  for (let pass = 0; pass < maxLines; pass += 1) {
    const fit = ransacLineFit(pool, tolerance, iterations, minResponse, orientation);
    if (!fit) break;
    found.push(fit);
    const remaining = pool.filter((s) => Math.abs(distanceToLine(fit.line, s.point)) > tolerance * 2);
    // No progress means the pass consumed nothing; stop rather than loop.
    if (remaining.length === pool.length || remaining.length < 8) break;
    pool = remaining;
  }

  return found;
}

/**
 * Builds a line through two points. Returns null when they coincide.
 * Normalised so distance evaluation is exact.
 */
export function lineThrough(p: Point, q: Point): Line | null {
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;
  // Normal is perpendicular to the direction.
  const a = -dy / length;
  const b = dx / length;
  return { a, b, c: -(a * p.x + b * p.y) };
}

export function distanceToLine(line: Line, point: Point): number {
  return line.a * point.x + line.b * point.y + line.c;
}

/**
 * Total least squares line fit — minimises PERPENDICULAR distance.
 *
 * Ordinary least squares minimises vertical distance, which is undefined for a
 * vertical line and badly biased for a steep one. A photo's left and right
 * edges are near-vertical by construction, so OLS is not merely suboptimal
 * here, it is the wrong estimator. TLS via the eigenvector of the scatter
 * matrix handles every orientation identically.
 */
export function totalLeastSquaresLine(points: readonly Point[]): Line | null {
  if (points.length < 2) return null;
  let meanX = 0;
  let meanY = 0;
  for (const p of points) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= points.length;
  meanY /= points.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  // Smallest-eigenvalue eigenvector of [[sxx, sxy], [sxy, syy]] is the normal.
  const difference = sxx - syy;
  const discriminant = Math.sqrt(difference * difference + 4 * sxy * sxy);
  const smallest = (sxx + syy - discriminant) / 2;

  let a = sxy;
  let b = smallest - sxx;
  let norm = Math.hypot(a, b);
  if (norm < 1e-12) {
    // Degenerate scatter: the points are a perfect axis-aligned line.
    a = sxx >= syy ? 0 : 1;
    b = sxx >= syy ? 1 : 0;
    norm = 1;
  }
  a /= norm;
  b /= norm;
  return { a, b, c: -(a * meanX + b * meanY) };
}

/** Intersection of two lines, or null when they are parallel to within a hair. */
export function intersectLines(first: Line, second: Line): Point | null {
  const determinant = first.a * second.b - second.a * first.b;
  if (Math.abs(determinant) < 1e-9) return null;
  return {
    x: (first.b * second.c - second.b * first.c) / determinant,
    y: (second.a * first.c - first.a * second.c) / determinant,
  };
}

/**
 * Corners of the quadrilateral bounded by four fitted lines.
 *
 * Returns null if any adjacent pair is parallel — which is the honest answer
 * when an edge fit has gone wrong, and far better than emitting a corner at
 * infinity that later stages would clamp into something plausible-looking.
 */
export function intersectLinesToQuad(left: Line, top: Line, right: Line, bottom: Line): Quad | null {
  const tl = intersectLines(left, top);
  const tr = intersectLines(right, top);
  const br = intersectLines(right, bottom);
  const bl = intersectLines(left, bottom);
  if (!tl || !tr || !br || !bl) return null;
  return { tl, tr, br, bl };
}

/**
 * Angle of a line in degrees, in [0, 180).
 * Used to check a fitted edge is roughly where the template says it should be —
 * a "left edge" that comes back at 40 degrees is a fit through noise.
 */
export function lineAngleDegrees(line: Line): number {
  // Direction is perpendicular to the normal (a, b).
  let degrees = (Math.atan2(-line.a, line.b) * 180) / Math.PI;
  while (degrees < 0) degrees += 180;
  while (degrees >= 180) degrees -= 180;
  return degrees;
}

/** Smallest absolute difference between two angles, accounting for 180-degree wrap. */
export function angleDifference(first: number, second: number): number {
  const raw = Math.abs(first - second) % 180;
  return Math.min(raw, 180 - raw);
}
