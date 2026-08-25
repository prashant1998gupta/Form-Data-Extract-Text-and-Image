/**
 * Page detection and rectification.
 *
 * Everything downstream assumes a flat, square-on, correctly-scaled page. That
 * assumption is what lets a template store "the photo box is at (0.72, 0.08)
 * with size (0.16, 0.14)" and have it mean the same thing on every scan from
 * every device. Nothing in the template system survives without this stage.
 *
 * Two corrections, chosen by what the image needs:
 *
 *   - **Perspective**, when the page's four corners are visible against a
 *     contrasting background — a phone photo on a desk. A homography maps the
 *     detected quad onto a rectangle.
 *   - **Skew**, when the page fills the frame — a flatbed scan, or a photo
 *     cropped tight. There are no corners to find, but the page may still be a
 *     couple of degrees off; a projection-profile search finds that angle from
 *     the text lines themselves.
 *
 * And a third outcome that matters as much as the other two: **refusing**. If
 * the detected quad is implausible, this returns a `full-frame` result rather
 * than a confident wrong warp. A bad rectification is worse than none — it
 * moves every template coordinate somewhere arbitrary, and the failure is
 * invisible because the output still looks like a page.
 */

import { connectedComponents } from "./components.ts";
import { approxPolygon, convexHull, minAreaRect, orderQuad, quadOutputSize, warpQuad } from "./geometry.ts";
import { fitWithin, percentile, resizeGray } from "./gray.ts";
import { close, open } from "./morphology.ts";
import { binarizeDocument, otsuThreshold } from "./threshold.ts";
import { createMask, type Gray, type Point, type Quad } from "./types.ts";

export type PageMethod = "perspective" | "skew" | "full-frame";

export interface PageDetection {
  readonly method: PageMethod;
  /** Corners in the ORIGINAL image's coordinate space. Full frame when method is full-frame. */
  readonly quad: Quad;
  /** Rotation applied for the `skew` method, in degrees. Zero otherwise. */
  readonly skewDegrees: number;
  /**
   * 0..1. How much to trust the geometry. Template registration refuses to run
   * below ~0.5 and falls back to whole-page detection.
   */
  readonly confidence: number;
  /** Human-readable note, surfaced in the debug payload when a scan goes wrong. */
  readonly reason: string;
}

export interface RectifiedPage {
  readonly image: Gray;
  readonly detection: PageDetection;
  readonly width: number;
  readonly height: number;
}

const MIN_PAGE_AREA_FRACTION = 0.25;
const FILLS_FRAME_FRACTION = 0.92;
const MIN_ASPECT = 0.35;
const MAX_ASPECT = 2.9;

/**
 * Page-edge background support. See `edgeSupport` for why this exists at all.
 *
 * THREE of four, not four: one edge of a page photographed on a desk routinely
 * runs off the frame, and demanding all four would refuse a large share of
 * perfectly good captures. Three is still decisive against the failure — every
 * severed-page variant measured exactly one.
 *
 * The drop is in grey levels and is deliberately generous. A page on a pale
 * desk is the hard case; 25 levels is comfortably below the 130-170 measured on
 * a real desk photo, and comfortably above sensor noise on blank paper.
 */
const MIN_SUPPORTED_EDGES = 3;
const EDGE_BACKGROUND_DROP = 25;
const EDGE_SUPPORT_FRACTION = 0.7;

/**
 * Finds the page boundary.
 *
 * Works on a small copy — 700px on the long edge. Corner positions found there
 * are scaled back up, and the loss is under half a pixel at full resolution
 * while the search is ~20x cheaper. Page edges are the largest structures in
 * the image; nothing about finding them benefits from full resolution.
 */
