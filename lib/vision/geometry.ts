/**
 * Projective geometry: convex hull, minimum-area rectangle, homography
 * estimation and perspective warping.
 *
 * This is what turns a phone snapshot into something measurable. A form
 * photographed at arm's length is a projective transform of the real page —
 * parallel edges converge, the far end is smaller, and a field box that is a
 * rectangle on paper is a general quadrilateral in the image. Every stored
 * template coordinate assumes a flat, square-on page, so nothing in the
 * template system works until the page has been rectified.
 *
 * A homography (8 degrees of freedom, 3x3 up to scale) is the exact model for
 * a plane viewed by a pinhole camera. It is not an approximation for our case;
 * paper is flat. It cannot model a *creased* or *curled* page, which is a real
 * and acknowledged limit — see the failure notes in docs/04.
 */

import { sampleBilinear } from "./gray.ts";
import {
  createGray,
  type Gray,
  type Matrix3,
  type Point,
  type Quad,
  type RotatedRect,
  boundsOf,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Convex hull and minimum-area rectangle
// ---------------------------------------------------------------------------

/**
 * Andrew's monotone chain. O(n log n), returns the hull counter-clockwise in a
 * y-down image coordinate system, without duplicating the first point.
 *
 * Collinear points are excluded (the `<= 0` test), which keeps the hull minimal
 * and makes the rotating-caliper step below cheaper and exact.
 */
export function convexHull(points: readonly Point[]): Point[] {
  if (points.length < 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

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

function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

/**
 * Smallest-area enclosing rectangle, by rotating calipers.
 *
 * Uses the theorem that the minimum-area rectangle shares an edge with the
 * convex hull, so trying each hull edge as the rectangle's orientation is
 * exhaustive rather than a search. That exactness matters: this is what
 * measures how rotated a pasted photograph is, and an approximate answer means
 * a crop with a wedge of form paper down one side.
 */
export function minAreaRect(points: readonly Point[]): RotatedRect {
  const hull = convexHull(points);
  if (hull.length === 0) throw new Error("minAreaRect: no points");
  if (hull.length < 3) {
    const bounds = boundsOf(hull);
    return {
      cx: bounds.x + bounds.width / 2,
      cy: bounds.y + bounds.height / 2,
      width: bounds.width,
      height: bounds.height,
      angle: 0,
    };
  }

  let best: RotatedRect | null = null;
  let bestArea = Infinity;

  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[i]!;
    const b = hull[(i + 1) % hull.length]!;
    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const length = Math.hypot(edgeX, edgeY);
    if (length < 1e-9) continue;
    const ux = edgeX / length;
    const uy = edgeY / length;

    // Project every hull point onto the edge direction and its normal.
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = -p.x * uy + p.y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const width = maxU - minU;
    const height = maxV - minV;
    const area = width * height;
    if (area < bestArea) {
      bestArea = area;
      const midU = (minU + maxU) / 2;
      const midV = (minV + maxV) / 2;
      best = {
        // Rotate the centre back out of the edge-aligned frame.
        cx: midU * ux - midV * uy,
        cy: midU * uy + midV * ux,
        width,
        height,
        angle: Math.atan2(uy, ux),
      };
    }
  }

  if (!best) throw new Error("minAreaRect: degenerate hull");
  return normalizeAngle(best);
}

/**
 * Puts a rotated rect in a canonical form: angle in [-PI/4, PI/4] where
 * possible, with width the edge more aligned to horizontal.
 *
 * Without this, the same physical rectangle is described four different ways
 * depending on which hull edge won, and any downstream "is this rotated more
 * than 5 degrees?" test becomes a coin flip.
 */
function normalizeAngle(rect: RotatedRect): RotatedRect {
  let { width, height, angle } = rect;
  // Fold into (-PI/2, PI/2].
  while (angle > Math.PI / 2) angle -= Math.PI;
  while (angle <= -Math.PI / 2) angle += Math.PI;
  // Past 45 degrees, describe it as the other edge instead.
  if (angle > Math.PI / 4) {
    angle -= Math.PI / 2;
    [width, height] = [height, width];
  } else if (angle < -Math.PI / 4) {
    angle += Math.PI / 2;
    [width, height] = [height, width];
  }
  return { cx: rect.cx, cy: rect.cy, width, height, angle };
}

/**
 * Ramer-Douglas-Peucker simplification of a closed polygon.
 *
 * Page detection uses it to ask "is this blob's outline essentially four
 * straight sides?" — the answer is yes exactly when simplifying at a tolerance
 * of a couple of percent of the perimeter leaves four vertices.
 */
export function approxPolygon(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  // Split the closed loop at its two most distant points so the open-curve
  // algorithm can be applied to each half.
  let farthestA = 0;
  let farthestB = 0;
  let maxDistance = -1;
  for (let i = 1; i < points.length; i += 1) {
    const d = distanceSquared(points[0]!, points[i]!);
    if (d > maxDistance) {
      maxDistance = d;
      farthestB = i;
    }
  }
  maxDistance = -1;
  for (let i = 0; i < points.length; i += 1) {
    const d = distanceSquared(points[farthestB]!, points[i]!);
    if (d > maxDistance) {
      maxDistance = d;
      farthestA = i;
    }
  }
  const [start, end] = farthestA < farthestB ? [farthestA, farthestB] : [farthestB, farthestA];
  const first = points.slice(start, end + 1);
  const second = points.slice(end).concat(points.slice(0, start + 1));
  const simplifiedFirst = douglasPeucker(first, tolerance);
  const simplifiedSecond = douglasPeucker(second, tolerance);
  return simplifiedFirst.slice(0, -1).concat(simplifiedSecond.slice(0, -1));
}

function douglasPeucker(points: readonly Point[], tolerance: number): Point[] {
  if (points.length < 3) return [...points];
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let index = -1;
  let maxDistance = tolerance;
  for (let i = 1; i < points.length - 1; i += 1) {
    const d = pointLineDistance(points[i]!, first, last);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }
  if (index === -1) return [first, last];
  const left = douglasPeucker(points.slice(0, index + 1), tolerance);
  const right = douglasPeucker(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

function pointLineDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Orders four arbitrary corners into a Quad (tl, tr, br, bl).
 *
 * Sum and difference of coordinates, which is robust to moderate rotation:
 * the top-left minimises x+y and the top-right maximises x−y. It fails past
 * about 45 degrees of rotation, at which point "top-left" is not a meaningful
 * label anyway and the caller should have rotated first.
 */
export function orderQuad(points: readonly Point[]): Quad {
  if (points.length !== 4) throw new Error(`orderQuad: expected 4 points, got ${points.length}`);
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
  const tl = bySum[0]!;
  const br = bySum[3]!;
  const bl = byDiff[0]!;
  const tr = byDiff[3]!;
  // Degenerate assignment means the quad is too rotated for this heuristic.
  const chosen = new Set([tl, tr, br, bl]);
  if (chosen.size !== 4) {
    throw new Error("orderQuad: corners are ambiguous — the quad is rotated past the point where tl/tr/br/bl mean anything");
  }
  return { tl, tr, br, bl };
}

// ---------------------------------------------------------------------------
// Homography
// ---------------------------------------------------------------------------

/**
 * Estimates the homography mapping `from` onto `to`, given four or more point
 * correspondences, by the normalized Direct Linear Transform.
 *
 * The normalization step (Hartley) is not optional. Raw pixel coordinates on a
 * 3000px image produce a DLT design matrix with entries spanning 1 to 9e6; its
 * condition number is then astronomical and the smallest singular vector — the
 * answer — is dominated by rounding error. Translating each point set to have
 * zero mean and scaling it to mean distance sqrt(2) fixes the conditioning, and
 * the transform is undone at the end. Skipping it gives a homography that looks
 * fine on synthetic data and visibly shears real photographs.
 */
export function estimateHomography(from: readonly Point[], to: readonly Point[]): Matrix3 {
  if (from.length !== to.length) throw new Error("estimateHomography: point counts differ");
  if (from.length < 4) throw new Error(`estimateHomography: need at least 4 correspondences, got ${from.length}`);

  const normFrom = normalizePoints(from);
  const normTo = normalizePoints(to);

  // Build the 2n x 9 design matrix.
  const rows: number[][] = [];
  for (let i = 0; i < from.length; i += 1) {
    const { x, y } = normFrom.points[i]!;
    const { x: u, y: v } = normTo.points[i]!;
    rows.push([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
    rows.push([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
  }

  const h = smallestSingularVector(rows);
  const normalized: Matrix3 = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, h[8]!];

  // Undo the normalization: H = T_to^-1 · H_norm · T_from
  const result = multiply3(multiply3(invert3(normTo.transform), normalized), normFrom.transform);
  const scale = result[8]!;
  if (Math.abs(scale) < 1e-12) throw new Error("estimateHomography: degenerate result — the points are probably collinear");
  return result.map((v) => v / scale) as unknown as Matrix3;
}

interface Normalized {
  points: Point[];
  transform: Matrix3;
}

function normalizePoints(points: readonly Point[]): Normalized {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;

  let meanDistance = 0;
  for (const p of points) meanDistance += Math.hypot(p.x - cx, p.y - cy);
  meanDistance /= points.length;
  const scale = meanDistance < 1e-12 ? 1 : Math.SQRT2 / meanDistance;

  return {
    points: points.map((p) => ({ x: (p.x - cx) * scale, y: (p.y - cy) * scale })),
    transform: [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1],
  };
}

/**
 * Smallest right singular vector of A, found as the eigenvector of AᵀA with the
 * smallest eigenvalue, via inverse iteration on a Jacobi eigendecomposition.
 *
 * A full SVD is overkill for a 9x9 symmetric matrix, and Jacobi is short,
 * dependency-free and numerically solid at this size.
 */
function smallestSingularVector(rows: readonly (readonly number[])[]): number[] {
  const n = 9;
  const ata: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const row of rows) {
    for (let i = 0; i < n; i += 1) {
      for (let j = i; j < n; j += 1) {
        ata[i]![j]! += row[i]! * row[j]!;
      }
    }
  }
  for (let i = 0; i < n; i += 1) for (let j = 0; j < i; j += 1) ata[i]![j] = ata[j]![i]!;

  const { values, vectors } = jacobiEigen(ata, n);
  let smallest = 0;
  for (let i = 1; i < n; i += 1) if (values[i]! < values[smallest]!) smallest = i;
  return vectors.map((row) => row[smallest]!);
}

/** Cyclic Jacobi eigendecomposition of a real symmetric matrix. */
function jacobiEigen(matrix: number[][], n: number): { values: number[]; vectors: number[][] } {
  const a = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );

  for (let sweep = 0; sweep < 100; sweep += 1) {
    let off = 0;
    for (let i = 0; i < n; i += 1) for (let j = i + 1; j < n; j += 1) off += a[i]![j]! * a[i]![j]!;
    if (off < 1e-24) break;

    for (let p = 0; p < n - 1; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k += 1) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k += 1) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }

  return { values: Array.from({ length: n }, (_, i) => a[i]![i]!), vectors: v };
}

export function multiply3(a: Matrix3, b: Matrix3): Matrix3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return out as unknown as Matrix3;
}

export function invert3(m: Matrix3): Matrix3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-15) throw new Error("invert3: singular matrix");
  const inv = 1 / det;
  return [
    (e * i - f * h) * inv, (c * h - b * i) * inv, (b * f - c * e) * inv,
    (f * g - d * i) * inv, (a * i - c * g) * inv, (c * d - a * f) * inv,
    (d * h - e * g) * inv, (b * g - a * h) * inv, (a * e - b * d) * inv,
  ];
}

/** Applies a homography to a point. */
export function applyHomography(h: Matrix3, p: Point): Point {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return {
    x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w,
    y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w,
  };
}

/**
 * Mean reprojection error in pixels — the honest measure of how well a
 * homography fits. The registration trust check keys on this: a fit whose
 * error exceeds a few pixels is not usable for cropping, and the pipeline must
 * fall back rather than crop confidently in the wrong place.
 */
export function reprojectionError(h: Matrix3, from: readonly Point[], to: readonly Point[]): number {
  if (from.length === 0) return Infinity;
  let total = 0;
  for (let i = 0; i < from.length; i += 1) {
    const projected = applyHomography(h, from[i]!);
    total += Math.hypot(projected.x - to[i]!.x, projected.y - to[i]!.y);
  }
  return total / from.length;
}

/**
 * Warps `image` so that `quad` fills an output of the given size.
 *
 * Backward mapping with bilinear sampling: for each destination pixel, find
 * where it came from in the source. Forward mapping would leave unwritten holes
 * wherever the transform expands.
 */
export function warpQuad(image: Gray, quad: Quad, width: number, height: number): Gray {
  const destination: Point[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const source = [quad.tl, quad.tr, quad.br, quad.bl];
  // Estimate destination -> source directly, which is the direction the loop needs.
  const h = estimateHomography(destination, source);
  return warpPerspective(image, h, width, height);
}

/** Warps with an explicit destination-to-source homography. */
export function warpPerspective(image: Gray, destinationToSource: Matrix3, width: number, height: number): Gray {
  const out = createGray(width, height);
  const [a, b, c, d, e, f, g, hh, i] = destinationToSource;
  for (let y = 0; y < height; y += 1) {
    // Incremental evaluation along the row: the homography is affine in x for
    // fixed y, so the three accumulators advance by a constant per step and the
    // inner loop costs one divide instead of nine multiply-adds.
    let nx = a * 0 + b * y + c;
    let ny = d * 0 + e * y + f;
    let nw = g * 0 + hh * y + i;
    for (let x = 0; x < width; x += 1) {
      if (Math.abs(nw) > 1e-12) {
        const sx = nx / nw;
        const sy = ny / nw;
        // Outside the source stays 0 (black) rather than clamping, so a warp
        // that overruns the page is visibly wrong instead of smeared.
        if (sx >= 0 && sy >= 0 && sx <= image.width - 1 && sy <= image.height - 1) {
          out.data[y * width + x] = sampleBilinear(image, sx, sy);
        }
      }
      nx += a;
      ny += d;
      nw += g;
    }
  }
  return out;
}

/**
 * Chooses an output size for a rectified quad that preserves its real aspect
 * ratio as closely as a single homography allows, by taking the longer of each
 * opposing edge pair.
 *
 * Using the average instead systematically shrinks the dimension that is
 * furthest from the camera, which tilts every stored template coordinate by a
 * percent or two — small enough to survive testing on flat scans and large
 * enough to clip the edge of a passport photo on a real phone capture.
 */
export function quadOutputSize(quad: Quad, maxEdge = 2400): { width: number; height: number } {
  const top = Math.hypot(quad.tr.x - quad.tl.x, quad.tr.y - quad.tl.y);
  const bottom = Math.hypot(quad.br.x - quad.bl.x, quad.br.y - quad.bl.y);
  const left = Math.hypot(quad.bl.x - quad.tl.x, quad.bl.y - quad.tl.y);
  const right = Math.hypot(quad.br.x - quad.tr.x, quad.br.y - quad.tr.y);

  let width = Math.max(top, bottom);
  let height = Math.max(left, right);
  const longest = Math.max(width, height);
  if (longest > maxEdge) {
    const scale = maxEdge / longest;
    width *= scale;
    height *= scale;
  }
  return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}
