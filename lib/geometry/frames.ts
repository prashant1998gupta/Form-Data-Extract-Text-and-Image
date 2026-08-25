/**
 * Coordinate frames — the contract every other module obeys.
 *
 * Four frames exist and they are never interchangeable. Confusing them is the
 * single most common source of silent misalignment in a document pipeline: the
 * output still looks like a page, so nothing downstream can tell that every
 * coordinate is now addressing the wrong part of the form.
 *
 *   ORIG    Original captured pixels, after EXIF auto-orientation. Never
 *           resampled, never re-encoded. Archival, and the source every
 *           delivered crop is ultimately sampled from.
 *
 *   CTS     Canonical Template Space. The page in MILLIMETRES, rasterised at
 *           200 dpi. A4 becomes 1654x2339. All analysis and all stored geometry
 *           live here.
 *
 *   DETAIL  A CTS-aligned band or ROI resampled from ORIG at 300 dpi, in one
 *           pass. Used for edge refinement and for field crops that will be
 *           read.
 *
 *   OUT     Delivered crop rasters. A passport photo is 413x531 — 35x45 mm at
 *           300 dpi, exactly.
 *
 * THE RULES, which the rest of the codebase depends on:
 *
 * 1. **Every persisted rectangle, quad, anchor and correction is stored in
 *    millimetres.** Never pixels. The same form is photographed at 12 MP on one
 *    phone and 2 MP on another; a stored pixel box is meaningless on the second.
 *    Millimetres are a property of the paper, which does not change.
 *
 * 2. **There is exactly ONE resample between ORIG and any delivered crop.**
 *    Deskew, perspective correction and scaling compose into a single 3x3
 *    homography applied once. Two interpolations is a bug — each one softens
 *    the handwriting we are trying to read.
 *
 * 3. **`H` always means ORIG to CTS.** `invert3(H)` maps a CTS rectangle back
 *    into original pixels. Any variable holding the other direction is named
 *    explicitly (`ctsToOrig`), never `H`.
 *
 * 4. **No raw pixel constant exists outside this file.** Every threshold
 *    elsewhere is in millimetres, or is a ratio against a statistic measured in
 *    the same scan. That is what lets the same constants work at 170 dpi and at
 *    600 dpi.
 */

import { applyHomography, invert3 } from "../vision/geometry.ts";
import type { Matrix3, Point, Quad, Rect } from "../vision/types.ts";

/** Resolution of the Canonical Template Space raster. */
export const CTS_DPI = 200;
/** Resolution of DETAIL bands — edge fitting and field reading. */
export const DETAIL_DPI = 300;
/** Resolution of delivered image crops. */
export const OUT_DPI = 300;

const MM_PER_INCH = 25.4;

export const CTS_PX_PER_MM = CTS_DPI / MM_PER_INCH; // 7.874015...
export const DETAIL_PX_PER_MM = DETAIL_DPI / MM_PER_INCH; // 11.811023...
export const OUT_PX_PER_MM = OUT_DPI / MM_PER_INCH;

/**
 * A rectangle on the physical page, in millimetres from the top-left corner.
 * This is the ONLY shape that is ever persisted or sent over the wire.
 *
 * Structurally identical to `Rect`, and deliberately a distinct type so the
 * compiler refuses a pixel rect where a millimetre rect belongs. That mistake
 * is otherwise invisible until a crop lands in the wrong place.
 */
export interface RectMM {
  readonly xMM: number;
  readonly yMM: number;
  readonly widthMM: number;
  readonly heightMM: number;
}

/** A point on the physical page, in millimetres. */
export interface PointMM {
  readonly xMM: number;
  readonly yMM: number;
}

/** A quadrilateral on the physical page, in millimetres. Crooked pasted photos need this. */
export interface QuadMM {
  readonly tl: PointMM;
  readonly tr: PointMM;
  readonly br: PointMM;
  readonly bl: PointMM;
}

/** Physical page size. Everything in CTS is derived from this. */
export interface PageSizeMM {
  readonly widthMM: number;
  readonly heightMM: number;
}

export const A4: PageSizeMM = { widthMM: 210, heightMM: 297 };
export const A5: PageSizeMM = { widthMM: 148, heightMM: 210 };
export const LETTER: PageSizeMM = { widthMM: 215.9, heightMM: 279.4 };
export const LEGAL: PageSizeMM = { widthMM: 215.9, heightMM: 355.6 };
/**
 * Foolscap / FS, 8.5 x 13 in.
 *
 * Included because the target market actually uses it. Indian hospitals,
 * schools and government offices commonly print forms on FS rather than A4, and
 * its aspect (0.654) differs from A4's (0.707) by 7.5 % — enough that a form
 * declared A4 but printed on FS puts every template coordinate progressively
 * further out down the page. A template that cannot say "this form is FS" is a
 * template that silently mis-registers a whole class of real documents.
 */
