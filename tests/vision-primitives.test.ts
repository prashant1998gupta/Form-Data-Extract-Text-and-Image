import assert from "node:assert/strict";
import test from "node:test";

import { createGray, createMask, iou, containment, rgbFrom, rotatedRectBounds } from "../lib/vision/types.ts";
import { toGray, saturation, resizeGray, percentile, cropGray } from "../lib/vision/gray.ts";
import { boxMean, boxSum, boxVariance, integralOf, integralOfMask, integralPairOf, rectFillRatio } from "../lib/vision/integral.ts";
import { otsuThreshold, binarize, sauvola, flattenIllumination, binarizeDocument, maskSubtract, maskCount } from "../lib/vision/threshold.ts";
import { dilate, erode, open, close, closeRect, removeRules, extractRules } from "../lib/vision/morphology.ts";
import { connectedComponents, groupByProximity, componentPatch } from "../lib/vision/components.ts";

/**
 * The vision primitives are the load-bearing floor of region extraction. Every
 * accuracy claim this product makes rests on them being exactly right, and they
 * are the kind of code where a sign flip or an off-by-one produces output that
 * still looks like an image — so it survives eyeballing and fails silently on
 * real forms.
 *
 * These tests use hand-built images small enough to reason about pixel by
 * pixel, and assert exact values rather than approximate ones wherever the
 * arithmetic is exact.
 */

// ---------------------------------------------------------------------------
// Grayscale and colour
// ---------------------------------------------------------------------------

test("grayscale uses luma weights, so blue ink reads darker than a channel average would", () => {
  // Pure blue. Rec.601 luma gives 0.114*255 = 29; a flat average would give 85.
  const blue = rgbFrom(new Uint8ClampedArray([0, 0, 255]), 1, 1, 3);
  assert.equal(toGray(blue).data[0], 29);

  // Pure green is the heaviest channel.
  const green = rgbFrom(new Uint8ClampedArray([0, 255, 0]), 1, 1, 3);
  assert.equal(toGray(green).data[0], 150);

  // White stays white, black stays black — no gain drift.
  assert.equal(toGray(rgbFrom(new Uint8ClampedArray([255, 255, 255]), 1, 1, 3)).data[0], 255);
  assert.equal(toGray(rgbFrom(new Uint8ClampedArray([0, 0, 0]), 1, 1, 3)).data[0], 0);
});

test("saturation separates a colour photograph from printed paper", () => {
  // Paper (near-white, achromatic) vs a saturated skin tone.
  const image = rgbFrom(new Uint8ClampedArray([250, 250, 248, 224, 172, 105]), 2, 1, 3);
  const sat = saturation(image);
  assert.ok(sat.data[0]! < 10, `paper should be near-achromatic, got ${sat.data[0]}`);
  assert.ok(sat.data[1]! > 100, `skin tone should be saturated, got ${sat.data[1]}`);
});

test("saturation does not divide by zero on pure black", () => {
  const image = rgbFrom(new Uint8ClampedArray([0, 0, 0]), 1, 1, 3);
  assert.equal(saturation(image).data[0], 0);
});

test("alpha images are read at the right stride", () => {
  const rgba = rgbFrom(new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]), 2, 1, 4);
  const gray = toGray(rgba);
  assert.equal(gray.data[0], 76); // 0.299 * 255
  assert.equal(gray.data[1], 29); // 0.114 * 255
});

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

test("downscaling area-averages instead of point-sampling", () => {
  // A 2x2 checkerboard shrunk to 1x1 must be the mean, not whichever corner a
  // nearest-neighbour sampler happened to land on. Point sampling here is what
  // shatters handwriting into dashes and breaks component analysis.
  const image = createGray(2, 2);
  image.data.set([0, 255, 255, 0]);
  const small = resizeGray(image, 1, 1);
  assert.equal(small.data[0], 128, "expected the average of the four pixels");
});

