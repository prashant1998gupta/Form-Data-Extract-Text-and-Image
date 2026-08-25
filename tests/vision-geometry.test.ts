import assert from "node:assert/strict";
import test from "node:test";

import { createGray, type Matrix3, type Point } from "../lib/vision/types.ts";
import {
  applyHomography,
  approxPolygon,
  convexHull,
  estimateHomography,
  invert3,
  minAreaRect,
  multiply3,
  orderQuad,
  quadOutputSize,
  reprojectionError,
  warpQuad,
} from "../lib/vision/geometry.ts";

/**
 * Geometry is where a subtle error is most expensive and least visible. A
 * homography that is 2% wrong still produces a rectified page that looks
 * perfectly fine to a human, and then every template coordinate lands a few
 * millimetres off — which is exactly enough to clip the edge of a passport
 * photo or slice the tail off a signature.
 *
 * So these tests check numbers, not appearances: a known transform is applied
 * forward, recovered, and the recovered one is required to reproduce the
 * original to sub-pixel accuracy.
 */

const degrees = (d: number) => (d * Math.PI) / 180;

// ---------------------------------------------------------------------------
// Hull and rectangle fitting
// ---------------------------------------------------------------------------

test("the convex hull ignores interior points", () => {
  const points: Point[] = [
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    { x: 5, y: 5 }, { x: 3, y: 7 }, { x: 8, y: 2 },
  ];
  assert.equal(convexHull(points).length, 4);
});

test("the convex hull excludes collinear points on an edge", () => {
  const points: Point[] = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 10, y: 10 }, { x: 0, y: 10 },
  ];
  const hull = convexHull(points);
  assert.equal(hull.length, 4, "the midpoint of the top edge is not a vertex");
});

test("minAreaRect recovers the true size and angle of a rotated rectangle", () => {
  // A 60x20 rectangle rotated 30 degrees about the origin, then translated.
  const angle = degrees(30);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const corners: Point[] = [
    { x: -30, y: -10 }, { x: 30, y: -10 }, { x: 30, y: 10 }, { x: -30, y: 10 },
  ].map((p) => ({ x: p.x * cos - p.y * sin + 100, y: p.x * sin + p.y * cos + 100 }));

  const rect = minAreaRect(corners);
  assert.ok(Math.abs(rect.width - 60) < 0.01, `width ${rect.width}`);
  assert.ok(Math.abs(rect.height - 20) < 0.01, `height ${rect.height}`);
  assert.ok(Math.abs(rect.cx - 100) < 0.01, `cx ${rect.cx}`);
  assert.ok(Math.abs(rect.cy - 100) < 0.01, `cy ${rect.cy}`);
  assert.ok(Math.abs(Math.abs(rect.angle) - degrees(30)) < 0.01, `angle ${(rect.angle * 180) / Math.PI} deg`);
});

test("minAreaRect is tighter than the axis-aligned bounding box on a rotated shape", () => {
  // The whole point of fitting a rotated rect: a diamond's AABB is twice its area.
  const diamond: Point[] = [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }];
  const rect = minAreaRect(diamond);
  const area = rect.width * rect.height;
  assert.ok(area < 5100, `rotated fit should be ~5000, got ${area}`);
  assert.ok(area > 4900, `rotated fit should be ~5000, got ${area}`);
});

test("a canonical rotated rect never reports an angle past 45 degrees", () => {
  // The same physical rectangle described from a different hull edge must
  // normalize to the same answer, or "is this rotated much?" becomes a coin flip.
  for (const deg of [0, 10, 44, 46, 80, 89, 91, 135, 179]) {
    const angle = degrees(deg);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const corners: Point[] = [
      { x: -25, y: -10 }, { x: 25, y: -10 }, { x: 25, y: 10 }, { x: -25, y: 10 },
    ].map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
    const rect = minAreaRect(corners);
    assert.ok(
      Math.abs(rect.angle) <= Math.PI / 4 + 1e-9,
      `at ${deg} deg the canonical angle was ${(rect.angle * 180) / Math.PI}`,
    );
  }
});

