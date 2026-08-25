import assert from "node:assert/strict";
import test from "node:test";

import {
  angleDifference,
  distanceToLine,
  edgeStepProfile,
  intersectLines,
  intersectLinesToQuad,
  lineAngleDegrees,
  lineThrough,
  ransacLineFit,
  totalLeastSquaresLine,
  type WeightedChannel,
} from "../lib/vision/lines.ts";
import { createGray, type Gray } from "../lib/vision/types.ts";

/**
 * Edge-step fitting is what makes the photograph crop accurate, so these tests
 * are about SUB-PIXEL correctness, not about "did it roughly work".
 *
 * The scenario in most of them is the hard one the architecture was built for:
 * a photo whose tone matches the paper it is pasted on, distinguishable only by
 * texture. If the tests only used a dark rectangle on white paper they would
 * pass with a far worse algorithm.
 */

/** Paints a rectangle with a given tone and per-pixel texture amplitude. */
function paint(
  image: Gray,
  rect: { x: number; y: number; width: number; height: number },
  tone: number,
  texture: number,
  seed = 7,
) {
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      image.data[y * image.width + x] = tone + (random() - 0.5) * texture;
    }
  }
}

function channelsOf(image: Gray, sigma: number): WeightedChannel[] {
  return [{ image, weight: 1, sigma }];
}

// ---------------------------------------------------------------------------
// Line algebra
// ---------------------------------------------------------------------------

test("a line through two points is normalised so evaluation gives true distance", () => {
  const line = lineThrough({ x: 0, y: 0 }, { x: 10, y: 0 })!;
  assert.ok(Math.abs(Math.hypot(line.a, line.b) - 1) < 1e-12, "normal must be unit length");
  assert.ok(Math.abs(Math.abs(distanceToLine(line, { x: 5, y: 3 })) - 3) < 1e-9, "3 px above a horizontal line");
});

test("coincident points produce no line rather than a NaN one", () => {
  assert.equal(lineThrough({ x: 4, y: 4 }, { x: 4, y: 4 }), null);
});

test("total least squares fits a vertical line, which ordinary least squares cannot", () => {
  // OLS minimises vertical offset and is undefined here. A photo's left and
  // right edges are near-vertical by construction, so this is the normal case.
  const points = Array.from({ length: 20 }, (_, i) => ({ x: 37, y: i * 3 }));
  const line = totalLeastSquaresLine(points)!;
  for (const p of points) {
    assert.ok(Math.abs(distanceToLine(line, p)) < 1e-9, `point (${p.x},${p.y}) off the fitted line`);
  }
  assert.ok(Math.abs(lineAngleDegrees(line) - 90) < 1e-6, `expected 90 deg, got ${lineAngleDegrees(line)}`);
});

test("total least squares recovers a known slope", () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ x: i, y: 10 + i * 0.5 }));
  const line = totalLeastSquaresLine(points)!;
  for (const p of points) assert.ok(Math.abs(distanceToLine(line, p)) < 1e-9);
});

test("parallel lines report no intersection instead of one at infinity", () => {
  const first = lineThrough({ x: 0, y: 0 }, { x: 10, y: 0 })!;
  const second = lineThrough({ x: 0, y: 5 }, { x: 10, y: 5 })!;
  assert.equal(intersectLines(first, second), null);
});

test("four lines intersect into the expected quadrilateral", () => {
  const left = lineThrough({ x: 10, y: 0 }, { x: 10, y: 100 })!;
  const right = lineThrough({ x: 90, y: 0 }, { x: 90, y: 100 })!;
  const top = lineThrough({ x: 0, y: 20 }, { x: 100, y: 20 })!;
  const bottom = lineThrough({ x: 0, y: 80 }, { x: 100, y: 80 })!;
  const quad = intersectLinesToQuad(left, top, right, bottom)!;
  assert.deepEqual(
    { x: Math.round(quad.tl.x), y: Math.round(quad.tl.y) },
    { x: 10, y: 20 },
  );
  assert.deepEqual({ x: Math.round(quad.br.x), y: Math.round(quad.br.y) }, { x: 90, y: 80 });
});

test("angle difference wraps correctly at 180 degrees", () => {
  assert.equal(angleDifference(179, 1), 2);
  assert.equal(angleDifference(90, 90), 0);
  assert.ok(Math.abs(angleDifference(0, 90) - 90) < 1e-9);
});

// ---------------------------------------------------------------------------
// Step profiling — the real job
// ---------------------------------------------------------------------------

