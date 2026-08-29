/**
 * One image for one scan — the composite the rate-limited path reads.
 *
 * WHY THIS EXISTS. Groq prices every image at a flat ~2,048 input tokens, so
 * eight per-field requests cost ~17k tokens per scan — more than its free
 * tier allows PER MINUTE. A scan on that tier could never finish, however it
 * was paced; the only lever that changes the arithmetic is sending fewer
 * images. So all the field crops are stacked into ONE image and read in one
 * request: ~2.5k tokens, and a whole scan fits where eight requests did not.
 *
 * WHAT IT COSTS, STATED RATHER THAN HIDDEN. Per-field requests make the
 * value→field mapping structural — request N is field N, and the model cannot
 * misattribute. A composite asks the model to keep N strips straight, which
 * reintroduces exactly that risk. Three mitigations, none of them a model's
 * opinion: each strip carries its number PRINTED IN THE IMAGE (drawn here,
 * by us, from a bitmap font — never model-located); strips are separated by
 * solid black bars a reader cannot miss; and a reply that skips or invents a
 * strip number fails that field in words rather than shifting its neighbours
 * (`parse.ts` maps by number, never by position in the reply). And every
 * value still lands in front of a human beside its own crop.
 *
 * The per-field mode remains the default wherever the provider's limits
 * allow it (`read-text-fields.ts` chooses); this is the honest trade for the
 * providers where the alternative is not reading at all.
 */

import type { Rgb } from "../vision/types.ts";

/** 5x7 bitmap digits, scaled up for the margin numerals. */
const DIGITS: Readonly<Record<string, readonly string[]>> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["01110", "10001", "00001", "00110", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

const DIGIT_SCALE = 5;
const DIGIT_WIDTH = 5 * DIGIT_SCALE;
const DIGIT_HEIGHT = 7 * DIGIT_SCALE;
/** Room for two digits plus breathing space — 40 fields is the template cap. */
const GUTTER_WIDTH = 2 * DIGIT_WIDTH + 24;
/** The bar between strips. Thick enough to survive JPEG at reading resolution. */
const SEPARATOR_PX = 10;

/**
 * Stacks the field crops into one numbered image.
 *
 * Strip k (1-based, top to bottom) is the k-th crop, with its number drawn in
 * the left gutter. The mapping the reader is asked to honour is therefore
 * printed into the very pixels it reads.
 */
export function buildComposite(crops: readonly Rgb[]): Rgb {
  const width = GUTTER_WIDTH + Math.max(...crops.map((crop) => crop.width));
  const height =
    crops.reduce((sum, crop) => sum + Math.max(crop.height, DIGIT_HEIGHT + 8), 0) +
    SEPARATOR_PX * (crops.length - 1);

  // White canvas; strips and numerals are drawn over it.
  const data = new Uint8ClampedArray(width * height * 3).fill(255);
  const canvas: Rgb = { data, width, height, channels: 3 };

  let y = 0;
  crops.forEach((crop, index) => {
    const stripHeight = Math.max(crop.height, DIGIT_HEIGHT + 8);
    drawNumber(canvas, index + 1, y + Math.round((stripHeight - DIGIT_HEIGHT) / 2));
    blit(canvas, crop, GUTTER_WIDTH, y + Math.round((stripHeight - crop.height) / 2));
    y += stripHeight;
    if (index < crops.length - 1) {
      fillRect(canvas, 0, y, width, SEPARATOR_PX, 0);
      y += SEPARATOR_PX;
    }
  });

  return canvas;
}

function blit(canvas: Rgb, source: Rgb, x: number, y: number): void {
  const channels = source.channels;
  for (let row = 0; row < source.height; row += 1) {
    const ty = y + row;
    if (ty < 0 || ty >= canvas.height) continue;
    for (let col = 0; col < source.width; col += 1) {
      const tx = x + col;
      if (tx < 0 || tx >= canvas.width) continue;
      const from = (row * source.width + col) * channels;
      const to = (ty * canvas.width + tx) * 3;
      canvas.data[to] = source.data[from]!;
      canvas.data[to + 1] = source.data[from + 1]!;
      canvas.data[to + 2] = source.data[from + 2]!;
    }
  }
}

function drawNumber(canvas: Rgb, value: number, y: number): void {
  const text = String(value);
  let x = Math.round((GUTTER_WIDTH - text.length * (DIGIT_WIDTH + 4)) / 2);
  for (const char of text) {
    const rows = DIGITS[char];
    if (rows) {
      for (let row = 0; row < rows.length; row += 1) {
        for (let col = 0; col < rows[row].length; col += 1) {
          if (rows[row][col] === "1") {
            fillRect(canvas, x + col * DIGIT_SCALE, y + row * DIGIT_SCALE, DIGIT_SCALE, DIGIT_SCALE, 20);
          }
        }
      }
    }
    x += DIGIT_WIDTH + 4;
  }
}

function fillRect(canvas: Rgb, x: number, y: number, width: number, height: number, tone: number): void {
  const x1 = Math.min(canvas.width, x + width);
  const y1 = Math.min(canvas.height, y + height);
  for (let py = Math.max(0, y); py < y1; py += 1) {
    for (let px = Math.max(0, x); px < x1; px += 1) {
      const i = (py * canvas.width + px) * 3;
      canvas.data[i] = tone;
      canvas.data[i + 1] = tone;
      canvas.data[i + 2] = tone;
    }
  }
}
