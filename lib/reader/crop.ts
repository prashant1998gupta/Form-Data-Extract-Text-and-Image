/**
 * Cutting the evidence crop — the only geometry the reader ever has, and it is
 * decided here, deterministically, before any model is addressed.
 *
 * The crop is the field's declared box expanded by a fixed margin: handwriting
 * habitually overruns its rule (ascenders above, a flourish past the right
 * edge), and a crop that guillotines the tail of "Sharma" makes the model read
 * "Sharm" faithfully — a wrong value produced by our geometry, not its eyes.
 * The margin is in millimetres against the rectified page, like every other
 * geometric constant in this codebase, so it means the same thing on a phone
 * photo and a flatbed scan.
 *
 * The same crop is returned to the verify screen byte-for-byte. The operator
 * reviews exactly the pixels the model saw — showing them a different, tidier
 * crop would invite them to verify a value against evidence the model never had.
 */

import { CTS_PX_PER_MM, clipToPage, expandMM, mmToCts, type PageSizeMM, type RectMM } from "../geometry/frames.ts";
import type { Rect, Rgb } from "../vision/types.ts";

/** Margin around the declared box. 2.5 mm covers ascenders and modest overruns. */
const EVIDENCE_PAD_MM = 2.5;

/**
 * Where a field's evidence crop is taken from, in integer rectified-page
 * pixels, clamped to the page and never empty.
 */
export function evidenceRect(box: RectMM, page: PageSizeMM): Rect {
  const padded = clipToPage(expandMM(box, EVIDENCE_PAD_MM, 0), page);
  const px = mmToCts(padded);

  const pageW = Math.round(page.widthMM * CTS_PX_PER_MM);
  const pageH = Math.round(page.heightMM * CTS_PX_PER_MM);

  // Round to integers, then clamp again in pixel space: mmToCts of a clipped
  // rect can still land a fraction outside the raster after rounding.
  const x = Math.min(Math.max(Math.round(px.x), 0), pageW - 1);
  const y = Math.min(Math.max(Math.round(px.y), 0), pageH - 1);
  const width = Math.max(1, Math.min(Math.round(px.width), pageW - x));
  const height = Math.max(1, Math.min(Math.round(px.height), pageH - y));

  return { x, y, width, height };
}

/**
 * Copies a rectangle out of an RGB(A) raster.
 *
 * The rect is trusted to be integral and in-bounds because `evidenceRect`
 * produced it — but the row copy still clamps, because "trusted" is how a NaN
 * skipped a safety gate here once before.
 */
export function cropRgb(image: Rgb, rect: Rect): Rgb {
  const channels = image.channels;
  const x = Math.min(Math.max(rect.x, 0), Math.max(image.width - 1, 0));
  const y = Math.min(Math.max(rect.y, 0), Math.max(image.height - 1, 0));
  const width = Math.max(1, Math.min(rect.width, image.width - x));
  const height = Math.max(1, Math.min(rect.height, image.height - y));

  const out = new Uint8ClampedArray(width * height * channels);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * channels;
    out.set(image.data.subarray(from, from + width * channels), row * width * channels);
  }
  return { data: out, width, height, channels };
}
