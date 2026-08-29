/**
 * A single-stroke letter font for the synthetic form's handwriting.
 *
 * WHY THE SCRAWL HAD TO GO. The original handwriting was a wandering sine
 * stroke: right ink statistics, no letters. That was enough for the detectors,
 * which measure stroke width and baseline drift — but the moment a reader
 * existed, the fixtures started testing the wrong claim. A vision model shown
 * statistical scrawl either refuses (correct, and looks like the feature is
 * broken) or invents a plausible value (worse). A demo that manufactures its
 * own illegibility cannot demonstrate reading.
 *
 * So the fixtures now write real words with this font: every glyph is a few
 * polylines on a 6x10 grid, rendered with seeded jitter, slant, baseline drift
 * and varying pressure so the ink keeps the statistical properties the
 * detectors key on (variable stroke width, wandering baseline, rule overhang)
 * while being legible to a person and to a model. It looks like neat felt-tip
 * hand printing, not cursive — real forms are mostly hand-printed too.
 *
 * Everything is seeded through the caller's `random`, so output stays
 * byte-identical for a given seed and a failing test still reproduces.
 */

type Point = readonly [number, number];
type Stroke = readonly Point[];

/** Glyphs on a 6-wide, 10-tall grid; y grows downward, baseline at 10. */
const GLYPHS: Readonly<Record<string, readonly Stroke[]>> = {
  A: [[[0, 10], [3, 0], [6, 10]], [[1.5, 6], [4.5, 6]]],
  B: [[[0, 10], [0, 0], [4, 0], [5, 1], [5, 4], [4, 5], [0, 5]], [[4, 5], [5, 6], [5, 9], [4, 10], [0, 10]]],
  C: [[[5, 1], [3, 0], [1, 1], [0, 3], [0, 7], [1, 9], [3, 10], [5, 9]]],
  D: [[[0, 0], [0, 10]], [[0, 0], [3, 0], [5, 2], [5, 8], [3, 10], [0, 10]]],
  E: [[[5, 0], [0, 0], [0, 10], [5, 10]], [[0, 5], [4, 5]]],
  F: [[[5, 0], [0, 0], [0, 10]], [[0, 5], [4, 5]]],
  G: [[[5, 1], [3, 0], [1, 1], [0, 3], [0, 7], [1, 9], [3, 10], [5, 9], [5, 6], [3, 6]]],
  H: [[[0, 0], [0, 10]], [[6, 0], [6, 10]], [[0, 5], [6, 5]]],
  I: [[[3, 0], [3, 10]], [[1, 0], [5, 0]], [[1, 10], [5, 10]]],
  J: [[[5, 0], [5, 8], [4, 10], [1, 10], [0, 8]]],
  K: [[[0, 0], [0, 10]], [[5, 0], [0, 5.5], [5, 10]]],
  L: [[[0, 0], [0, 10], [5, 10]]],
  M: [[[0, 10], [0, 0], [3, 5], [6, 0], [6, 10]]],
  N: [[[0, 10], [0, 0], [6, 10], [6, 0]]],
  O: [[[1, 1], [0, 3], [0, 7], [1, 9], [3, 10], [5, 9], [6, 7], [6, 3], [5, 1], [3, 0], [1, 1]]],
  P: [[[0, 10], [0, 0], [4, 0], [5, 1], [5, 4], [4, 5], [0, 5]]],
  Q: [[[1, 1], [0, 3], [0, 7], [1, 9], [3, 10], [5, 9], [6, 7], [6, 3], [5, 1], [3, 0], [1, 1]], [[4, 7], [6, 10]]],
  R: [[[0, 10], [0, 0], [4, 0], [5, 1], [5, 4], [4, 5], [0, 5]], [[2, 5], [5, 10]]],
  S: [[[5, 1], [3, 0], [1, 0], [0, 2], [1, 4], [4, 6], [5, 8], [4, 10], [1, 10], [0, 9]]],
  T: [[[0, 0], [6, 0]], [[3, 0], [3, 10]]],
  U: [[[0, 0], [0, 8], [1, 10], [5, 10], [6, 8], [6, 0]]],
  V: [[[0, 0], [3, 10], [6, 0]]],
  W: [[[0, 0], [1.5, 10], [3, 4], [4.5, 10], [6, 0]]],
  X: [[[0, 0], [6, 10]], [[6, 0], [0, 10]]],
  Y: [[[0, 0], [3, 5], [6, 0]], [[3, 5], [3, 10]]],
  Z: [[[0, 0], [6, 0], [0, 10], [6, 10]]],
  "0": [[[1, 1], [0, 3], [0, 7], [1, 9], [3, 10], [5, 9], [6, 7], [6, 3], [5, 1], [3, 0], [1, 1]]],
  "1": [[[1, 2], [3, 0], [3, 10]], [[1, 10], [5, 10]]],
  "2": [[[0, 2], [1, 0], [4, 0], [5, 1], [5, 3], [0, 10], [6, 10]]],
  "3": [[[0, 1], [2, 0], [4, 0], [5, 1], [5, 4], [3, 5], [5, 6], [5, 9], [4, 10], [1, 10], [0, 9]]],
  "4": [[[4, 0], [0, 6], [6, 6]], [[4, 0], [4, 10]]],
  "5": [[[5, 0], [0, 0], [0, 4], [3, 4], [5, 5], [5, 8], [4, 10], [1, 10], [0, 9]]],
  "6": [[[5, 1], [3, 0], [1, 1], [0, 4], [0, 8], [1, 10], [4, 10], [5, 8], [5, 6], [4, 5], [1, 5], [0, 7]]],
  "7": [[[0, 0], [6, 0], [2, 10]]],
  "8": [[[3, 5], [1, 4], [1, 1], [3, 0], [5, 1], [5, 4], [3, 5], [1, 6], [1, 9], [3, 10], [5, 9], [5, 6], [3, 5]]],
  "9": [[[5, 5], [2, 5], [1, 4], [1, 1], [2, 0], [4, 0], [5, 1], [5, 8], [4, 10], [1, 10]]],
  "+": [[[3, 3], [3, 7]], [[1, 5], [5, 5]]],
  "-": [[[1, 5], [5, 5]]],
  "/": [[[0, 10], [5, 0]]],
  ".": [[[1, 9.4], [1.4, 10]]],
  ",": [[[1.4, 9], [1, 10.8]]],
  "@": [[[4.5, 6.5], [4, 4.5], [2.5, 4.5], [2, 6], [2.5, 7.5], [4, 7.5], [4.5, 4.5], [4.5, 7], [5.5, 7.5]], [[5.5, 7.5], [6, 6], [6, 3], [4.5, 1], [2, 1], [0.5, 3], [0.5, 7], [2, 9], [4.5, 9]]],
};

