/**
 * Photometric normalisation: turns a captured scan into the channel bundle
 * every region detector reads.
 *
 * Built once per scan and passed around, because several of these are
 * expensive and all of them are needed by more than one detector. Computing
 * them per detector would trebled the cost of the most expensive stage for no
 * benefit.
 *
 * THE FLAT/TONE SPLIT is the subtle part, and getting it wrong quietly breaks
 * photograph detection.
 *
 * Illumination flattening divides out a locally-estimated background so that
 * paper reads the same tone in a shadowed corner and under a lamp. That is
 * exactly right for finding ink — and exactly wrong for judging whether a
 * region is a photograph. A photograph is a large, dark, textured rectangle;
 * flatten with a kernel smaller than the photo and the estimator treats the
 * photo's own body as "local background" and divides it away, leaving a washed
 * region whose tone spread and variance no longer resemble a photograph at all.
 * The detector then rejects the very thing it was looking for.
 *
 * So there are two lightness images and they are not interchangeable:
 *
 *   FLAT  aggressively flattened. For ink, strokes, components, binarisation.
 *   TONE  gently flattened with a kernel much LARGER than any image field, so
 *         a photograph survives as a photograph. For tone, variance, chroma and
 *         every content feature.
 */

import { highFrequencyEnergy, labToImages, saturatedFraction, type LabImages } from "../vision/colour.ts";
import { binarizeDocument, maskSubtract } from "../vision/threshold.ts";
import { connectedComponents } from "../vision/components.ts";
import { extractRules, removeRules } from "../vision/morphology.ts";
import { estimateIllumination } from "../vision/threshold.ts";
import { createGray, type Gray, type Mask, type Rect, type Rgb } from "../vision/types.ts";
import { paperStatistics, type PaperStatistics } from "./paper-stats.ts";
import { REGION_PARAMS } from "../regions/params.ts";

export interface ScanChannels {
  /** Lab of the TONE image — gently flattened, photographs preserved. */
  readonly lab: LabImages;
  /** Aggressively flattened lightness. Ink analysis only. */
  readonly flat: Gray;
  /** High-frequency texture energy. Sees a white photo on white paper. */
  readonly texture: Gray;
  /** Ink mask: writing and print, with long printed rules removed. */
  readonly ink: Mask;
  /** Ink mask including the printed rules — needed to locate placeholder boxes. */
  readonly inkWithRules: Mask;
  /** Just the long printed rules and box borders. Registration anchors. */
  readonly rules: Mask;
  readonly paper: PaperStatistics;
  readonly saturatedFraction: number;
  readonly pxPerMM: number;
}

export interface PrepareOptions {
  /** Working-image pixels per millimetre of paper. */
  readonly pxPerMM: number;
  /**
   * Declared image regions — photo, signature and thumb boxes. Excluded from
   * paper sampling, and used to size the TONE flattening kernel so it cannot
   * eat the largest of them.
   */
  readonly imageRegions?: readonly Rect[];
}

export function prepareChannels(rgb: Rgb, options: PrepareOptions): ScanChannels {
  const { pxPerMM, imageRegions = [] } = options;

  // --- TONE: gentle flattening that preserves large dark regions ------------
  //
  // The kernel must be comfortably larger than the biggest image field, or the
  // flattener treats a photograph's own body as background. 1.5x the largest
  // declared region, floored so a template with no image fields still gets a
  // sane value.
  const largestRegion = imageRegions.reduce((max, r) => Math.max(max, r.width, r.height), 0);
  const toneGrid = Math.max(48, Math.round(Math.min(rgb.width, rgb.height) / Math.max(3, (largestRegion * 1.5) / 32)));
  const toneRgb = flattenRgb(rgb, toneGrid);
  const lab = labToImages(toneRgb);

  // --- FLAT: aggressive flattening for ink ---------------------------------
  const { ink: rawInk, flattened: flat } = binarizeDocument(lab.L, {
    windowFraction: REGION_PARAMS.ink.sauvolaWindowFraction,
    k: REGION_PARAMS.ink.sauvolaK,
    meanOffset: REGION_PARAMS.ink.adaptiveMeanOffset,
    grid: REGION_PARAMS.ink.illuminationGrid,
  });

  // --- Rules -----------------------------------------------------------------
  const ruleLengthPx = Math.max(20, Math.round(REGION_PARAMS.ink.ruleMinLengthMM * pxPerMM));
  const ruleThicknessPx = Math.max(1, Math.round(REGION_PARAMS.ink.ruleThicknessMM * pxPerMM));
  const rules = extractRules(rawInk, ruleLengthPx, ruleThicknessPx);
  const withoutRules = removeRules(rawInk, ruleLengthPx, ruleThicknessPx);

  // Speckle removal, sized in physical units so it behaves the same at every
  // capture resolution.
  const minAreaPx = Math.max(2, Math.round(REGION_PARAMS.ink.minComponentAreaMM2 * pxPerMM * pxPerMM));
  const labelled = connectedComponents(withoutRules, minAreaPx);
  const ink = createMaskFromLabels(labelled.labels, rawInk.width, rawInk.height);

  const texture = highFrequencyEnergy(lab.L);
  const saturated = saturatedFraction(lab.chroma);

  const paper = paperStatistics(lab.L, lab.chroma, texture, rawInk, {
    tileSize: Math.max(8, Math.round(1.8 * pxPerMM)),
    exclude: imageRegions,
  });

  return {
    lab,
    flat,
    texture,
    ink,
    inkWithRules: rawInk,
    rules,
    paper,
    saturatedFraction: saturated,
    pxPerMM,
  };
}