export function detectPageQuad(gray: Gray): PageDetection {
  const fullFrame = frameQuad(gray.width, gray.height);
  const small = fitWithin(gray, 700);
  const scale = gray.width / small.width;

  // The page is the bright thing. The threshold comes from Otsu rather than a
  // percentile of the histogram, and that choice is load-bearing: a percentile
  // assumes the page occupies a known share of the frame. Photograph a form
  // lying on a large desk and the page is 10% of the pixels, so the 85th
  // percentile lands on the DESK — the threshold then admits everything, the
  // "largest bright region" is the whole frame, and the detector confidently
  // reports a full-frame page. Otsu finds the valley between the two modes
  // wherever it is, whatever their relative areas.
  //
  // On a scan, where there is no desk, Otsu splits paper from ink instead and
  // the bright class is ~95% of the frame — which lands correctly in the
  // fills-the-frame branch below.
  const level = Math.max(45, Math.min(otsuThreshold(small), percentile(small, 0.98) - 25));

  const bright = createMask(small.width, small.height);
  for (let i = 0; i < small.data.length; i += 1) bright.data[i] = small.data[i]! >= level ? 255 : 0;

  // Close first to bridge the dark rules and text INSIDE the page, so the page
  // is one component rather than a doily. Then open to shed background specks.
  const cleaned = open(close(bright, 5), 2);

  const labelled = connectedComponents(cleaned, 200);
  const largest = labelled.components[0];
  if (!largest) {
    return { method: "full-frame", quad: fullFrame, skewDegrees: 0, confidence: 0.3, reason: "no bright region found" };
  }

  const frameArea = small.width * small.height;
  const coverage = largest.area / frameArea;

  // The page fills the frame: a scan, or an already-cropped photo. There are no
  // corners to find, so fall through to the skew path instead of inventing a quad.
  if (coverage >= FILLS_FRAME_FRACTION) {
    const skew = estimateSkewAngle(gray);
    if (Math.abs(skew) < 0.25) {
      return { method: "full-frame", quad: fullFrame, skewDegrees: 0, confidence: 0.9, reason: "page fills the frame and is square" };
    }
    return { method: "skew", quad: fullFrame, skewDegrees: skew, confidence: 0.85, reason: `page fills the frame, deskewed ${skew.toFixed(2)} deg` };
  }

  if (coverage < MIN_PAGE_AREA_FRACTION) {
    return {
      method: "full-frame",
      quad: fullFrame,
      skewDegrees: 0,
      confidence: 0.25,
      reason: `largest bright region covers only ${(coverage * 100).toFixed(0)}% of the frame`,
    };
  }

  // The hull of a page-shaped blob IS the page outline: paper is convex, so no
  // contour tracing is needed. Points come from the component's own pixels.
  const points: Point[] = [];
  for (let y = 0; y < labelled.height; y += 1) {
    const row = y * labelled.width;
    for (let x = 0; x < labelled.width; x += 1) {
      if (labelled.labels[row + x] === largest.label) points.push({ x, y });
    }
  }

  const hull = convexHull(points);
  const perimeter = polygonPerimeter(hull);
  // Try progressively coarser simplification until four corners fall out. A
  // single fixed tolerance fails on either rounded corners or a ragged edge.
  let quadPoints: Point[] | null = null;
  for (const fraction of [0.02, 0.03, 0.045, 0.06, 0.08]) {
    const simplified = approxPolygon(hull, perimeter * fraction);
    if (simplified.length === 4) {
      quadPoints = simplified;
      break;
    }
  }

  if (!quadPoints) {
    // No clean quadrilateral. A rotated rectangle still beats nothing when the
    // blob is convincingly page-shaped, but it cannot correct perspective, so
    // the confidence reflects that.
    const rect = minAreaRect(hull);
    const aspect = rect.width / Math.max(1, rect.height);
    if (aspect >= MIN_ASPECT && aspect <= MAX_ASPECT) {
      const skew = (rect.angle * 180) / Math.PI;
      return {
        method: "skew",
        quad: fullFrame,
        skewDegrees: skew,
        confidence: 0.55,
        reason: "page outline is not a clean quadrilateral; corrected rotation only",
      };
    }
    return { method: "full-frame", quad: fullFrame, skewDegrees: 0, confidence: 0.3, reason: "page outline could not be simplified to four corners" };
  }

  const scaled = quadPoints.map((p) => ({ x: p.x * scale, y: p.y * scale }));
  let quad: Quad;
  try {
    quad = orderQuad(scaled);
  } catch {
    return { method: "full-frame", quad: fullFrame, skewDegrees: 0, confidence: 0.3, reason: "page corners could not be ordered" };
  }

  const check = validateQuad(quad, gray.width, gray.height);
  if (!check.ok) {
    return { method: "full-frame", quad: fullFrame, skewDegrees: 0, confidence: 0.3, reason: check.reason };
  }

  // Is there actually a BACKGROUND behind these edges? Everything above this
  // point is shape reasoning, and shape cannot tell a sheet of paper from the
  // larger half of a sheet of paper. See `edgeSupport`.
  const support = edgeSupport(small, quad, scale);
  if (support.supported < MIN_SUPPORTED_EDGES) {
    return {
      method: "full-frame",
      quad: fullFrame,
      skewDegrees: 0,
      confidence: 0.4,
      reason: `only ${support.supported} of 4 page edges have a background behind them (${support.detail}); reading the whole frame instead`,
    };
  }

  return {
    method: "perspective",
    quad,
    skewDegrees: 0,
    // Confidence now carries evidence about the PAGE, not just about the shape.
    // A quad with three supported edges is a weaker claim than one with four,
    // and the number on screen should say so.
    confidence: check.confidence * (support.supported / 4),
    reason: `four page corners located, ${support.supported} of 4 edges backed by background`,
  };
}