const GRID_HEIGHT = 10;
const ADVANCE = 8;

export interface StrokeTextOptions {
  readonly text: string;
  /** Left edge of the first glyph, in pixels. */
  readonly x: number;
  /** Top of the glyph grid (cap height line), in pixels. */
  readonly y: number;
  /** Cap height in pixels — the 10-unit grid maps onto this. */
  readonly height: number;
  /** Available width; glyphs shrink to fit when the text would overrun it. */
  readonly maxWidth: number;
  readonly random: () => number;
  /** Ink drop per stamped point: (px, py, thickness, alpha). */
  readonly mark: (px: number, py: number, thickness: number, alpha: number) => void;
  /** Photocopy-faint rendering. */
  readonly faint?: boolean;
}

export interface StrokeTextInk {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Writes `text` as jittered single-stroke print and returns the ink's
 * bounding box. Unknown characters advance without ink, so a value with an
 * unanticipated character degrades to a gap rather than a crash.
 */
export function strokeText(options: StrokeTextOptions): StrokeTextInk {
  const { text, x, y, height, maxWidth, random, mark, faint = false } = options;
  const upper = text.toUpperCase();

  // Unit size: from the requested height, shrunk if the line would overrun.
  const natural = height / GRID_HEIGHT;
  const needed = upper.length * ADVANCE * natural;
  const unit = needed > maxWidth ? natural * (maxWidth / needed) : natural;

  // A consistent rightward slant per writing act, as one hand produces.
  const slant = 0.04 + random() * 0.08;
  const alpha = faint ? 0.72 : 1;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let cursor = x;

  for (const char of upper) {
    const glyph = GLYPHS[char];
    // The baseline wanders letter by letter — one of the three properties that
    // make handwriting hard, kept from the scrawl this font replaced.
    const drift = (random() - 0.5) * unit * 1.6;

    if (glyph) {
      for (const stroke of glyph) {
        for (let i = 0; i < stroke.length - 1; i += 1) {
          const from = jitter(stroke[i], random);
          const to = jitter(stroke[i + 1], random);
          // Walk the segment in sub-pixel steps so strokes stay continuous —
          // a dashed stroke fragments into speckle-sized components, which is
          // the fixture defect the signature flourish was once bitten by.
          const fx = cursor + (from[0] + (GRID_HEIGHT - from[1]) * slant) * unit;
          const fy = y + drift + from[1] * unit;
          const tx = cursor + (to[0] + (GRID_HEIGHT - to[1]) * slant) * unit;
          const ty = y + drift + to[1] * unit;
          const length = Math.hypot(tx - fx, ty - fy);
          const steps = Math.max(2, Math.ceil(length / 0.4));
          for (let s = 0; s <= steps; s += 1) {
            const t = s / steps;
            const px = fx + (tx - fx) * t;
            const py = fy + (ty - fy) * t;
            // Pressure varies along the stroke: 1..3 px, the variation print
            // does not have and the stroke-width statistic keys on.
            const thickness = 1 + Math.round(Math.abs(Math.sin((px + py) * 0.35)) + random() * 0.8);
            mark(px, py, thickness, alpha);
            minX = Math.min(minX, px);
            maxX = Math.max(maxX, px + thickness);
            minY = Math.min(minY, py);
            maxY = Math.max(maxY, py + thickness);
          }
        }
      }
    }

    cursor += ADVANCE * unit * (0.92 + random() * 0.16);
  }

  if (minX > maxX) {
    // Nothing inked (all-unknown text). An empty box at the pen-down point.
    return { x: Math.round(x), y: Math.round(y), width: 0, height: 0 };
  }
  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

function jitter(point: Point, random: () => number): Point {
  return [point[0] + (random() - 0.5) * 0.5, point[1] + (random() - 0.5) * 0.5];
}