test("downscaling weights partial pixel coverage at non-integer scale factors", () => {
  // 3x1 -> 2x1. Destination pixel 0 covers source [0,1.5): all of 0, half of 1.
  const image = createGray(3, 1);
  image.data.set([0, 100, 200]);
  const small = resizeGray(image, 2, 1);
  // (0*1 + 100*0.5) / 1.5 = 33.33
  assert.equal(small.data[0], 33);
  // (100*0.5 + 200*1) / 1.5 = 166.67
  assert.equal(small.data[1], 167);
});

test("upscaling interpolates without a half-pixel shift", () => {
  // A symmetric input must produce a symmetric output. A centre-alignment bug
  // shows up here as an asymmetric result and nowhere else obvious.
  const image = createGray(2, 1);
  image.data.set([0, 200]);
  const big = resizeGray(image, 4, 1);
  assert.equal(big.data[0], big.data[0]); // defined
  assert.ok(big.data[0]! < big.data[1]!, "should ramp upward");
  assert.ok(big.data[1]! < big.data[2]!);
  assert.ok(big.data[2]! < big.data[3]!);
  // Symmetry about the centre: distance from each end should match.
  assert.equal(big.data[0]! - 0, 200 - big.data[3]!);
});

test("percentile ignores a single specular highlight", () => {
  // 99 mid-grey pixels and one blown-out white. The 90th percentile must report
  // the paper, not the highlight — this is why background estimation uses it.
  const image = createGray(10, 10, 180);
  image.data[0] = 255;
  assert.equal(percentile(image, 0.9), 180);
});

test("cropGray clips a rect that hangs off the edge rather than throwing", () => {
  const image = createGray(4, 4, 7);
  const patch = cropGray(image, { x: 2, y: 2, width: 10, height: 10 });
  assert.equal(patch.width, 2);
  assert.equal(patch.height, 2);
  assert.equal(patch.data[0], 7);
});

// ---------------------------------------------------------------------------
// Integral images
// ---------------------------------------------------------------------------

test("integral box sums are exact", () => {
  const image = createGray(3, 3);
  image.data.set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const table = integralOf(image);
  assert.equal(boxSum(table, 0, 0, 3, 3), 45, "whole image");
  assert.equal(boxSum(table, 0, 0, 2, 2), 12, "top-left 2x2 = 1+2+4+5");
  assert.equal(boxSum(table, 1, 1, 3, 3), 28, "bottom-right 2x2 = 5+6+8+9");
  assert.equal(boxMean(table, 1, 1, 3, 3), 7);
});

test("a box hanging off the edge is clamped, and the mean uses the clamped area", () => {
  const image = createGray(2, 2, 10);
  const table = integralOf(image);
  assert.equal(boxSum(table, -5, -5, 10, 10), 40);
  assert.equal(boxMean(table, -5, -5, 10, 10), 10, "mean must divide by 4, not by 225");
});

test("box variance is zero on a uniform region and never negative", () => {
  const image = createGray(8, 8, 128);
  const table = integralPairOf(image);
  const variance = boxVariance(table, 0, 0, 8, 8);
  assert.ok(variance >= 0, `variance must not go negative, got ${variance}`);
  assert.ok(variance < 1e-6, `uniform region should have ~zero variance, got ${variance}`);
});

test("box variance matches the textbook value on a known pattern", () => {
  // Half black, half white: mean 127.5, variance 127.5^2 = 16256.25
  const image = createGray(2, 1);
  image.data.set([0, 255]);
  const table = integralPairOf(image);
  assert.ok(Math.abs(boxVariance(table, 0, 0, 2, 1) - 16256.25) < 0.01);
});

test("mask fill ratio reports the fraction of set pixels", () => {
  const mask = createMask(4, 4);
  for (let i = 0; i < 4; i += 1) mask.data[i] = 255; // one row of four
  const table = integralOfMask(mask);
  assert.equal(rectFillRatio(table, { x: 0, y: 0, width: 4, height: 4 }), 0.25);
});

// ---------------------------------------------------------------------------
// Thresholding
// ---------------------------------------------------------------------------