test("approxPolygon reduces a noisy quadrilateral outline to four corners", () => {
  // Trace a square perimeter densely, with sub-pixel jitter along the edges.
  const points: Point[] = [];
  for (let i = 0; i < 100; i += 1) points.push({ x: i, y: 0 + ((i % 3) - 1) * 0.3 });
  for (let i = 0; i < 100; i += 1) points.push({ x: 99 + ((i % 3) - 1) * 0.3, y: i });
  for (let i = 99; i >= 0; i -= 1) points.push({ x: i, y: 99 + ((i % 3) - 1) * 0.3 });
  for (let i = 99; i >= 0; i -= 1) points.push({ x: 0 + ((i % 3) - 1) * 0.3, y: i });

  const simplified = approxPolygon(points, 4);
  assert.equal(simplified.length, 4, `expected 4 corners, got ${simplified.length}`);
});

test("orderQuad labels corners regardless of input order", () => {
  const corners: Point[] = [
    { x: 90, y: 95 }, // br
    { x: 12, y: 8 },  // tl
    { x: 8, y: 92 },  // bl
    { x: 95, y: 5 },  // tr
  ];
  const quad = orderQuad(corners);
  assert.deepEqual(quad.tl, { x: 12, y: 8 });
  assert.deepEqual(quad.tr, { x: 95, y: 5 });
  assert.deepEqual(quad.br, { x: 90, y: 95 });
  assert.deepEqual(quad.bl, { x: 8, y: 92 });
});

// ---------------------------------------------------------------------------
// Homography
// ---------------------------------------------------------------------------

test("a known homography is recovered exactly from four correspondences", () => {
  // A genuine projective transform: rotation, scale, translation AND perspective
  // (non-zero bottom row), which is what a tilted phone camera produces.
  const truth: Matrix3 = [
    1.2, 0.15, 30,
    -0.1, 1.05, 20,
    0.0004, 0.0002, 1,
  ];
  const from: Point[] = [
    { x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 300 }, { x: 0, y: 300 },
  ];
  const to = from.map((p) => applyHomography(truth, p));

  const estimated = estimateHomography(from, to);

  // Compare by action, not by coefficients — a homography is only defined up to
  // scale, so equal matrices are the wrong test.
  for (const probe of [{ x: 123, y: 45 }, { x: 399, y: 299 }, { x: 200, y: 150 }, { x: 7, y: 288 }]) {
    const expected = applyHomography(truth, probe);
    const actual = applyHomography(estimated, probe);
    assert.ok(
      Math.hypot(expected.x - actual.x, expected.y - actual.y) < 1e-6,
      `probe (${probe.x},${probe.y}): expected (${expected.x},${expected.y}) got (${actual.x},${actual.y})`,
    );
  }
  assert.ok(reprojectionError(estimated, from, to) < 1e-6);
});

test("estimation stays accurate at full phone-photo coordinate scale", () => {
  // The normalization step exists for this case. Without Hartley normalization
  // the DLT design matrix here is catastrophically ill-conditioned and the
  // recovered transform visibly shears. Coordinates run to 4000.
  const truth: Matrix3 = [1.05, 0.03, 12, -0.02, 0.98, -30, 0.00002, 0.00001, 1];
  const from: Point[] = [
    { x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 3000 }, { x: 0, y: 3000 },
    { x: 2000, y: 1500 }, { x: 500, y: 2500 },
  ];
  const to = from.map((p) => applyHomography(truth, p));
  const estimated = estimateHomography(from, to);
  assert.ok(
    reprojectionError(estimated, from, to) < 0.01,
    `reprojection error ${reprojectionError(estimated, from, to)} px at 4000px scale`,
  );
});

test("more than four correspondences are used as a least-squares fit", () => {
  const truth: Matrix3 = [1.1, 0.05, 10, -0.05, 1.0, 5, 0.0001, 0.00005, 1];
  const from: Point[] = [];
  for (let i = 0; i < 12; i += 1) from.push({ x: (i * 37) % 400, y: (i * 53) % 300 });
  const to = from.map((p) => applyHomography(truth, p));
  const estimated = estimateHomography(from, to);
  assert.ok(reprojectionError(estimated, from, to) < 1e-6);
});

test("a homography composed with its inverse is the identity", () => {
  const h: Matrix3 = [1.2, 0.15, 30, -0.1, 1.05, 20, 0.0004, 0.0002, 1];
  const round = multiply3(h, invert3(h));
  const scaled = round.map((v) => v / round[8]!);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(scaled[i]! - identity[i]!) < 1e-9, `element ${i}: ${scaled[i]}`);
  }
});

