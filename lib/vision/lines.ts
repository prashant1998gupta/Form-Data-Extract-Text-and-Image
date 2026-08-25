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
  const buffer = new Float64Array(window);
  const samples: StepSample[] = [];

  // Leave room for a full window on both sides; a truncated window biases the
  // median and would pull every edge toward the band's centre.
  const searchStart = acrossStart + window - 1;
  const searchEnd = acrossEnd - window;
  if (searchEnd - searchStart < 3) return [];
  const responses = new Float64Array(searchEnd - searchStart);

  for (let along = alongStart; along < alongEnd; along += 1) {
    let bestIndex = -1;
    let bestResponse = 0;

    for (let across = searchStart; across < searchEnd; across += 1) {
      let response = 0;
      for (const channel of channels) {
        // The two windows ABUT: [across-w+1 .. across] and [across+1 .. across+w].
        // They must not skip the pixel at `across`. With a gap, two adjacent
        // positions score identically on a clean step and the tie resolves to
        // whichever came first — a systematic one-pixel bias toward the start
        // of the scan, which on a 35 mm photo is a visible sliver of paper.
        const before = medianAlong(channel.image, vertical, along, across - window + 1, window, buffer);
        const after = medianAlong(channel.image, vertical, along, across + 1, window, buffer);
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

    // THE PLATEAU. A median is robust precisely because it ignores a minority,
    // and that is exactly why the step response does not peak at a point: the
    // median of the trailing window stays "dark" until MORE THAN HALF of it has
    // crossed onto paper. So a window of half-width w yields a flat maximum
    // about w wide, and every position on it scores identically on a clean
    // edge. Taking the first argmax therefore lands anywhere within ±w/2 — on a
    // 35 mm photo at 300 dpi that is a visible strip of paper down one side, or
    // a shaved millimetre off a face.
    //
    // The plateau is symmetric about the true boundary, so its CENTRE is the
    // answer. Walk out from the peak while the response stays within 3 % of the
    // maximum, and take the midpoint of that run.
    const plateauFloor = bestResponse * 0.97;
    let low = bestIndex;
    let high = bestIndex;
    while (low > 0 && responses[low - 1]! >= plateauFloor) low -= 1;
    while (high < responses.length - 1 && responses[high + 1]! >= plateauFloor) high += 1;

    let centre = (low + high) / 2;

    // A single-point maximum is a genuinely sharp edge — a hard cut against
    // strong contrast. Refine that one by parabola instead, which is the
    // better estimator when there is real curvature to fit.
    if (low === high && bestIndex > 0 && bestIndex < responses.length - 1) {
      const previous = responses[bestIndex - 1]!;
      const next = responses[bestIndex + 1]!;
      const denominator = previous - 2 * bestResponse + next;
      if (denominator < -1e-9) {
        centre += Math.max(-0.5, Math.min(0.5, (0.5 * (previous - next)) / denominator));
      }
    }

    // +0.5 places the boundary BETWEEN the two abutting windows rather than on
    // the last pixel of the leading one.
    const across = searchStart + centre + 0.5;
    samples.push({
      point: vertical ? { x: across, y: along } : { x: along, y: across },
      response: bestResponse,
    });
  }

  return samples;
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
export function ransacLineFit(
  samples: readonly StepSample[],
  tolerance: number,
  iterations = 200,
  minResponse = 1.0,
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
  const refined = totalLeastSquaresLine(bestInliers.map((k) => points[k]!));
  if (!refined) return null;

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