/**
 * Differential ink: what this scan has that the blank form cannot explain.
 *
 * The single highest-leverage operation in the whole pipeline when a blank
 * template is available. Everything printed — rules, boxes, labels, the
 * hospital's logo — vanishes, and what remains is exactly what a human added.
 * Signature detection stops being "find handwriting among printed text" and
 * becomes "measure the only ink present", which is a categorically easier
 * problem.
 *
 * COMPONENT-WISE, NOT PIXEL-WISE. The obvious implementation subtracts a
 * dilated template mask from the scan mask pixel by pixel. That destroys the
 * common case: a signature written ALONG its printed rule shares pixels with
 * the rule, so pixel-wise subtraction cuts the signature into disconnected
 * fragments exactly where it crosses. Instead, subtract to find which
 * components are NEW, then keep those components whole — including the pixels
 * they share with the printed layer.
 *
 * @param tolerancePx Dilation applied to the template before comparison —
 *   registration residue plus any stroke thickening from photocopying. Measured
 *   per scan by the caller; there is no safe constant.
 */
export function differentialInk(scanInk: Mask, templateInk: Mask, tolerancePx: number): Mask {
  if (scanInk.width !== templateInk.width || scanInk.height !== templateInk.height) {
    throw new Error(
      `differentialInk: size mismatch ${scanInk.width}x${scanInk.height} vs ${templateInk.width}x${templateInk.height}`,
    );
  }

  const radius = Math.max(1, Math.round(tolerancePx));
  const dilatedTemplate = dilateMask(templateInk, radius);
  const residual = maskSubtract(scanInk, dilatedTemplate);

  // Which components of the SCAN contain residual pixels? Those are the ones a
  // human contributed. Keeping them whole is the point.
  const scanComponents = connectedComponents(scanInk, 1);
  const componentHasResidual = new Uint8Array(scanComponents.components.length + 1);
  for (let i = 0; i < residual.data.length; i += 1) {
    if (residual.data[i] === 0) continue;
    const label = scanComponents.labels[i]!;
    if (label !== 0) componentHasResidual[label] = 1;
  }

  // A component that merely touches the printed layer is not automatically new;
  // require enough residual to be a real addition rather than registration
  // slop along a rule's edge.
  const residualArea = new Uint32Array(scanComponents.components.length + 1);
  for (let i = 0; i < residual.data.length; i += 1) {
    if (residual.data[i] === 0) continue;
    const label = scanComponents.labels[i]!;
    if (label !== 0) residualArea[label] += 1;
  }

  const keep = new Uint8Array(scanComponents.components.length + 1);
  for (const component of scanComponents.components) {
    if (componentHasResidual[component.label] !== 1) continue;
    // At least a fifth of the component must be unexplained by the template.
    // Below that it is a printed element whose edge moved by a pixel.
    if (residualArea[component.label]! >= component.area * 0.2) keep[component.label] = 1;
  }

  const out = createMaskLike(scanInk);
  for (let i = 0; i < out.data.length; i += 1) {
    const label = scanComponents.labels[i]!;
    if (label !== 0 && keep[label] === 1) out.data[i] = 255;
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Flattens each colour channel by its own illumination field, preserving hue. */
function flattenRgb(image: Rgb, grid: number): Rgb {
  const out = new Uint8ClampedArray(image.data.length);
  const size = image.width * image.height;

  for (let channel = 0; channel < 3; channel += 1) {
    const plane = createGray(image.width, image.height);
    for (let i = 0, p = channel; i < size; i += 1, p += image.channels) plane.data[i] = image.data[p]!;
    const field = estimateIllumination(plane, grid);
    for (let i = 0, p = channel; i < size; i += 1, p += image.channels) {
      const base = field.data[i]!;
      // A genuinely dark estimate means the region IS dark — a photograph, a
      // heavy stamp — not shadowed paper. Dividing there would amplify noise
      // into a blizzard and destroy the region we care about.
      out[p] = base < 24 ? image.data[p]! : Math.min(255, (image.data[p]! * 224) / base);
    }
  }

  if (image.channels === 4) {
    for (let i = 0, p = 3; i < size; i += 1, p += 4) out[p] = image.data[p]!;
  }
  return { data: out, width: image.width, height: image.height, channels: image.channels };
}

function createMaskFromLabels(labels: Int32Array, width: number, height: number): Mask {
  const data = new Uint8ClampedArray(width * height);
  for (let i = 0; i < data.length; i += 1) if (labels[i] !== 0) data[i] = 255;
  return { data, width, height };
}

function createMaskLike(mask: Mask): Mask {
  return { data: new Uint8ClampedArray(mask.width * mask.height), width: mask.width, height: mask.height };
}

/** Local dilate, kept here to avoid a circular import with morphology's helpers. */
function dilateMask(mask: Mask, radius: number): Mask {
  const out = createMaskLike(mask);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * mask.width + x] === 0) continue;
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(mask.height - 1, y + radius);
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(mask.width - 1, x + radius);
      for (let ny = y0; ny <= y1; ny += 1) {
        for (let nx = x0; nx <= x1; nx += 1) out.data[ny * mask.width + nx] = 255;
      }
    }
  }
  return out;
}