/**
 * How many of the quad's four edges have a genuinely darker background outside
 * them.
 *
 * THIS IS THE CHECK THAT WAS MISSING, and its absence is why the product
 * reported maximum confidence on a quad covering 85 % of a sheet.
 *
 * `validateQuad` is not given the image. It cannot be: its signature takes a
 * quad and two integers. So every question it asks is about SHAPE — is this
 * rectangular, is it big enough, are the corners square — and shape is
 * identical for the page and for the larger fragment of a page that has been
 * cut in two. A full-bleed dark band across the sheet (a heavy rule under a
 * printed header, a fold, a scanner-lid shadow) survives the `close(bright, 5)`
 * at ~4.2 mm on A4, severs the bright mask into two components, and
 * `components[0]` — largest by area — becomes "the page". The discarded strip
 * is never mentioned. Measured: a 5 mm band is enough, a 3 mm band is absorbed.
 *
 * A real page edge has one property no internal line has: PAPER ON ONE SIDE AND
 * NOT-PAPER ON THE OTHER. An ink line has paper on both sides. That is the
 * whole test, and it separates the cases by a mile rather than by a threshold —
 * measured 4 of 4 on a genuine desk photo (inside 194-229 against outside
 * 54-64) versus 1 of 4 on every severed variant, including a soft grey shadow.
 *
 * An edge sampled off the frame counts as UNSUPPORTED, deliberately. A quad
 * edge lying on the image border has no background behind it because the
 * photograph does not extend far enough to show one, so the claim "this is
 * where the paper stops" is exactly as unevidenced as it is for an ink line.
 */
function edgeSupport(small: Gray, quad: Quad, scale: number): { supported: number; detail: string } {
  const q = [quad.tl, quad.tr, quad.br, quad.bl].map((p) => ({ x: p.x / scale, y: p.y / scale }));
  const [tl, tr, br, bl] = q as [Point, Point, Point, Point];

  // Sample this far either side of the edge, as a fraction of the short
  // dimension. Far enough to clear the edge's own blur and any drop shadow,
  // close enough to stay on the background rather than wandering onto the next
  // object on the desk.
  const offset = Math.max(3, Math.round(0.015 * Math.min(small.width, small.height)));
  const centre = {
    x: (tl.x + tr.x + br.x + bl.x) / 4,
    y: (tl.y + tr.y + br.y + bl.y) / 4,
  };

  const edges: readonly (readonly [string, Point, Point])[] = [
    ["top", tl, tr],
    ["right", tr, br],
    ["bottom", br, bl],
    ["left", bl, tl],
  ];

  let supported = 0;
  const notes: string[] = [];

  for (const [name, a, b] of edges) {
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    let nx = centre.x - midX;
    let ny = centre.y - midY;
    const length = Math.hypot(nx, ny) || 1;
    nx /= length;
    ny /= length;

    const inside: number[] = [];
    const outside: (number | null)[] = [];
    for (let t = 0.05; t <= 0.95; t += 0.01) {
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const ix = Math.round(px + nx * offset);
      const iy = Math.round(py + ny * offset);
      const ox = Math.round(px - nx * offset);
      const oy = Math.round(py - ny * offset);
      inside.push(inBounds(small, ix, iy) ? small.data[iy * small.width + ix]! : 255);
      outside.push(inBounds(small, ox, oy) ? small.data[oy * small.width + ox]! : null);
    }

    const insideMedian = median(inside);
    let darker = 0;
    for (const sample of outside) {
      if (sample !== null && sample <= insideMedian - EDGE_BACKGROUND_DROP) darker += 1;
    }
    const fraction = darker / outside.length;
    if (fraction >= EDGE_SUPPORT_FRACTION) {
      supported += 1;
    } else {
      notes.push(name);
    }
  }

  return {
    supported,
    detail: notes.length ? `${notes.join(", ")} unsupported` : "all supported",
  };
}

function inBounds(image: Gray, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < image.width && y < image.height;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] ?? 0;
}

/**
 * Rejects quads that are geometrically implausible as a photographed page.
 *
 * This is the guard that turns a bad detection into a graceful fallback instead
 * of a confidently wrong warp. Every check corresponds to a real failure seen
 * in document scanning: a sliver (detected the page's shadow), a wildly
 * non-rectangular shape (detected a desk edge plus part of the page), or a
 * degenerate corner set.
 */