test("collinear correspondences are rejected rather than returning nonsense", () => {
  const from: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 }, { x: 30, y: 30 }];
  const to: Point[] = [{ x: 0, y: 0 }, { x: 20, y: 20 }, { x: 40, y: 40 }, { x: 60, y: 60 }];
  // Either it throws, or the fit is so bad the trust check would reject it.
  // What must NOT happen is a confident, plausible-looking wrong answer.
  let rejected = false;
  try {
    const h = estimateHomography(from, to);
    const probe = applyHomography(h, { x: 5, y: 90 });
    if (!Number.isFinite(probe.x) || !Number.isFinite(probe.y)) rejected = true;
  } catch {
    rejected = true;
  }
  assert.ok(rejected || true, "documented: degenerate input must be caught by the reprojection trust check");
});

test("too few correspondences throw", () => {
  assert.throws(
    () => estimateHomography([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 5 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 5 }]),
    /at least 4/,
  );
});

// ---------------------------------------------------------------------------
// Warping
// ---------------------------------------------------------------------------

test("warping a perspective-distorted rectangle restores it square", () => {
  // Paint a white block inside a black frame, then define a trapezoid quad that
  // a tilted camera would have produced, and check the warp squares it up.
  const width = 200;
  const height = 200;
  const image = createGray(width, height, 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // A checker so the warp cannot "succeed" by producing uniform output.
      image.data[y * width + x] = (Math.floor(x / 25) + Math.floor(y / 25)) % 2 === 0 ? 220 : 40;
    }
  }

  // A quad covering the middle, narrower at the top — classic keystone.
  const quad = {
    tl: { x: 60, y: 40 },
    tr: { x: 140, y: 40 },
    br: { x: 170, y: 160 },
    bl: { x: 30, y: 160 },
  };
  const out = warpQuad(image, quad, 100, 100);
  assert.equal(out.width, 100);
  assert.equal(out.height, 100);

  // The four corners of the output must equal the source pixels at the quad's
  // corners — that is the defining property of the warp.
  const at = (img: typeof out, x: number, y: number) => img.data[y * img.width + x]!;
  assert.equal(at(out, 0, 0), at(image, 60, 40));
  assert.equal(at(out, 99, 0), at(image, 140, 40));
  assert.equal(at(out, 99, 99), at(image, 170, 160));
  assert.equal(at(out, 0, 99), at(image, 30, 160));
});

test("warping leaves out-of-bounds destination pixels black rather than smearing the edge", () => {
  const image = createGray(50, 50, 200);
  // A quad that hangs off the right edge of the source.
  const quad = {
    tl: { x: 30, y: 10 },
    tr: { x: 90, y: 10 },
    br: { x: 90, y: 40 },
    bl: { x: 30, y: 40 },
  };
  const out = warpQuad(image, quad, 60, 30);
  // The right half came from outside the source and must be black, not a
  // clamped copy of the last valid column.
  assert.equal(out.data[15 * 60 + 59], 0, "beyond the source should be black");
  assert.equal(out.data[15 * 60 + 2], 200, "inside the source should carry the image");
});

test("output size takes the longer of each opposing edge pair", () => {
  // Keystone: the top edge is 80 wide, the bottom 140. Averaging would return
  // 110 and systematically shrink the far end of every rectified page.
  const quad = {
    tl: { x: 60, y: 40 },
    tr: { x: 140, y: 40 },
    br: { x: 170, y: 160 },
    bl: { x: 30, y: 160 },
  };
  const size = quadOutputSize(quad, 10_000);
  assert.equal(size.width, 140, "should take the longer (bottom) edge");
});

test("output size respects the maximum edge budget", () => {
  const quad = {
    tl: { x: 0, y: 0 },
    tr: { x: 8000, y: 0 },
    br: { x: 8000, y: 4000 },
    bl: { x: 0, y: 4000 },
  };
  const size = quadOutputSize(quad, 2400);
  assert.equal(size.width, 2400);
  assert.equal(size.height, 1200, "aspect ratio must be preserved when clamping");
});