test("Otsu splits a clean bimodal histogram between the modes", () => {
  const image = createGray(10, 10, 200);
  for (let i = 0; i < 30; i += 1) image.data[i] = 40;
  const threshold = otsuThreshold(image);

  // The convention is inclusive-below: `binarize` treats <= threshold as ink,
  // so the correct answer for a {40, 200} histogram is 40 itself, not a value
  // strictly between the modes. Asserting the separation rather than the number
  // is what actually matters and survives that convention.
  assert.ok(threshold >= 40 && threshold < 200, `expected a separating level, got ${threshold}`);
  const mask = binarize(image, threshold);
  assert.equal(mask.data[0], 255, "the dark mode is ink");
  assert.equal(mask.data[99], 0, "the bright mode is paper");
  assert.equal(maskCount(mask), 30, "exactly the dark pixels");
});

test("binarize marks ink high, not low", () => {
  // The single most consequential convention in the module. If this inverts,
  // every mask becomes a mask of the paper and every statistic is wrong while
  // still looking plausible.
  const image = createGray(2, 1);
  image.data.set([10, 240]);
  const mask = binarize(image, 128);
  assert.equal(mask.data[0], 255, "dark pixel is ink");
  assert.equal(mask.data[1], 0, "bright pixel is paper");
});

test("Sauvola keeps blank paper blank where a plain mean threshold would speckle it", () => {
  // Uniform paper with sensor noise of a couple of levels. Sauvola's variance
  // term must collapse and suppress all of it.
  const image = createGray(40, 40, 210);
  for (let i = 0; i < image.data.length; i += 1) image.data[i] = 210 + ((i * 7) % 5) - 2;
  const mask = sauvola(image, 15, 0.2);
  assert.equal(maskCount(mask), 0, "noise on blank paper must not become ink");
});

test("Sauvola finds ink under a strong illumination gradient", () => {
  // Paper ramps 90 -> 240 left to right; a dark stroke sits in the BRIGHT half.
  // A global threshold tuned to catch it would flood the dark half.
  const width = 60;
  const height = 20;
  const image = createGray(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      image.data[y * width + x] = 90 + Math.round((150 * x) / (width - 1));
    }
  }
  for (let y = 8; y < 12; y += 1) {
    for (let x = 46; x < 54; x += 1) image.data[y * width + x] = 120;
  }
  const mask = sauvola(image, 15, 0.2);

  let inStroke = 0;
  for (let y = 8; y < 12; y += 1) for (let x = 46; x < 54; x += 1) if (mask.data[y * width + x] !== 0) inStroke += 1;
  let inDarkHalf = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < 20; x += 1) if (mask.data[y * width + x] !== 0) inDarkHalf += 1;

  assert.ok(inStroke > 16, `stroke in the bright half must survive, found ${inStroke}/32`);
  assert.equal(inDarkHalf, 0, "the shadowed half must not be flooded with false ink");
});

test("illumination flattening removes a gradient while preserving ink contrast", () => {
  const width = 128;
  const height = 128;
  const image = createGray(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Paper darkening toward the right, as a hand shadow does.
      image.data[y * width + x] = 240 - Math.round((120 * x) / (width - 1));
    }
  }
  const flat = flattenIllumination(image, 16, 220);

  // Sample the paper at both ends: after flattening they must agree closely.
  const left = flat.data[64 * width + 8]!;
  const right = flat.data[64 * width + 120]!;
  assert.ok(Math.abs(left - right) < 12, `paper should be uniform after flattening, got ${left} vs ${right}`);
});

test("mask subtraction is the operation template differencing relies on", () => {
  const filled = createMask(4, 1);
  filled.data.set([255, 255, 255, 0]);
  const blank = createMask(4, 1);
  blank.data.set([255, 0, 255, 0]);
  const residual = maskSubtract(filled, blank);
  assert.deepEqual(Array.from(residual.data), [0, 255, 0, 0], "only what the filled copy added should remain");
});

