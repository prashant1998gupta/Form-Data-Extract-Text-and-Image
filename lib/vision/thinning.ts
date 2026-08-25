/**
 * Zhang-Suen skeletonisation and skeleton shape analysis.
 *
 * Reduces a stroke mask to a one-pixel-wide centreline, which is what makes
 * "how curvy is this?" and "how long is the longest continuous stroke?"
 * answerable. Both are central to telling a signature from everything else on a
 * form:
 *
 *   signature      long branches, high curvature, frequent direction reversals
 *   printed text   short branches, low curvature, regular character pitch
 *   thumb print    barely skeletonises at all — it is a filled blob
 *   ruled line     one very long branch with essentially zero curvature
 *
 * Zhang-Suen is the classic two-subiteration algorithm. It is chosen over a
 * distance-transform ridge because it guarantees CONNECTIVITY: the skeleton of
 * a connected stroke is a connected curve, which is what lets branch length be
 * measured by walking it. A ridge map does not guarantee that and produces
 * fragments wherever the stroke widens.
 */

import { createMask, type Mask, type Point } from "./types.ts";

/**
 * Thins a binary mask to a one-pixel skeleton.
 *
 * @param maxIterations Safety bound. Zhang-Suen converges in roughly half the
 *   stroke width in iterations, so a real signature needs about five; anything
 *   approaching this limit means the input is not a stroke mask.
 */
export function zhangSuenThin(mask: Mask, maxIterations = 60): Mask {
  const { width, height } = mask;
  const current = new Uint8Array(width * height);
  for (let i = 0; i < current.length; i += 1) current[i] = mask.data[i]! !== 0 ? 1 : 0;

  const marked: number[] = [];
  let changed = true;
  let iteration = 0;

  while (changed && iteration < maxIterations) {
    changed = false;
    iteration += 1;

    for (let step = 0; step < 2; step += 1) {
      marked.length = 0;

      // The border is never eroded: a stroke touching the edge of its crop
      // should not be thinned away for being near the edge.
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = y * width + x;
          if (current[index] === 0) continue;

          // Eight neighbours clockwise from north.
          const p2 = current[index - width]!;
          const p3 = current[index - width + 1]!;
          const p4 = current[index + 1]!;
          const p5 = current[index + width + 1]!;
          const p6 = current[index + width]!;
          const p7 = current[index + width - 1]!;
          const p8 = current[index - 1]!;
          const p9 = current[index - width - 1]!;

          const neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          // Interior pixels (8 neighbours) and endpoints (1) are both preserved.
          if (neighbours < 2 || neighbours > 6) continue;

          // Number of 0->1 transitions going round. Exactly one means removing
          // this pixel cannot disconnect the shape — this is the condition that
          // makes the skeleton topology-preserving.
          const sequence = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let transitions = 0;
          for (let k = 0; k < 8; k += 1) {
            if (sequence[k] === 0 && sequence[k + 1] === 1) transitions += 1;
          }
          if (transitions !== 1) continue;

          // The two subiterations peel opposite sides, which is what keeps the
          // skeleton centred instead of drifting toward one edge.
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          marked.push(index);
        }
      }

      if (marked.length > 0) {
        for (const index of marked) current[index] = 0;
        changed = true;
      }
    }
  }

  const out = createMask(width, height);
  for (let i = 0; i < out.data.length; i += 1) out.data[i] = current[i] === 1 ? 255 : 0;
  return out;
}

export interface SkeletonShape {
  /** Total skeleton pixels — an estimate of total stroke length. */
  readonly length: number;
  /** Longest continuous branch, in pixels. */
  readonly longestBranch: number;
  /** Pixels with exactly one neighbour. A closed loop has none. */
  readonly endpoints: number;
  /** Pixels with three or more neighbours — where strokes cross. */
  readonly junctions: number;
  /** Mean absolute turning angle per step, in radians. Near zero for a straight line. */
  readonly meanCurvature: number;
  /** Direction reversals per 100 px. Cursive oscillates; a rule does not. */
  readonly reversalsPer100px: number;
}

/**
 * Measures the shape of a skeleton.
 *
 * The two headline numbers are curvature and reversals, and they capture
 * different things. A large smooth arc has high curvature and no reversals; a
 * printed 'm' has several reversals but over a very short length. Cursive
 * writing is the only common mark on a form with both sustained curvature and
 * frequent reversals, which is why the pair separates it from ruled lines,
 * printed type and inked blobs at once.
 */
