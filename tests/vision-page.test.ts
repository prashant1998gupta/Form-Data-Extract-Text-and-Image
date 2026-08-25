import assert from "node:assert/strict";
import test from "node:test";

import { toGray } from "../lib/vision/gray.ts";
import { detectPageQuad, estimateSkewAngle, rectifyPage, rotateGray } from "../lib/vision/page.ts";
import { iou, type Rect } from "../lib/vision/types.ts";
import { renderSyntheticForm } from "./helpers/synthetic-form.ts";

/**
 * Page detection is the stage everything else stands on. Its most important
 * behaviour is not finding the page — it is REFUSING to, when what it found is
 * not credible.
 *
 * A wrong rectification is uniquely damaging: the output still looks like a
 * page, so nothing downstream can tell anything went wrong, and every template
 * coordinate silently addresses the wrong part of the form. These tests
 * therefore check the refusal paths as carefully as the success paths.
 */

const quadBounds = (quad: ReturnType<typeof detectPageQuad>["quad"]): Rect => {
  const xs = [quad.tl.x, quad.tr.x, quad.br.x, quad.bl.x];
  const ys = [quad.tl.y, quad.tr.y, quad.br.y, quad.bl.y];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

test("a flatbed scan is recognised as already square and left alone", () => {
  const { rgb } = renderSyntheticForm({ desk: 0, skew: 0, noise: 0.01 });
  const detection = detectPageQuad(toGray(rgb));

  assert.equal(detection.method, "full-frame");
  assert.ok(detection.confidence >= 0.85, `confidence ${detection.confidence}`);
  assert.equal(detection.skewDegrees, 0);
});

test("a page photographed on a dark desk has its four corners located", () => {
  const { rgb, truth } = renderSyntheticForm({ desk: 120, shadow: 0.25, noise: 0.03 });
  const detection = detectPageQuad(toGray(rgb));

  assert.equal(detection.method, "perspective", `expected perspective, got ${detection.method}: ${detection.reason}`);

  const found = quadBounds(detection.quad);
  const overlap = iou(found, truth.page);
  assert.ok(overlap > 0.95, `page quad IoU ${overlap.toFixed(3)} against ground truth`);
});

test("page detection survives a shadow gradient across the sheet", () => {
  // A strong diagonal falloff drags one corner of the page down toward the
  // desk's brightness. A fixed threshold loses that corner; the percentile-
  // relative one should not.
  const { rgb, truth } = renderSyntheticForm({ desk: 120, shadow: 0.45, noise: 0.03 });
  const detection = detectPageQuad(toGray(rgb));

  assert.equal(detection.method, "perspective", detection.reason);
  const overlap = iou(quadBounds(detection.quad), truth.page);
  assert.ok(overlap > 0.9, `page quad IoU ${overlap.toFixed(3)} under heavy shadow`);
});

test("skew is measured from the page content, not guessed", () => {
  for (const angle of [-4.5, -2, 1.5, 3.5]) {
    const { rgb } = renderSyntheticForm({ desk: 0, skew: angle, noise: 0.01 });
    const measured = estimateSkewAngle(toGray(rgb));
    assert.ok(
      Math.abs(measured - angle) < 0.7,
      `rotated ${angle} deg, measured ${measured} deg (off by ${Math.abs(measured - angle).toFixed(2)})`,
    );
  }
});

test("a square page reports no skew rather than inventing a small one", () => {
  const { rgb } = renderSyntheticForm({ desk: 0, skew: 0, noise: 0.02 });
  assert.ok(Math.abs(estimateSkewAngle(toGray(rgb))) < 0.4);
});

test("rectifying a skewed scan straightens it", () => {
  const angle = 3.5;
  const { rgb } = renderSyntheticForm({ desk: 0, skew: angle, noise: 0.01 });
  const gray = toGray(rgb);

  const detection = detectPageQuad(gray);
  assert.equal(detection.method, "skew", detection.reason);

  const rectified = rectifyPage(gray, detection);
  // The definitive check: the corrected page must have no measurable skew left.
  const residual = estimateSkewAngle(rectified.image);
  assert.ok(Math.abs(residual) < 0.6, `residual skew after correction: ${residual} deg`);
});

test("rotation fills the exposed corners with paper white, not black", () => {
  // A black wedge would be read as ink by every downstream threshold, and would
  // sit exactly where a corner field or a photo box lives.
  const { rgb } = renderSyntheticForm({ desk: 0 });
  const rotated = rotateGray(toGray(rgb), 6);
  assert.equal(rotated.data[0], 255, "top-left corner must be white after rotation");
  assert.equal(rotated.data[rotated.width - 1], 255, "top-right corner must be white after rotation");
});

test("a page occupying too little of the frame is refused, not cropped to", () => {
  // A photograph of a form lying on a large desk, shot from too far away. The
  // right answer is to fall back to the whole frame with low confidence, not to
  // confidently rectify whatever bright blob was largest.
  const { rgb } = renderSyntheticForm({ desk: 480, noise: 0.03 });
  const detection = detectPageQuad(toGray(rgb));

  if (detection.method === "perspective") {
    // If it did find the page, it must have found the RIGHT page.
    const overlap = iou(quadBounds(detection.quad), { x: 480, y: 480, width: 1240 - 960, height: 1754 - 960 });
    assert.ok(overlap > 0.9, `if it claims perspective it must be correct, IoU ${overlap.toFixed(3)}`);
  } else {
    assert.ok(detection.confidence <= 0.4, `a fallback must carry low confidence, got ${detection.confidence}`);
    assert.match(detection.reason, /covers only|could not/);
  }
});

test("rectification never returns an empty or absurd image", () => {
  // A property that must hold across every fixture variant, however the
  // detection went. A zero-size or wildly-stretched output means a later stage
  // divides by zero or allocates a gigabyte.
  const variants = [
    { desk: 0 },
    { desk: 120, shadow: 0.3 },
    { desk: 90, skew: 4 },
    { photocopy: true },
    { desk: 80, glare: true },
  ];
  for (const options of variants) {
    const { rgb } = renderSyntheticForm(options);
    const gray = toGray(rgb);
    const rectified = rectifyPage(gray, detectPageQuad(gray));
    assert.ok(rectified.width > 200, `width ${rectified.width} for ${JSON.stringify(options)}`);
    assert.ok(rectified.height > 200, `height ${rectified.height} for ${JSON.stringify(options)}`);
    const aspect = rectified.width / rectified.height;
    assert.ok(aspect > 0.2 && aspect < 5, `aspect ${aspect.toFixed(2)} for ${JSON.stringify(options)}`);
  }
});