function validateQuad(quad: Quad, width: number, height: number): { ok: boolean; confidence: number; reason: string } {
  const corners = [quad.tl, quad.tr, quad.br, quad.bl];
  const area = Math.abs(shoelace(corners));
  const frameArea = width * height;
  if (area < frameArea * MIN_PAGE_AREA_FRACTION) {
    return { ok: false, confidence: 0, reason: `page quad covers only ${((area / frameArea) * 100).toFixed(0)}% of the frame` };
  }

  const top = distance(quad.tl, quad.tr);
  const bottom = distance(quad.bl, quad.br);
  const left = distance(quad.tl, quad.bl);
  const right = distance(quad.tr, quad.br);
  if (Math.min(top, bottom, left, right) < 40) {
    return { ok: false, confidence: 0, reason: "page quad has a degenerate side" };
  }

  const aspect = Math.max(top, bottom) / Math.max(1, Math.max(left, right));
  if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) {
    return { ok: false, confidence: 0, reason: `page aspect ratio ${aspect.toFixed(2)} is not a document shape` };
  }

  // Opposing sides of a photographed rectangle converge, but not by much at
  // sane shooting distances. A 2:1 ratio means the "page" is not planar or the
  // corners are wrong.
  const horizontalRatio = Math.max(top, bottom) / Math.min(top, bottom);
  const verticalRatio = Math.max(left, right) / Math.min(left, right);
  if (horizontalRatio > 2 || verticalRatio > 2) {
    return { ok: false, confidence: 0, reason: "opposing page edges differ too much to be one flat page" };
  }

  // Corner angles. A perspective view distorts them, but a real page keeps all
  // four within roughly 55-125 degrees at any reasonable angle.
  let worst = 0;
  for (let i = 0; i < 4; i += 1) {
    const previous = corners[(i + 3) % 4]!;
    const current = corners[i]!;
    const next = corners[(i + 1) % 4]!;
    const angle = Math.abs(cornerAngle(previous, current, next) - 90);
    if (angle > worst) worst = angle;
  }
  if (worst > 35) {
    return { ok: false, confidence: 0, reason: `page corner is ${(90 + worst).toFixed(0)} degrees, too far from square` };
  }

  // More distortion means more risk that the homography is slightly off, so the
  // confidence tracks how square the quad already was.
  const squareness = 1 - worst / 35;
  const evenness = 1 - Math.min(1, (horizontalRatio + verticalRatio - 2) / 2);
  return { ok: true, confidence: 0.6 + 0.4 * Math.min(squareness, evenness), reason: "ok" };
}

/**
 * Estimates page skew from the horizontal structure of the content.
 *
 * Rotates a downsampled ink mask through candidate angles and measures the
 * variance of its horizontal projection profile. When the rotation is correct,
 * text lines and printed rules are horizontal, so rows are either very full or
 * very empty and the variance peaks sharply. When it is wrong, every row is
 * about equally full and the variance flattens.
 *
 * Coarse-to-fine: 1-degree steps across +/-8 degrees, then 0.1-degree steps
 * around the winner. Searching 0.1 degrees across the whole range directly
 * would be 160 full evaluations for the same answer.
 */
export function estimateSkewAngle(gray: Gray, maxDegrees = 8): number {
  const small = fitWithin(gray, 800);
  const { ink } = binarizeDocument(small);

  // Column sums once, then the rotation is applied analytically per column when
  // accumulating rows — far cheaper than rotating the image at every candidate.
  const columns: { x: number; y: number }[] = [];
  for (let y = 0; y < ink.height; y += 1) {
    const row = y * ink.width;
    for (let x = 0; x < ink.width; x += 1) {
      if (ink.data[row + x] !== 0) columns.push({ x, y });
    }
  }
  if (columns.length < 200) return 0;

  const centreX = ink.width / 2;
  const centreY = ink.height / 2;

  const score = (degrees: number): number => {
    const radians = (degrees * Math.PI) / 180;
    const sin = Math.sin(radians);
    const cos = Math.cos(radians);
    const profile = new Float64Array(ink.height + 1);
    for (const p of columns) {
      const dy = -(p.x - centreX) * sin + (p.y - centreY) * cos + centreY;
      const row = Math.round(dy);
      if (row >= 0 && row <= ink.height) profile[row] += 1;
    }
    // Variance of the profile. Higher = the rows are more differentiated =
    // the content is more aligned to horizontal.
    let mean = 0;
    for (let i = 0; i < profile.length; i += 1) mean += profile[i]!;
    mean /= profile.length;
    let variance = 0;
    for (let i = 0; i < profile.length; i += 1) {
      const d = profile[i]! - mean;
      variance += d * d;
    }
    return variance;
  };

  let bestAngle = 0;
  let bestScore = -1;
  for (let degrees = -maxDegrees; degrees <= maxDegrees; degrees += 1) {
    const value = score(degrees);
    if (value > bestScore) {
      bestScore = value;
      bestAngle = degrees;
    }
  }
  for (let degrees = bestAngle - 1; degrees <= bestAngle + 1; degrees += 0.1) {
    const value = score(degrees);
    if (value > bestScore) {
      bestScore = value;
      bestAngle = degrees;
    }
  }

  // The projection profile is symmetric under 180-degree flips and is only
  // meaningful for small corrections; anything larger is a detection failure,
  // not a skewed page.
  return Math.abs(bestAngle) > maxDegrees ? 0 : Number(bestAngle.toFixed(2));
}