export function skeletonShape(skeleton: Mask): SkeletonShape {
  const { width, height, data } = skeleton;
  const neighbourCount = new Uint8Array(width * height);
  let length = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (data[index] === 0) continue;
      length += 1;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          if (data[ny * width + nx] !== 0) count += 1;
        }
      }
      neighbourCount[index] = count;
    }
  }

  if (length === 0) {
    return { length: 0, longestBranch: 0, endpoints: 0, junctions: 0, meanCurvature: 0, reversalsPer100px: 0 };
  }

  let endpoints = 0;
  let junctions = 0;
  for (let i = 0; i < neighbourCount.length; i += 1) {
    if (data[i] === 0) continue;
    if (neighbourCount[i] === 1) endpoints += 1;
    else if (neighbourCount[i]! >= 3) junctions += 1;
  }

  // Walk each branch from every endpoint, and from an arbitrary point on any
  // loop that has no endpoint at all.
  const visited = new Uint8Array(width * height);
  let longestBranch = 0;
  let turnSum = 0;
  let turnCount = 0;
  let reversals = 0;

  const walkFrom = (start: number) => {
    const path = tracePath(skeleton, neighbourCount, visited, start);
    if (path.length < 2) return;
    if (path.length > longestBranch) longestBranch = path.length;

    let previousAngle: number | null = null;
    let previousTurn = 0;
    // Step in 3-pixel strides: consecutive skeleton pixels only ever differ by
    // one step, so their direction is quantised to 45 degrees and the measured
    // "curvature" would be pixel-grid staircasing rather than real bending.
    for (let i = 3; i < path.length; i += 3) {
      const from = path[i - 3]!;
      const to = path[i]!;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      if (previousAngle !== null) {
        let turn = angle - previousAngle;
        while (turn > Math.PI) turn -= 2 * Math.PI;
        while (turn < -Math.PI) turn += 2 * Math.PI;
        turnSum += Math.abs(turn);
        turnCount += 1;
        if (previousTurn !== 0 && Math.sign(turn) !== Math.sign(previousTurn) && Math.abs(turn) > 0.25) {
          reversals += 1;
        }
        if (Math.abs(turn) > 0.15) previousTurn = turn;
      }
      previousAngle = angle;
    }
  };

  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== 0 && neighbourCount[i] === 1 && visited[i] === 0) walkFrom(i);
  }
  // Anything left is a closed loop — the 'O' of a signature, a circled option.
  for (let i = 0; i < data.length; i += 1) {
    if (data[i] !== 0 && visited[i] === 0) walkFrom(i);
  }

  return {
    length,
    longestBranch,
    endpoints,
    junctions,
    meanCurvature: turnCount === 0 ? 0 : turnSum / turnCount,
    reversalsPer100px: (reversals * 100) / length,
  };
}

/** Walks from a start pixel along the skeleton, preferring unvisited neighbours. */
function tracePath(skeleton: Mask, neighbourCount: Uint8Array, visited: Uint8Array, start: number): Point[] {
  const { width, height, data } = skeleton;
  const path: Point[] = [];
  let current = start;

  while (current >= 0 && visited[current] === 0) {
    visited[current] = 1;
    const x = current % width;
    const y = (current - x) / width;
    path.push({ x, y });

    let next = -1;
    // Straight-ahead neighbours before diagonal ones, so the trace does not
    // zig-zag across a stroke and inflate its measured length by sqrt(2).
    const offsets = [
      [0, -1], [1, 0], [0, 1], [-1, 0],
      [1, -1], [1, 1], [-1, 1], [-1, -1],
    ];
    for (const [dx, dy] of offsets) {
      const nx = x + dx!;
      const ny = y + dy!;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const index = ny * width + nx;
      if (data[index] === 0 || visited[index] !== 0) continue;
      next = index;
      break;
    }
    current = next;
  }

  return path;
}

/**
 * Ink area divided by convex-hull area.
 *
 * The single cleanest separator between the three image elements:
 *
 *   signature    0.25-0.65   an open scrawl; most of its hull is empty
 *   thumb print  0.75-0.95   a filled blob
 *   photograph   > 0.95      a solid rectangle
 *
 * Computed from a component's own pixels, so it is unaffected by how the
 * bounding box happens to be placed — unlike fill ratio, which a single stray
 * speck in a corner can halve.
 */
export function solidity(points: readonly Point[], inkArea: number): number {
  if (points.length < 3 || inkArea <= 0) return 0;
  const hullArea = polygonArea(convexHullOf(points));
  return hullArea <= 0 ? 0 : Math.min(1, inkArea / hullArea);
}

function convexHullOf(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum / 2);
}

/**
 * Regularity of horizontal character pitch, 0..1.
 *
 * Printed and hand-PRINTED text has evenly spaced characters, so the column-sum
 * profile of its ink is close to periodic and its autocorrelation shows a
 * strong peak at the character pitch. Cursive has no such period. This is the
 * feature that catches the dangerous confusion — a hand-printed NAME in the
 * signature box scoring as a signature — which shape features alone miss,
 * because a name in block capitals is genuinely wide, short and inky.
 *
 * A high value on a group inside a signature box is also a registration alarm:
 * it may mean the box is not where the template thinks it is, and the detector
 * is looking at a line of printed terms and conditions.
 */
export function pitchRegularity(mask: Mask, minLag = 4, maxLag = 40): number {
  const { width, height, data } = mask;
  const profile = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) if (data[row + x] !== 0) profile[x] += 1;
  }

  let mean = 0;
  for (let x = 0; x < width; x += 1) mean += profile[x]!;
  mean /= width;

  let variance = 0;
  for (let x = 0; x < width; x += 1) variance += (profile[x]! - mean) ** 2;
  if (variance < 1e-9) return 0;

  let best = 0;
  const highest = Math.min(maxLag, Math.floor(width / 2));
  for (let lag = minLag; lag <= highest; lag += 1) {
    let sum = 0;
    for (let x = 0; x + lag < width; x += 1) sum += (profile[x]! - mean) * (profile[x + lag]! - mean);
    const normalised = sum / variance;
    if (normalised > best) best = normalised;
  }
  return Math.max(0, Math.min(1, best));
}