test("binarizeDocument produces a clean mask on a synthetic lit page", () => {
  const width = 200;
  const height = 120;
  const image = createGray(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const shade = 235 - Math.round((60 * (x + y)) / (width + height));
      image.data[y * width + x] = shade;
    }
  }
  // A dark 40x6 stroke.
  for (let y = 50; y < 56; y += 1) for (let x = 60; x < 100; x += 1) image.data[y * width + x] = 45;

  const { ink } = binarizeDocument(image);
  let hits = 0;
  for (let y = 50; y < 56; y += 1) for (let x = 60; x < 100; x += 1) if (ink.data[y * width + x] !== 0) hits += 1;
  assert.ok(hits > 200, `stroke should be recovered, got ${hits}/240`);

  // And the empty regions should stay genuinely empty.
  let falsePositives = 0;
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < width; x += 1) if (ink.data[y * width + x] !== 0) falsePositives += 1;
  assert.ok(falsePositives < 40, `blank area should stay blank, got ${falsePositives} stray pixels`);
});

// ---------------------------------------------------------------------------
// Morphology
// ---------------------------------------------------------------------------

test("dilate grows and erode shrinks by the structuring element radius", () => {
  const mask = createMask(9, 9);
  mask.data[4 * 9 + 4] = 255; // a single centre pixel

  const grown = dilate(mask, 2);
  let grownCount = 0;
  for (let i = 0; i < grown.data.length; i += 1) if (grown.data[i] !== 0) grownCount += 1;
  assert.equal(grownCount, 25, "radius 2 dilation of a point is a 5x5 block");

  assert.equal(maskCount(erode(grown, 2)), 1, "eroding it back returns the point");
});

test("erosion does not eat the image border", () => {
  // boxArea clamps, so a fully-set image survives erosion intact. A signature
  // touching the edge of its crop must not be thinned for being near the edge.
  const mask = createMask(5, 5, 255);
  assert.equal(maskCount(erode(mask, 1)), 25);
});

test("open removes speckle and close bridges gaps", () => {
  const mask = createMask(20, 20);
  // A solid 8x8 block plus one isolated speck.
  for (let y = 4; y < 12; y += 1) for (let x = 4; x < 12; x += 1) mask.data[y * 20 + x] = 255;
  mask.data[18 * 20 + 18] = 255;

  const opened = open(mask, 1);
  assert.equal(opened.data[18 * 20 + 18], 0, "the speck should be gone");
  assert.equal(opened.data[8 * 20 + 8], 255, "the block should survive");

  // Two blocks separated by a 2px gap, welded by a radius-2 close.
  const split = createMask(20, 8);
  for (let y = 2; y < 6; y += 1) {
    for (let x = 2; x < 8; x += 1) split.data[y * 20 + x] = 255;
    for (let x = 10; x < 16; x += 1) split.data[y * 20 + x] = 255;
  }
  assert.equal(connectedComponents(split).components.length, 2);
  assert.equal(connectedComponents(close(split, 2)).components.length, 1, "close should join them");
});

test("anisotropic close joins horizontally without merging vertically", () => {
  // Two words on one line, and an unrelated mark on the line below. A square
  // close big enough to join the words would also swallow the mark; closeRect
  // with a small vertical radius must not.
  const mask = createMask(40, 20);
  for (let y = 4; y < 7; y += 1) {
    for (let x = 2; x < 8; x += 1) mask.data[y * 40 + x] = 255;
    for (let x = 14; x < 20; x += 1) mask.data[y * 40 + x] = 255;
  }
  for (let y = 14; y < 17; y += 1) for (let x = 4; x < 10; x += 1) mask.data[y * 40 + x] = 255;

  const joined = closeRect(mask, 4, 1);
  const components = connectedComponents(joined).components;
  assert.equal(components.length, 2, "the two words join; the lower mark stays separate");
});

