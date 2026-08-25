/**
 * Core image types for the vision pipeline.
 *
 * Everything here is a plain typed array plus width/height. No classes, no
 * dependencies, no hidden state — so every function in `lib/vision/` is a pure
 * transform that a unit test can call with a hand-built 8x8 image and assert
 * exact pixel values on.
 *
 * Two conventions hold throughout the module and are worth stating once:
 *
 *  1. **Row-major, origin top-left.** Index of (x, y) is always `y * width + x`
 *     for single-channel and `(y * width + x) * channels` for interleaved.
 *  2. **Ink is HIGH in a mask, not low.** A `Mask` value of 255 means "this
 *     pixel is part of the thing" (ink, foreground, the detected region). This
 *     is the opposite of how a scanned page looks — paper is bright, ink is
 *     dark — so `binarize()` inverts. Getting this backwards silently produces
 *     a mask of the paper instead of a mask of the writing, and every
 *     downstream statistic then looks plausible while being exactly wrong.
 */

/** Single-channel 8-bit image. */
export interface Gray {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * Binary mask. Values are only ever 0 or 255 — never anything between.
 * Kept as a distinct type from `Gray` so the compiler stops a grayscale image
 * being passed to a function that assumes two-valued input.
 */
export interface Mask {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Interleaved RGB or RGBA, 8-bit per channel. */
export interface Rgb {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
}

/** Single-channel float image, for gradients, energy maps and score maps. */
export interface F32 {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned rectangle in pixel coordinates. `x`/`y` are the top-left. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Rectangle in normalized [0,1] coordinates relative to some reference image.
 *
 * Template geometry and anything that crosses the wire uses this, never pixels:
 * the same form is photographed at 12 MP on one phone and 2 MP on another, and
 * a stored pixel box would be meaningless on the second one.
 */
export interface NormRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Four-cornered polygon, used for page boundaries and rotated rectangles.
 * Corners are ordered clockwise from the top-left as seen in the image.
 */
export interface Quad {
  readonly tl: Point;
  readonly tr: Point;
  readonly br: Point;
  readonly bl: Point;
}

/** A rectangle that may be rotated, as returned by minimum-area-rect fitting. */
export interface RotatedRect {
  readonly cx: number;
  readonly cy: number;
  readonly width: number;
  readonly height: number;
  /** Radians, in [-PI/2, PI/2). Positive is counter-clockwise. */
  readonly angle: number;
}

/** 3x3 matrix in row-major order, for homographies and affine transforms. */
export type Matrix3 = readonly [
  number, number, number,
  number, number, number,
  number, number, number,
];

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function createGray(width: number, height: number, fill = 0): Gray {
  assertSize(width, height);
  const data = new Uint8ClampedArray(width * height);
  if (fill !== 0) data.fill(fill);
  return { data, width, height };
}

export function createMask(width: number, height: number, fill = 0): Mask {
  assertSize(width, height);
  const data = new Uint8ClampedArray(width * height);
  if (fill !== 0) data.fill(fill);
  return { data, width, height };
}

export function createF32(width: number, height: number, fill = 0): F32 {
  assertSize(width, height);
  const data = new Float32Array(width * height);
  if (fill !== 0) data.fill(fill);
  return { data, width, height };
}

/**
 * Wraps an existing buffer without copying. The buffer must be exactly
 * `width * height` long — a mismatch here is the kind of bug that produces a
 * diagonally-sheared image and forty minutes of confusion, so it throws.
 */
export function grayFrom(data: Uint8ClampedArray, width: number, height: number): Gray {
  assertSize(width, height);
  if (data.length !== width * height) {
    throw new Error(`grayFrom: buffer is ${data.length} bytes, expected ${width * height} for ${width}x${height}`);
  }
  return { data, width, height };
}

export function maskFrom(data: Uint8ClampedArray, width: number, height: number): Mask {
  assertSize(width, height);
  if (data.length !== width * height) {
    throw new Error(`maskFrom: buffer is ${data.length} bytes, expected ${width * height} for ${width}x${height}`);
  }
  return { data, width, height };
}

export function rgbFrom(data: Uint8ClampedArray, width: number, height: number, channels: 3 | 4): Rgb {
  assertSize(width, height);
  if (data.length !== width * height * channels) {
    throw new Error(
      `rgbFrom: buffer is ${data.length} bytes, expected ${width * height * channels} for ${width}x${height}x${channels}`,
    );
  }
  return { data, width, height, channels };
}

function assertSize(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid image size ${width}x${height}: dimensions must be positive integers.`);
  }
  // 100 MP. A phone photo is at most ~12 MP; anything past this is a decode
  // bomb or a units mistake, and allocating it would take the function down.
  if (width * height > 100_000_000) {
    throw new Error(`Refusing to allocate ${width}x${height} (${width * height} px): over the 100 MP ceiling.`);
  }
}

// ---------------------------------------------------------------------------
// Rect helpers
// ---------------------------------------------------------------------------

export function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectRight(rect: Rect): number {
  return rect.x + rect.width;
}

export function rectBottom(rect: Rect): number {
  return rect.y + rect.height;
}

export function rectCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Intersection of two rects, or null when they do not overlap. */
export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(rectRight(a), rectRight(b));
  const bottom = Math.min(rectBottom(a), rectBottom(b));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(rectRight(a), rectRight(b));
  const bottom = Math.max(rectBottom(a), rectBottom(b));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Intersection over union. The standard agreement measure between a detected
 * box and a reference box; the fusion stage in `region-extraction` votes on it.
 * Returns 0 for disjoint boxes and 1 for identical ones.
 */
export function iou(a: Rect, b: Rect): number {
  const overlap = rectIntersection(a, b);
  if (!overlap) return 0;
  const intersection = rectArea(overlap);
  const union = rectArea(a) + rectArea(b) - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/**
 * Fraction of `inner` that lies inside `outer`. Unlike IoU this is asymmetric,
 * which is what you want when asking "is this small detection contained in that
 * large template region?" — IoU would score that low purely on the size gap.
 */
export function containment(inner: Rect, outer: Rect): number {
  const overlap = rectIntersection(inner, outer);
  if (!overlap) return 0;
  const area = rectArea(inner);
  return area <= 0 ? 0 : rectArea(overlap) / area;
}

/** Grows a rect by `pad` on every side, then clips it to the image bounds. */
export function padRect(rect: Rect, pad: number, width: number, height: number): Rect {
  return clipRect(
    { x: rect.x - pad, y: rect.y - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 },
    width,
    height,
  );
}

/** Clips to [0,width]x[0,height] and rounds to integers. Never returns negative extents. */
export function clipRect(rect: Rect, width: number, height: number): Rect {
  const x = Math.max(0, Math.min(width, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(height, Math.floor(rect.y)));
  const right = Math.max(x, Math.min(width, Math.ceil(rect.x + rect.width)));
  const bottom = Math.max(y, Math.min(height, Math.ceil(rect.y + rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function toNormRect(rect: Rect, width: number, height: number): NormRect {
  return { x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height };
}

export function fromNormRect(rect: NormRect, width: number, height: number): Rect {
  return clipRect(
    { x: rect.x * width, y: rect.y * height, width: rect.width * width, height: rect.height * height },
    width,
    height,
  );
}

/** Bounding box of a set of points. Throws on an empty set rather than returning a degenerate rect. */
export function boundsOf(points: readonly Point[]): Rect {
  if (points.length === 0) throw new Error("boundsOf: no points");
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function quadPoints(quad: Quad): readonly Point[] {
  return [quad.tl, quad.tr, quad.br, quad.bl];
}

/** Corners of a rotated rect, clockwise from the corner nearest the top-left. */
export function rotatedRectCorners(rect: RotatedRect): Point[] {
  const cos = Math.cos(rect.angle);
  const sin = Math.sin(rect.angle);
  const hw = rect.width / 2;
  const hh = rect.height / 2;
  const offsets: readonly Point[] = [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
  return offsets.map((o) => ({
    x: rect.cx + o.x * cos - o.y * sin,
    y: rect.cy + o.x * sin + o.y * cos,
  }));
}

/** Axis-aligned bounding box that contains a rotated rect. */
export function rotatedRectBounds(rect: RotatedRect): Rect {
  return boundsOf(rotatedRectCorners(rect));
}
