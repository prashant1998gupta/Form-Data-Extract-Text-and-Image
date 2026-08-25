/**
 * Printed-label removal for the cold-start path.
 *
 * When a blank template exists, differential ink removes every printed mark
 * before any detector runs, and this module is unnecessary. On the FIRST scan
 * of a brand-new form there is no template, and the printed furniture is still
 * there — which breaks signature detection in a specific and non-obvious way.
 *
 * A signature's flourish routinely crosses its rule and runs into the printed
 * caption underneath ("Signature", "Patient's Signature", "Signature / Thumb
 * Impression"). Complete-link clustering then has a choice: attach the tail to
 * the signature, or attach it to the caption. It attaches to whichever is
 * nearer, and the caption usually is. The tail leaves with the caption, and the
 * signature crop loses its last third — measured at 73 % containment on the
 * reference fixture, silently, with a confident detection and a plausible box.
 *
 * So small printed captions are identified and removed first. The test is
 * structural rather than semantic: a run of glyph-sized components sharing a
 * baseline at a regular pitch is a line of set type, whatever it says.
 *
 * DELIBERATELY CONSERVATIVE. Only genuinely small glyphs qualify — 2.5 mm and
 * under, which is caption type. A person hand-printing their name in a
 * signature box writes far larger than that, and must NOT be removed here: it
 * needs to reach the detector and be REPORTED as printed text, so the operator
 * learns the box was filled in wrongly. Silently deleting it would produce
 * "Not Detected" on a box that visibly has writing in it, which is the kind of
 * answer that destroys trust in the whole screen.
 */

import type { Component } from "../vision/components.ts";

export interface TextLineOptions {
  readonly pxPerMM: number;
  /** Largest glyph height to consider caption type. */
  readonly maxGlyphHeightMM?: number;
  /** Largest glyph width. Wider marks are strokes, not letters. */
  readonly maxGlyphWidthMM?: number;
  /** How many aligned glyphs make a line. */
  readonly minGlyphs?: number;
  /** Baseline alignment tolerance. */
  readonly baselineToleranceMM?: number;
  /** Largest gap between consecutive glyphs on one line. */
  readonly maxGapMM?: number;
  /** A line must span at least this much to be type rather than a coincidence. */
  readonly minSpanMM?: number;
}

/**
 * Labels of components that belong to a line of small printed type.
 *
 * Returns a set rather than a filtered mask so the caller can decide what to do
 * with them — the signature detector drops them, while a template builder might
 * want to keep them as registration anchors.
 */
export function printedCaptionLabels(components: readonly Component[], options: TextLineOptions): Set<number> {
  const {
    pxPerMM,
    maxGlyphHeightMM = 2.5,
    maxGlyphWidthMM = 4,
    minGlyphs = 5,
    baselineToleranceMM = 1,
    maxGapMM = 3,
    minSpanMM = 10,
  } = options;

  const maxHeight = maxGlyphHeightMM * pxPerMM;
  const maxWidth = maxGlyphWidthMM * pxPerMM;
  const tolerance = baselineToleranceMM * pxPerMM;
  const maxGap = maxGapMM * pxPerMM;
  const minSpan = minSpanMM * pxPerMM;

  const glyphs = components.filter((c) => c.bounds.height <= maxHeight && c.bounds.width <= maxWidth);
  if (glyphs.length < minGlyphs) return new Set();

  // Group by baseline — the BOTTOM edge, not the centre. Set type aligns on its
  // baseline; letters with descenders and ascenders have quite different
  // centres and heights but share a bottom to within a fraction of a millimetre.
  const byBaseline = new Map<number, Component[]>();
  for (const glyph of glyphs) {
    const baseline = glyph.bounds.y + glyph.bounds.height;
    let bucket: Component[] | undefined;
    for (const [key, value] of byBaseline) {
      if (Math.abs(key - baseline) <= tolerance) {
        bucket = value;
        break;
      }
    }
    if (bucket) bucket.push(glyph);
    else byBaseline.set(baseline, [glyph]);
  }

  const removed = new Set<number>();

  for (const bucket of byBaseline.values()) {
    if (bucket.length < minGlyphs) continue;

    const ordered = [...bucket].sort((a, b) => a.bounds.x - b.bounds.x);
    const span = ordered[ordered.length - 1]!.bounds.x + ordered[ordered.length - 1]!.bounds.width - ordered[0]!.bounds.x;
    if (span < minSpan) continue;

    // Walk the row and keep only runs of consecutive glyphs at a plausible
    // pitch. A whole bucket is rarely one caption — the same baseline may carry
    // a caption on the left and part of a signature on the right — so runs are
    // extracted rather than the bucket being accepted or rejected whole.
    let run: Component[] = [ordered[0]!];
    const flush = () => {
      if (run.length < minGlyphs) return;
      const runSpan = run[run.length - 1]!.bounds.x + run[run.length - 1]!.bounds.width - run[0]!.bounds.x;
      if (runSpan < minSpan) return;
      // Uniform glyph height is the last confirmation that this is set type
      // rather than a coincidental row of marks.
      const heights = run.map((c) => c.bounds.height);
      const mean = heights.reduce((sum, h) => sum + h, 0) / heights.length;
      const deviation = Math.sqrt(heights.reduce((sum, h) => sum + (h - mean) ** 2, 0) / heights.length);
      if (mean > 0 && deviation / mean > 0.45) return;
      for (const glyph of run) removed.add(glyph.label);
    };

    for (let i = 1; i < ordered.length; i += 1) {
      const previous = run[run.length - 1]!;
      const gap = ordered[i]!.bounds.x - (previous.bounds.x + previous.bounds.width);
      if (gap <= maxGap) {
        run.push(ordered[i]!);
      } else {
        flush();
        run = [ordered[i]!];
      }
    }
    flush();
  }

  return removed;
}