test("removeRules deletes a long printed line but keeps the writing on it", () => {
  const width = 120;
  const height = 40;
  const mask = createMask(width, height);
  // A full-width 1px rule.
  for (let x = 0; x < width; x += 1) mask.data[20 * width + x] = 255;
  // A compact 10x10 "signature" sitting across the rule.
  for (let y = 16; y < 26; y += 1) for (let x = 50; x < 60; x += 1) mask.data[y * width + x] = 255;

  const rules = extractRules(mask, 40, 1);
  assert.ok(rules.data[20 * width + 5] !== 0, "the rule should be identified");

  const cleaned = removeRules(mask, 40, 1);
  assert.equal(cleaned.data[20 * width + 5], 0, "the bare rule should be gone");

  let remaining = 0;
  for (let y = 16; y < 26; y += 1) for (let x = 50; x < 60; x += 1) if (cleaned.data[y * width + x] !== 0) remaining += 1;
  assert.ok(remaining > 60, `the writing must survive rule removal, kept ${remaining}/100`);

  // And critically, what remains must be a compact component, not a 120px-wide one.
  const biggest = connectedComponents(cleaned).components[0]!;
  assert.ok(biggest.bounds.width < 30, `component should be compact, got width ${biggest.bounds.width}`);
});

// ---------------------------------------------------------------------------
// Connected components
// ---------------------------------------------------------------------------

test("labelling is 8-connected, so a diagonal stroke stays one component", () => {
  const mask = createMask(5, 5);
  for (let i = 0; i < 5; i += 1) mask.data[i * 5 + i] = 255;
  const labelled = connectedComponents(mask);
  assert.equal(labelled.components.length, 1, "4-connectivity would report five separate pixels");
  assert.equal(labelled.components[0]!.area, 5);
});

test("component statistics are exact", () => {
  const mask = createMask(10, 10);
  for (let y = 2; y < 6; y += 1) for (let x = 3; x < 9; x += 1) mask.data[y * 10 + x] = 255;
  const component = connectedComponents(mask).components[0]!;
  assert.equal(component.area, 24);
  assert.deepEqual(component.bounds, { x: 3, y: 2, width: 6, height: 4 });
  assert.equal(component.centroid.x, 5.5);
  assert.equal(component.centroid.y, 3.5);
  assert.equal(component.fillRatio, 1, "a solid rectangle fills its bounding box");
  assert.equal(component.aspect, 1.5);
});

test("fill ratio separates a dense blob from a sparse scribble", () => {
  // This is the thumb-impression vs signature discriminator, in miniature.
  const blob = createMask(10, 10);
  for (let y = 1; y < 9; y += 1) for (let x = 1; x < 9; x += 1) blob.data[y * 10 + x] = 255;
  const blobStats = connectedComponents(blob).components[0]!;

  // A stroke that WANDERS across the box, which is what a signature does — the
  // bounding box is large but almost all of it is empty. A straight bar would
  // fill its own (thin) box completely and prove nothing.
  const scribble = createMask(10, 10);
  for (let x = 1; x < 9; x += 1) {
    // A V, one row of travel per column so the stroke stays 8-connected. A
    // straight bar would fill its own thin box completely and prove nothing.
    scribble.data[(1 + Math.abs(x - 4)) * 10 + x] = 255;
  }
  const scribbleStats = connectedComponents(scribble).components[0]!;
  assert.equal(scribbleStats.area, 8, "the stroke must be one connected component");

  assert.ok(blobStats.fillRatio > 0.9, `blob fill ${blobStats.fillRatio}`);
  assert.ok(scribbleStats.fillRatio < 0.3, `scribble fill ${scribbleStats.fillRatio}`);
});

test("components are returned largest first", () => {
  const mask = createMask(20, 6);
  mask.data[0] = 255;
  for (let y = 2; y < 5; y += 1) for (let x = 5; x < 15; x += 1) mask.data[y * 20 + x] = 255;
  const components = connectedComponents(mask).components;
  assert.equal(components[0]!.area, 30);
  assert.equal(components[1]!.area, 1);
});

test("minArea drops speckle from both the list and the label map", () => {
  const mask = createMask(20, 6);
  mask.data[0] = 255;
  for (let y = 2; y < 5; y += 1) for (let x = 5; x < 15; x += 1) mask.data[y * 20 + x] = 255;
  const labelled = connectedComponents(mask, 5);
  assert.equal(labelled.components.length, 1);
  assert.equal(labelled.labels[0], 0, "the filtered speck must be zeroed in the label map too");
});