export const FOOLSCAP: PageSizeMM = { widthMM: 215.9, heightMM: 330.2 };

/** The page sizes a person may choose when teaching a form. */
export const PAGE_SIZES = {
  A4,
  A5,
  LETTER,
  LEGAL,
  FOOLSCAP,
} as const satisfies Record<string, PageSizeMM>;

export type PageSizeKey = keyof typeof PAGE_SIZES;

/** Standard photo sizes an admin picks from. Never guessed at detection time. */
export const PHOTO_SIZES = {
  /** Indian / most-of-the-world passport. */
  passport35x45: { widthMM: 35, heightMM: 45 },
  /** Indian stamp size, common on school and employment forms. */
  stamp25x35: { widthMM: 25, heightMM: 35 },
  /** US passport, square. */
  us51x51: { widthMM: 50.8, heightMM: 50.8 },
} as const satisfies Record<string, { widthMM: number; heightMM: number }>;

export type PhotoSizeKey = keyof typeof PHOTO_SIZES;

/** Pixel dimensions of the CTS raster for a given page. A4 -> 1654x2339. */
export function ctsSize(page: PageSizeMM): { width: number; height: number } {
  return {
    width: Math.round(page.widthMM * CTS_PX_PER_MM),
    height: Math.round(page.heightMM * CTS_PX_PER_MM),
  };
}

/** Pixel dimensions of the delivered crop for a photo size. 35x45 mm -> 413x531. */
export function outSize(size: { widthMM: number; heightMM: number }): { width: number; height: number } {
  return {
    width: Math.round(size.widthMM * OUT_PX_PER_MM),
    height: Math.round(size.heightMM * OUT_PX_PER_MM),
  };
}

// ---------------------------------------------------------------------------
// mm <-> CTS pixels
// ---------------------------------------------------------------------------

export function mmToCts(rect: RectMM): Rect {
  return {
    x: rect.xMM * CTS_PX_PER_MM,
    y: rect.yMM * CTS_PX_PER_MM,
    width: rect.widthMM * CTS_PX_PER_MM,
    height: rect.heightMM * CTS_PX_PER_MM,
  };
}

export function ctsToMm(rect: Rect): RectMM {
  return {
    xMM: rect.x / CTS_PX_PER_MM,
    yMM: rect.y / CTS_PX_PER_MM,
    widthMM: rect.width / CTS_PX_PER_MM,
    heightMM: rect.height / CTS_PX_PER_MM,
  };
}

export function pointMmToCts(point: PointMM): Point {
  return { x: point.xMM * CTS_PX_PER_MM, y: point.yMM * CTS_PX_PER_MM };
}

export function pointCtsToMm(point: Point): PointMM {
  return { xMM: point.x / CTS_PX_PER_MM, yMM: point.y / CTS_PX_PER_MM };
}

export function quadMmToCts(quad: QuadMM): Quad {
  return {
    tl: pointMmToCts(quad.tl),
    tr: pointMmToCts(quad.tr),
    br: pointMmToCts(quad.br),
    bl: pointMmToCts(quad.bl),
  };
}

export function quadCtsToMm(quad: Quad): QuadMM {
  return {
    tl: pointCtsToMm(quad.tl),
    tr: pointCtsToMm(quad.tr),
    br: pointCtsToMm(quad.br),
    bl: pointCtsToMm(quad.bl),
  };
}

/** Millimetres to CTS pixels, for a length rather than a coordinate. */
export function mm(value: number): number {
  return value * CTS_PX_PER_MM;
}

/** CTS pixels back to millimetres. */
export function toMm(pixels: number): number {
  return pixels / CTS_PX_PER_MM;
}

/** Millimetres to DETAIL pixels. */
export function detailMm(value: number): number {
  return value * DETAIL_PX_PER_MM;
}

// ---------------------------------------------------------------------------
// ROI expansion
// ---------------------------------------------------------------------------

/**
 * Grows a millimetre rectangle by the larger of an absolute pad and a fraction
 * of its own size.
 *
 * Both terms are needed. The absolute pad covers registration residue and a
 * hand-glued photo sitting proud of its printed box — a constant few
 * millimetres regardless of element size. The fractional term covers habitual
 * overflow, which scales with the element: signatures overflow their box by a
 * proportion of its width, not by a fixed distance.
 */
export function expandMM(rect: RectMM, minPadMM: number, fraction: number): RectMM {
  const padX = Math.max(minPadMM, rect.widthMM * fraction);
  const padY = Math.max(minPadMM, rect.heightMM * fraction);
  return {
    xMM: rect.xMM - padX,
    yMM: rect.yMM - padY,
    widthMM: rect.widthMM + padX * 2,
    heightMM: rect.heightMM + padY * 2,
  };
}