test("a tone step is located to sub-pixel accuracy on all four sides", () => {
  const image = createGray(200, 200, 240);
  // A darker rectangle: edges at x=60, x=140, y=50, y=150.
  paint(image, { x: 60, y: 50, width: 80, height: 100 }, 150, 6);

  const channels = channelsOf(image, 3);
  // 2 px inlier tolerance ~= 0.17 mm at the 300 dpi these bands are sampled at,
  // which is tighter than the architecture's 0.25 mm acceptance floor.
  const TOLERANCE = 2;

  const left = ransacLineFit(edgeStepProfile(channels, "left", { x: 45, y: 60, width: 30, height: 80 }, 5), TOLERANCE)!;
  const right = ransacLineFit(edgeStepProfile(channels, "right", { x: 125, y: 60, width: 30, height: 80 }, 5), TOLERANCE)!;
  const top = ransacLineFit(edgeStepProfile(channels, "top", { x: 70, y: 35, width: 60, height: 30 }, 5), TOLERANCE)!;
  const bottom = ransacLineFit(edgeStepProfile(channels, "bottom", { x: 70, y: 135, width: 60, height: 30 }, 5), TOLERANCE)!;

  // The TRUE boundaries. Pixel 60 is the first dark column and pixel i spans
  // [i-0.5, i+0.5], so the physical edge lies at 59.5 — not at 60. Asserting
  // against the right number is what makes a sub-pixel claim meaningful.
  //
  // 0.6 px here is deliberately tight: it is roughly 0.05 mm at the 300 dpi
  // these bands are sampled at. It passes only because the profiler takes the
  // CENTRE of the median plateau. Reverting to a plain argmax lands anywhere
  // within +/- half a window and fails this immediately, which is the point.
  const checks: [string, ReturnType<typeof ransacLineFit>, { x: number; y: number }][] = [
    ["left", left, { x: 59.5, y: 100 }],
    ["right", right, { x: 139.5, y: 100 }],
    ["top", top, { x: 100, y: 49.5 }],
    ["bottom", bottom, { x: 100, y: 149.5 }],
  ];
  for (const [name, fit, truth] of checks) {
    const error = distanceToLine(fit!.line, truth);
    assert.ok(Math.abs(error) < 0.6, `${name} edge off by ${error.toFixed(3)} px`);
    assert.equal(fit!.inlierRatio, 1, `${name} edge should have every scanline as an inlier on a clean step`);
  }

  // And the horizontal edges must actually be horizontal — this is what catches
  // the (along, across) transposition bug.
  assert.ok(angleDifference(lineAngleDegrees(top.line), 0) < 3, `top angle ${lineAngleDegrees(top.line)}`);
  assert.ok(angleDifference(lineAngleDegrees(left.line), 90) < 3, `left angle ${lineAngleDegrees(left.line)}`);
});

test("a white photo on white paper is found by texture alone", () => {
  // THE case the architecture exists for. Identical tone; the only difference
  // is grain amplitude — emulsion versus paper fibre.
  const tone = createGray(160, 160, 236);
  paint(tone, { x: 0, y: 0, width: 160, height: 160 }, 236, 3); // paper: fine grain
  paint(tone, { x: 40, y: 30, width: 80, height: 100 }, 236, 26); // photo: coarse grain, SAME tone

  // Luminance alone must be nearly blind here — that is the premise.
  const luminanceOnly = ransacLineFit(
    edgeStepProfile(channelsOf(tone, 3), "left", { x: 25, y: 45, width: 30, height: 70 }, 5),
    1,
    200,
    3.0,
  );

  // Now add the high-frequency energy channel, which is what actually sees it.
  const hf = createGray(tone.width, tone.height);
  for (let y = 1; y < tone.height - 1; y += 1) {
    for (let x = 1; x < tone.width - 1; x += 1) {
      // Crude local roughness: mean absolute deviation from the 4-neighbourhood.
      const c = tone.data[y * tone.width + x]!;
      const rough =
        Math.abs(c - tone.data[y * tone.width + x - 1]!) +
        Math.abs(c - tone.data[y * tone.width + x + 1]!) +
        Math.abs(c - tone.data[(y - 1) * tone.width + x]!) +
        Math.abs(c - tone.data[(y + 1) * tone.width + x]!);
      hf.data[y * tone.width + x] = rough / 4;
    }
  }

  const withTexture = ransacLineFit(
    edgeStepProfile(
      [
        { image: tone, weight: 1, sigma: 3 },
        { image: hf, weight: 1.5, sigma: 1.2 },
      ],
      "left",
      { x: 25, y: 45, width: 30, height: 70 },
      5,
    ),
    1.5,
  )!;

  assert.ok(withTexture, "the texture channel must find the edge");
  assert.ok(
    Math.abs(distanceToLine(withTexture.line, { x: 40, y: 80 })) < 2,
    `texture-found edge off by ${distanceToLine(withTexture.line, { x: 40, y: 80 })}`,
  );
  assert.ok(withTexture.meanResponse > 3, `response ${withTexture.meanResponse} should clear the 3-sigma floor`);

  // Document the premise: luminance alone either fails or is much weaker.
  if (luminanceOnly) {
    assert.ok(
      luminanceOnly.meanResponse < withTexture.meanResponse,
      "the texture channel must beat luminance on a white-on-white edge",
    );
  }
});