test("labelling survives a long chain without recursing", () => {
  // A single snake filling a 200x200 image. A recursive union-find find() blows
  // the stack on exactly this shape.
  const size = 200;
  const mask = createMask(size, size);
  for (let y = 0; y < size; y += 2) {
    for (let x = 0; x < size; x += 1) mask.data[y * size + x] = 255;
    const turn = y % 4 === 0 ? size - 1 : 0;
    if (y + 1 < size) mask.data[(y + 1) * size + turn] = 255;
  }
  const labelled = connectedComponents(mask);
  assert.equal(labelled.components.length, 1, "the snake is one component");
});

test("componentPatch crops to the component and excludes its neighbours", () => {
  const mask = createMask(12, 6);
  for (let y = 1; y < 4; y += 1) for (let x = 1; x < 4; x += 1) mask.data[y * 12 + x] = 255;
  for (let y = 1; y < 4; y += 1) for (let x = 8; x < 11; x += 1) mask.data[y * 12 + x] = 255;
  const labelled = connectedComponents(mask);
  const patch = componentPatch(labelled, labelled.components[0]!);
  assert.equal(patch.width, 3);
  assert.equal(patch.height, 3);
  assert.equal(maskCount(patch), 9, "only the one component's pixels");
});

test("proximity grouping reassembles scattered strokes into one region", () => {
  // Three separated marks on one line — a signature's strokes — plus a distant
  // mark that must stay out of the group.
  const components = [
    { label: 1, area: 9, bounds: { x: 0, y: 0, width: 6, height: 8 }, centroid: { x: 3, y: 4 }, fillRatio: 0.2, aspect: 1.3 },
    { label: 2, area: 9, bounds: { x: 12, y: 1, width: 6, height: 8 }, centroid: { x: 15, y: 5 }, fillRatio: 0.2, aspect: 1.3 },
    { label: 3, area: 9, bounds: { x: 24, y: 0, width: 6, height: 8 }, centroid: { x: 27, y: 4 }, fillRatio: 0.2, aspect: 1.3 },
    { label: 4, area: 9, bounds: { x: 200, y: 90, width: 6, height: 8 }, centroid: { x: 203, y: 94 }, fillRatio: 0.2, aspect: 1.3 },
  ];
  const groups = groupByProximity(components, 10, 4);
  assert.equal(groups.length, 2);
  const wide = groups.find((g) => g.width > 20)!;
  assert.deepEqual(wide, { x: 0, y: 0, width: 30, height: 9 });
});

test("proximity grouping reaches a fixed point through a chain", () => {
  // A merges with B, and the union then reaches C which was near neither.
  // A single non-iterating pass returns two groups here.
  const components = [0, 9, 18].map((x, i) => ({
    label: i + 1,
    area: 4,
    bounds: { x, y: 0, width: 2, height: 2 },
    centroid: { x: x + 1, y: 1 },
    fillRatio: 1,
    aspect: 1,
  }));
  assert.equal(groupByProximity(components, 8, 2).length, 1);
});

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

test("IoU and containment answer different questions", () => {
  const big = { x: 0, y: 0, width: 100, height: 100 };
  const small = { x: 10, y: 10, width: 10, height: 10 };
  assert.ok(iou(big, small) < 0.02, "IoU punishes the size gap");
  assert.equal(containment(small, big), 1, "but the small box is entirely inside the big one");
  assert.equal(iou(big, big), 1);
  assert.equal(iou(big, { x: 500, y: 500, width: 10, height: 10 }), 0);
});

test("a rotated rect's bounds contain all four corners", () => {
  const bounds = rotatedRectBounds({ cx: 50, cy: 50, width: 40, height: 20, angle: Math.PI / 4 });
  // A 40x20 rect at 45 degrees spans (40+20)/sqrt(2) ~= 42.43 on both axes.
  assert.ok(Math.abs(bounds.width - 42.43) < 0.1, `width ${bounds.width}`);
  assert.ok(Math.abs(bounds.height - 42.43) < 0.1, `height ${bounds.height}`);
});
