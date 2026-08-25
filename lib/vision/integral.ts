/**
 * Summed-area tables (integral images).
 *
 * Every local-window statistic in this pipeline — Sauvola binarization, local
 * variance, ink density, near-white fraction — is a mean or a variance over a
 * sliding box. Computed directly that is O(w·h·k²) and a 25x25 window over an
 * 8 MP image is roughly five billion adds, which is not a thing a serverless
 * function is going to do. With an integral image every box costs four lookups
 * regardless of window size, so the whole stage is O(w·h) and window size
 * becomes free to tune.
 *
 * Precision note: the tables are Float64Array, not Uint32Array. The squared
 * table for a 12 MP image sums to ~7.8e11, which exceeds a uint32 and would
 * wrap silently — producing negative variances and a binarization that looks
 * *almost* right, with corrupt patches. Float64 holds integers exactly up to
 * 2^53, far above anything we can allocate.
 */

import type { Gray, Mask, Rect } from "./types.ts";

export interface Integral {
  /** (width+1) x (height+1), with a zero first row and column so no bounds checks are needed. */
  readonly sum: Float64Array;
  readonly width: number;
  readonly height: number;
}

export interface IntegralPair {
  readonly sum: Float64Array;
  readonly sumSq: Float64Array;
  readonly width: number;
  readonly height: number;
}

/** Single summed-area table. Use when only means are needed. */
export function integralOf(image: Gray): Integral {
  const { width, height, data } = image;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const src = y * width;
    const cur = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < width; x += 1) {
      rowSum += data[src + x]!;
      sum[cur + x + 1] = sum[prev + x + 1]! + rowSum;
    }
  }
  return { sum, width, height };
}

/**
 * Summed-area tables for both the values and their squares, so mean and
 * variance come from one pass. Sauvola needs both; computing them separately
 * doubles the memory traffic over the image, which is the expensive part.
 */
export function integralPairOf(image: Gray): IntegralPair {
  const { width, height, data } = image;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  const sumSq = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    let rowSumSq = 0;
    const src = y * width;
    const cur = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < width; x += 1) {
      const v = data[src + x]!;
      rowSum += v;
      rowSumSq += v * v;
      sum[cur + x + 1] = sum[prev + x + 1]! + rowSum;
      sumSq[cur + x + 1] = sumSq[prev + x + 1]! + rowSumSq;
    }
  }
  return { sum, sumSq, width, height };
}

/** Integral of a mask, counting set pixels as 1. Gives "how many ink pixels in this box" in O(1). */
export function integralOfMask(mask: Mask): Integral {
  const { width, height, data } = mask;
  const stride = width + 1;
  const sum = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    const src = y * width;
    const cur = (y + 1) * stride;
    const prev = y * stride;
    for (let x = 0; x < width; x += 1) {
      if (data[src + x]! !== 0) rowSum += 1;
      sum[cur + x + 1] = sum[prev + x + 1]! + rowSum;
    }
  }
  return { sum, width, height };
}

/**
 * Sum over the half-open box [x0,x1) x [y0,y1). Coordinates are clamped, so a
 * window hanging off the edge returns the sum of the part that exists — which
 * is why the callers below always divide by the *clamped* area rather than the
 * nominal window area.
 */
export function boxSum(table: Integral | IntegralPair, x0: number, y0: number, x1: number, y1: number): number {
  const stride = table.width + 1;
  const ax = clamp(x0, 0, table.width);
  const ay = clamp(y0, 0, table.height);
  const bx = clamp(x1, 0, table.width);
  const by = clamp(y1, 0, table.height);
  if (bx <= ax || by <= ay) return 0;
  const s = table.sum;
  return s[by * stride + bx]! - s[ay * stride + bx]! - s[by * stride + ax]! + s[ay * stride + ax]!;
}

export function boxSumSq(table: IntegralPair, x0: number, y0: number, x1: number, y1: number): number {
  const stride = table.width + 1;
  const ax = clamp(x0, 0, table.width);
  const ay = clamp(y0, 0, table.height);
  const bx = clamp(x1, 0, table.width);
  const by = clamp(y1, 0, table.height);
  if (bx <= ax || by <= ay) return 0;
  const s = table.sumSq;
  return s[by * stride + bx]! - s[ay * stride + bx]! - s[by * stride + ax]! + s[ay * stride + ax]!;
}

/** Number of pixels the clamped box actually covers. Pair with boxSum to get a mean. */
export function boxArea(table: Integral | IntegralPair, x0: number, y0: number, x1: number, y1: number): number {
  const ax = clamp(x0, 0, table.width);
  const ay = clamp(y0, 0, table.height);
  const bx = clamp(x1, 0, table.width);
  const by = clamp(y1, 0, table.height);
  return Math.max(0, bx - ax) * Math.max(0, by - ay);
}

export function boxMean(table: Integral | IntegralPair, x0: number, y0: number, x1: number, y1: number): number {
  const area = boxArea(table, x0, y0, x1, y1);
  return area === 0 ? 0 : boxSum(table, x0, y0, x1, y1) / area;
}

/**
 * Population variance over the box. Clamped at zero: with float arithmetic a
 * genuinely uniform region can produce a variance of -1e-12, and the caller is
 * usually about to take a square root.
 */
export function boxVariance(table: IntegralPair, x0: number, y0: number, x1: number, y1: number): number {
  const area = boxArea(table, x0, y0, x1, y1);
  if (area === 0) return 0;
  const mean = boxSum(table, x0, y0, x1, y1) / area;
  const meanSq = boxSumSq(table, x0, y0, x1, y1) / area;
  return Math.max(0, meanSq - mean * mean);
}

/** Convenience wrappers taking a Rect instead of four coordinates. */
export function rectMean(table: Integral | IntegralPair, rect: Rect): number {
  return boxMean(table, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
}

export function rectSum(table: Integral | IntegralPair, rect: Rect): number {
  return boxSum(table, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
}

/**
 * Fraction of set pixels in a rect, given a mask integral. This is the "fill
 * ratio" the region detectors lean on: a thumb impression fills 35-60% of its
 * box, a signature under 20%, and blank paper under 2%.
 */
export function rectFillRatio(table: Integral, rect: Rect): number {
  const area = boxArea(table, rect.x, rect.y, rect.x + rect.width, rect.y + rect.height);
  return area === 0 ? 0 : rectSum(table, rect) / area;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