test("a glare band across the edge becomes an outlier instead of bending the line", () => {
  const image = createGray(200, 200, 240);
  paint(image, { x: 60, y: 40, width: 80, height: 120 }, 150, 6);
  // A blown-out specular band across 15 rows, obliterating the step there.
  paint(image, { x: 30, y: 90, width: 140, height: 15 }, 255, 1);

  // Tolerance 2 px. The architecture's acceptance floor is 0.25 mm, which is
  // ~3 px at the 300 dpi DETAIL resolution these bands are sampled at, so 2 is
  // stricter than production.
  const fit = ransacLineFit(
    edgeStepProfile(channelsOf(image, 3), "left", { x: 45, y: 50, width: 30, height: 100 }, 5),
    2,
  )!;

  assert.ok(fit, "should still fit through the surviving rows");
  assert.ok(
    Math.abs(distanceToLine(fit.line, { x: 60, y: 60 })) < 1.5,
    `glare bent the line by ${distanceToLine(fit.line, { x: 60, y: 60 })} px`,
  );
  assert.ok(fit.inlierRatio > 0.5, `inlier ratio ${fit.inlierRatio.toFixed(2)} — glare rows should be the minority`);
});

test("medians make a staple-sized dark speck irrelevant", () => {
  const image = createGray(200, 200, 240);
  paint(image, { x: 60, y: 40, width: 80, height: 120 }, 150, 6);
  // A near-black staple mark sitting ON the edge.
  paint(image, { x: 57, y: 96, width: 7, height: 7 }, 15, 2);

  const fit = ransacLineFit(
    edgeStepProfile(channelsOf(image, 3), "left", { x: 45, y: 50, width: 30, height: 100 }, 5),
    1,
  )!;
  assert.ok(
    Math.abs(distanceToLine(fit.line, { x: 60, y: 100 })) < 1.5,
    `staple pulled the edge by ${distanceToLine(fit.line, { x: 60, y: 100 })} px`,
  );
});

test("a crooked photo's edge angle is recovered, not assumed vertical", () => {
  // A rectangle rotated ~6 degrees. The fit must follow it, because that angle
  // is what the deskewing warp will undo.
  const image = createGray(240, 240, 240);
  const angle = (6 * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let y = 0; y < 240; y += 1) {
    for (let x = 0; x < 240; x += 1) {
      const dx = x - 120;
      const dy = y - 120;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (Math.abs(lx) < 45 && Math.abs(ly) < 60) image.data[y * 240 + x] = 150 + ((x * 7 + y * 3) % 11);
    }
  }

  const fit = ransacLineFit(
    edgeStepProfile(channelsOf(image, 3), "left", { x: 55, y: 80, width: 34, height: 80 }, 5),
    1.2,
  )!;
  const measured = lineAngleDegrees(fit.line);
  // A left edge of a rectangle rotated 6 degrees sits 6 degrees off vertical.
  assert.ok(
    angleDifference(measured, 96) < 3 || angleDifference(measured, 84) < 3,
    `expected ~84 or ~96 degrees, measured ${measured.toFixed(1)}`,
  );
});

test("a band with no step at all returns no fit rather than a fabricated one", () => {
  // Blank paper. The correct answer is null — this is what makes "Not Detected"
  // an assertion instead of a fallback.
  const image = createGray(120, 120, 240);
  paint(image, { x: 0, y: 0, width: 120, height: 120 }, 240, 4);
  const fit = ransacLineFit(
    edgeStepProfile(channelsOf(image, 4), "left", { x: 30, y: 30, width: 40, height: 60 }, 5),
    1,
    200,
    3.0,
  );
  assert.equal(fit, null, "an edge must not be invented on blank paper");
});

test("too few scanlines produce no fit", () => {
  const image = createGray(60, 60, 240);
  paint(image, { x: 30, y: 0, width: 30, height: 60 }, 120, 4);
  const samples = edgeStepProfile(channelsOf(image, 3), "left", { x: 20, y: 10, width: 20, height: 4 }, 5);
  assert.equal(ransacLineFit(samples, 1), null, "4 scanlines is not evidence of a line");
});

test("fitting is deterministic — the same scan always yields the same crop", () => {
  // RANSAC with a seeded generator. Without this a failed crop cannot be
  // investigated, because it does not reproduce.
  const image = createGray(200, 200, 240);
  paint(image, { x: 60, y: 40, width: 80, height: 120 }, 150, 8);
  const samples = edgeStepProfile(channelsOf(image, 3), "left", { x: 45, y: 50, width: 30, height: 100 }, 5);
  const first = ransacLineFit(samples, 1)!;
  const second = ransacLineFit(samples, 1)!;
  assert.deepEqual(first.line, second.line);
  assert.equal(first.inliers, second.inliers);
});