/** Clips a millimetre rectangle to the page. */
export function clipToPage(rect: RectMM, page: PageSizeMM): RectMM {
  const x = Math.max(0, Math.min(page.widthMM, rect.xMM));
  const y = Math.max(0, Math.min(page.heightMM, rect.yMM));
  const right = Math.max(x, Math.min(page.widthMM, rect.xMM + rect.widthMM));
  const bottom = Math.max(y, Math.min(page.heightMM, rect.yMM + rect.heightMM));
  return { xMM: x, yMM: y, widthMM: right - x, heightMM: bottom - y };
}

export function areaMM(rect: RectMM): number {
  return Math.max(0, rect.widthMM) * Math.max(0, rect.heightMM);
}

export function centreMM(rect: RectMM): PointMM {
  return { xMM: rect.xMM + rect.widthMM / 2, yMM: rect.yMM + rect.heightMM / 2 };
}

export function quadBoundsMM(quad: QuadMM): RectMM {
  const xs = [quad.tl.xMM, quad.tr.xMM, quad.br.xMM, quad.bl.xMM];
  const ys = [quad.tl.yMM, quad.tr.yMM, quad.br.yMM, quad.bl.yMM];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { xMM: x, yMM: y, widthMM: Math.max(...xs) - x, heightMM: Math.max(...ys) - y };
}

/** Rectangle to quad, corners clockwise from top-left. */
export function rectToQuadMM(rect: RectMM): QuadMM {
  return {
    tl: { xMM: rect.xMM, yMM: rect.yMM },
    tr: { xMM: rect.xMM + rect.widthMM, yMM: rect.yMM },
    br: { xMM: rect.xMM + rect.widthMM, yMM: rect.yMM + rect.heightMM },
    bl: { xMM: rect.xMM, yMM: rect.yMM + rect.heightMM },
  };
}

/** Side lengths of a quad in millimetres, in the order top, right, bottom, left. */
export function quadSidesMM(quad: QuadMM): [number, number, number, number] {
  const d = (a: PointMM, b: PointMM) => Math.hypot(a.xMM - b.xMM, a.yMM - b.yMM);
  return [d(quad.tl, quad.tr), d(quad.tr, quad.br), d(quad.br, quad.bl), d(quad.bl, quad.tl)];
}

/**
 * Rotation of a quad away from upright, in degrees, from the mean direction of
 * its two horizontal edges. This is the paste angle of a crooked photograph,
 * and it is what the deskewing warp undoes.
 */
export function quadRotationDegrees(quad: QuadMM): number {
  const topAngle = Math.atan2(quad.tr.yMM - quad.tl.yMM, quad.tr.xMM - quad.tl.xMM);
  const bottomAngle = Math.atan2(quad.br.yMM - quad.bl.yMM, quad.br.xMM - quad.bl.xMM);
  return ((topAngle + bottomAngle) / 2) * (180 / Math.PI);
}

// ---------------------------------------------------------------------------
// ORIG <-> CTS
// ---------------------------------------------------------------------------

/**
 * A registered scan: the homography taking original pixels into CTS, plus the
 * page it was registered against.
 */
export interface Registration {
  /** ORIG -> CTS. */
  readonly h: Matrix3;
  readonly page: PageSizeMM;
}

/** Maps a millimetre point into original pixel coordinates. */
export function mmToOrig(registration: Registration, point: PointMM): Point {
  return applyHomography(invert3(registration.h), pointMmToCts(point));
}

/** Maps an original pixel point into millimetres on the page. */
export function origToMM(registration: Registration, point: Point): PointMM {
  return pointCtsToMm(applyHomography(registration.h, point));
}

/** Maps a millimetre quad into original pixel coordinates — the input to the single-resample crop. */
export function quadMmToOrig(registration: Registration, quad: QuadMM): Quad {
  const inverse = invert3(registration.h);
  const at = (p: PointMM) => applyHomography(inverse, pointMmToCts(p));
  return { tl: at(quad.tl), tr: at(quad.tr), br: at(quad.br), bl: at(quad.bl) };
}

/**
 * Effective resolution of the capture, in dots per inch of PAPER, measured
 * through the registration.
 *
 * This is the number that decides whether a crop can honestly be delivered at
 * 300 dpi or has to be marked `low_resolution`. It is measured, not assumed:
 * the same 12 MP camera gives 400 dpi held close and 140 dpi held at arm's
 * length, and only the homography knows which happened.
 */
export function effectiveDpi(registration: Registration): number {
  const inverse = invert3(registration.h);
  // Take a 10 mm horizontal step across the middle of the page and measure how
  // many original pixels it spans.
  const midY = registration.page.heightMM / 2;
  const a = applyHomography(inverse, pointMmToCts({ xMM: registration.page.widthMM / 2 - 5, yMM: midY }));
  const b = applyHomography(inverse, pointMmToCts({ xMM: registration.page.widthMM / 2 + 5, yMM: midY }));
  const pixelsPer10mm = Math.hypot(b.x - a.x, b.y - a.y);
  return (pixelsPer10mm / 10) * MM_PER_INCH;
}