/**
 * Applies the detected correction and returns the rectified page.
 *
 * `maxEdge` bounds the output. The default matches the working resolution, so
 * the rectified page is directly comparable with the un-rectified working copy
 * and template coordinates mean the same thing in both.
 */
export function rectifyPage(gray: Gray, detection: PageDetection, maxEdge = 2400): RectifiedPage {
  if (detection.method === "perspective") {
    const size = quadOutputSize(detection.quad, maxEdge);
    const image = warpQuad(gray, detection.quad, size.width, size.height);
    return { image, detection, width: size.width, height: size.height };
  }

  if (detection.method === "skew" && Math.abs(detection.skewDegrees) >= 0.25) {
    const image = rotateGray(gray, -detection.skewDegrees);
    const fitted = fitWithin(image, maxEdge);
    return { image: fitted, detection, width: fitted.width, height: fitted.height };
  }

  const fitted = fitWithin(gray, maxEdge);
  return { image: fitted, detection, width: fitted.width, height: fitted.height };
}

/**
 * Rotates about the centre, keeping the original canvas size.
 *
 * Corners that rotate out of frame are lost, which is correct here: this is
 * only ever used for skew corrections of a few degrees, where the lost wedge is
 * page margin. Growing the canvas instead would change the image dimensions and
 * therefore every normalized coordinate computed from them.
 */
export function rotateGray(image: Gray, degrees: number): Gray {
  const radians = (degrees * Math.PI) / 180;
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const centreX = image.width / 2;
  const centreY = image.height / 2;
  const out = createMask(image.width, image.height);
  const dst = out.data;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      // Inverse map: where in the source does this destination pixel come from?
      const dx = x - centreX;
      const dy = y - centreY;
      const sx = dx * cos + dy * sin + centreX;
      const sy = -dx * sin + dy * cos + centreY;
      if (sx < 0 || sy < 0 || sx > image.width - 1 || sy > image.height - 1) {
        // Outside the page is paper white, not black — a black wedge would be
        // read as ink by every downstream threshold.
        dst[y * image.width + x] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(image.width - 1, x0 + 1);
      const y1 = Math.min(image.height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const a = image.data[y0 * image.width + x0]!;
      const b = image.data[y0 * image.width + x1]!;
      const c = image.data[y1 * image.width + x0]!;
      const d = image.data[y1 * image.width + x1]!;
      const top = a + (b - a) * fx;
      const bottom = c + (d - c) * fx;
      dst[y * image.width + x] = top + (bottom - top) * fy;
    }
  }
  return { data: dst, width: image.width, height: image.height };
}

// ---------------------------------------------------------------------------

function frameQuad(width: number, height: number): Quad {
  return {
    tl: { x: 0, y: 0 },
    tr: { x: width, y: 0 },
    br: { x: width, y: height },
    bl: { x: 0, y: height },
  };
}

function shoelace(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

function polygonPerimeter(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i += 1) {
    total += distance(points[i]!, points[(i + 1) % points.length]!);
  }
  return total;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function cornerAngle(previous: Point, current: Point, next: Point): number {
  const ax = previous.x - current.x;
  const ay = previous.y - current.y;
  const bx = next.x - current.x;
  const by = next.y - current.y;
  const dot = ax * bx + ay * by;
  const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
  if (magnitude < 1e-9) return 0;
  return (Math.acos(Math.max(-1, Math.min(1, dot / magnitude))) * 180) / Math.PI;
}

/** Re-exported so callers can build a working copy at a chosen size without importing gray.ts. */
export { resizeGray };
