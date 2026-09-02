/**
 * A deterministic synthetic hospital form renderer.
 *
 * Real filled-in patient forms are personal medical data. We cannot put them in
 * a repository, and a test suite that needs them is a test suite nobody runs.
 * So the fixtures are generated: a printed form skeleton, handwriting, a pasted
 * photograph, a signature and a thumb impression, plus the capture defects that
 * break detectors — perspective, skew, shadow gradients, glare, photocopy
 * speckle and JPEG-ish noise.
 *
 * The generator returns GROUND TRUTH boxes alongside the image, so a detector
 * test can assert IoU against a known answer instead of eyeballing output.
 *
 * This is not a claim that synthetic forms are as good as real ones. They are
 * not — real handwriting is messier, real photographs are stapled at an angle,
 * and real photocopies degrade in ways this does not model. What they do give
 * is a fast, deterministic regression net: if a change breaks the clean case or
 * the shadowed case, that is caught in milliseconds, and the remaining risk is
 * concentrated in a small set of real fixtures a human has to supply.
 *
 * Everything is seeded. The same seed always produces byte-identical output, so
 * a failing test is reproducible.
 */

import { rgbFrom, type Rect, type Rgb } from "../../lib/vision/types.ts";
import { strokeText } from "./stroke-font.ts";

/** xorshift32. Deterministic, fast, and good enough to look like paper. */
export function makeRandom(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

export interface SyntheticFormOptions {
  readonly width?: number;
  readonly height?: number;
  readonly seed?: number;
  readonly withPhoto?: boolean;
  readonly withSignature?: boolean;
  readonly withThumb?: boolean;
  /** Greyscale photo instead of colour — a photocopied form, where saturation cues vanish. */
  readonly monochromePhoto?: boolean;
  /** Rotate the pasted photo, as a hand-glued one always is. Degrees. */
  readonly photoRotation?: number;
  /**
   * Size of the pasted photo relative to a 35x45 mm passport print.
   *
   * Real forms are not all passport forms. Hospital and school forms
   * routinely carry a 50-60 mm print, and a template taught by DRAWING never
   * states a size at all — the person just drags a box round whatever is
   * there. So the generator has to be able to produce a photo that is
   * plainly a photo and plainly not 35x45.
   */
  readonly photoScale?: number;
  /**
   * The studio backdrop the portrait was shot against.
   *
   * `studio` is the mid-grey the generator has always drawn: a ~75-level step
   * against paper, which every channel sees easily. `pale` is the photograph
   * `regions/photo.ts` opens by naming as the single most common real input —
   * a person on a near-white backdrop, printed on white photo paper, pasted
   * onto white form paper. Its boundary is a handful of grey levels, and on a
   * real print the backdrop is lightest at the bottom corners, so the bottom
   * and one side are the edges that vanish first.
   */
  readonly photoBackdrop?: "studio" | "pale";
  /** Illumination gradient strength, 0..1. */
  readonly shadow?: number;
  /** A blown-out specular hotspot. */
  readonly glare?: boolean;
  /** Grey background and speckle, as a photocopy. */
  readonly photocopy?: boolean;
  /** Sensor noise amplitude, 0..1. */
  readonly noise?: number;
  /** Page rotation in degrees, applied last. */
  readonly skew?: number;
  /**
   * Whether the field rows carry handwritten values. False renders a truly
   * BLANK form — printed labels and rules, nothing written — which is what an
   * organization photographs when teaching the app its form, and what the
   * "unfilled" sample must be for that instruction to be honest.
   */
  readonly withHandwriting?: boolean;
  /** Margin of dark "desk" around the page, in pixels. 0 means the page fills the frame. */
  readonly desk?: number;
}

export interface SyntheticForm {
  readonly rgb: Rgb;
  readonly truth: {
    readonly page: Rect;
    readonly photo: Rect | null;
    readonly signature: Rect | null;
    readonly thumb: Rect | null;
    /** The handwritten field values, in reading order: what was written, and where its ink landed. */
    readonly fields: readonly { readonly label: string; readonly value: string; readonly box: Rect }[];
  };
}

/**
 * What the synthetic patient wrote, field by field.
 *
 * These are GROUND TRUTH for the handwriting reader: fixed rather than
 * randomised so a reader test (or a person running the demo with a key) can
 * check a transcription against a known answer. The blood group is deliberately
 * `B+` — one stroke from `B-`, the exact pair the review rules exist for.
 */
export const FIELD_VALUES: Readonly<Record<string, string>> = {
  "Patient Name": "ANITA SHARMA",
  Age: "34",
  "Blood Group": "B+",
  "Mobile Number": "98765 43210",
  "Email ID": "ANITA@MAIL.COM",
  Date: "12/08/2026",
  "Disease / Complaint": "FEVER",
  "Doctor Assigned": "DR MEHTA",
};

interface Canvas {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export function renderSyntheticForm(options: SyntheticFormOptions = {}): SyntheticForm {
  const {
    width = 1240,
    height = 1754, // A4 at 150 DPI
    seed = 12345,
    withPhoto = true,
    withSignature = true,
    withThumb = true,
    monochromePhoto = false,
    photoRotation = 0,
    photoScale = 1,
    photoBackdrop = "studio",
    shadow = 0,
    glare = false,
    photocopy = false,
    withHandwriting = true,
    noise = 0.02,
    skew = 0,
    desk = 0,
  } = options;

  const random = makeRandom(seed);
  const canvas: Canvas = {
    data: new Uint8ClampedArray(width * height * 3),
    width,
    height,
  };

  // Desk background, then the page on top of it.
  const deskTone = 74;
  fill(canvas, 0, 0, width, height, [deskTone, deskTone - 6, deskTone - 12]);

  const page: Rect = { x: desk, y: desk, width: width - desk * 2, height: height - desk * 2 };
  const paperTone = photocopy ? 226 : 249;
  fill(canvas, page.x, page.y, page.width, page.height, [paperTone, paperTone, photocopy ? paperTone - 4 : paperTone - 3]);

  const margin = Math.round(page.width * 0.07);
  const left = page.x + margin;
  const right = page.x + page.width - margin;
  const ink: RGB = [28, 30, 36];

  // ---- printed header ----
  let y = page.y + Math.round(page.height * 0.045);
  fill(canvas, left, y, right - left, 3, ink);
  y += 16;
  printedText(canvas, left, y, Math.round((right - left) * 0.46), 17, ink, random);
  y += 30;
  printedText(canvas, left, y, Math.round((right - left) * 0.3), 11, [95, 98, 104], random);
  y += 26;
  fill(canvas, left, y, right - left, 2, [150, 152, 158]);
  y += 28;

  // ---- the pasted photograph box, top right ----
  // 35x45mm at 150 DPI is 207x266 px; scale with the page so the generator
  // works at any resolution.
  const photoWidth = Math.round(page.width * 0.167 * photoScale);
  const photoHeight = Math.round(photoWidth * (45 / 35));
  const photoBox: Rect = { x: right - photoWidth, y, width: photoWidth, height: photoHeight };

  // The printed placeholder rectangle is always drawn — it is on the blank form
  // whether or not anyone glued a photo into it. A detector that finds the empty
  // box and calls it a photograph is exactly the failure "Not Detected" exists
  // to prevent, so this case must be representable.
  strokeRect(canvas, photoBox, [140, 143, 150], 2);
  if (!withPhoto) {
    printedText(canvas, photoBox.x + 14, photoBox.y + Math.round(photoHeight / 2) - 5, photoWidth - 28, 9, [150, 152, 158], random);
  }

  let photoTruth: Rect | null = null;
  if (withPhoto) {
    // Hand-glued photos sit slightly proud of the printed box and are never
    // perfectly square to it.
    const inset = -3;
    const placed: Rect = {
      x: photoBox.x + inset,
      y: photoBox.y + inset,
      width: photoBox.width - inset * 2,
      height: photoBox.height - inset * 2,
    };
    drawPortrait(canvas, placed, random, monochromePhoto, photoRotation, photoBackdrop);
    photoTruth = placed;
  }

  // ---- printed field rows with handwritten values ----
  const fieldLabels = [
    "Patient Name",
    "Age",
    "Blood Group",
    "Mobile Number",
    "Email ID",
    "Date",
    "Disease / Complaint",
    "Doctor Assigned",
  ];
  const fields: { label: string; value: string; box: Rect }[] = [];
  // Always short of the photo box, because the printed box is always drawn —
  // `withPhoto` controls whether a photograph is PASTED into it, not whether
  // the form has one. An unfilled form still has the rectangle printed on it,
  // and its field rows still stop before it.
  const fieldRight = photoBox.x - 24;

  // THE ROWS ARE ANCHORED TO THE SEED TEMPLATE'S MILLIMETRES, not flowed from
  // the header. The template declares each answer box at 47 + 11k mm, 8 mm
  // tall, values from 55 mm — and for a long time this generator flowed its
  // rows one row higher, which nothing noticed while the handwriting was
  // unreadable scrawl: the "Patient Name" crop faithfully contained the AGE
  // row's ink, and no detector cared. A reader does. The fixture and the
  // template now agree by construction, and a regression test measures it.
  const mmX = page.width / 210;
  const mmY = page.height / 297;
  const ROW0_MM = 47;
  const ROW_PITCH_MM = 11;
  const BOX_HEIGHT_MM = 8;

  for (let index = 0; index < fieldLabels.length; index += 1) {
    const label = fieldLabels[index];
    const boxTop = page.y + (ROW0_MM + ROW_PITCH_MM * index) * mmY;
    const boxBottom = boxTop + BOX_HEIGHT_MM * mmY;
    // Once past the photo box, rows may use the full width.
    const rowEnd = boxTop > photoBox.y + photoBox.height + 6 ? right : fieldRight;

    // The label sits on the same baseline as the value it introduces, as it
    // does on a real form, and ends before the 55 mm line the values start at.
    const labelWidth = Math.round(page.x + 52 * mmX - left);
    printedText(canvas, left, Math.round(boxBottom - 20), labelWidth, 11, [70, 72, 80], random);

    const valueStart = Math.round(page.x + 55 * mmX);
    // The printed rule the value is written on, near the answer box's foot.
    fill(canvas, valueStart, Math.round(boxBottom - 2 * mmY), rowEnd - valueStart, 2, [168, 170, 176]);

    // Handwriting: sits ON the rule, overhangs it, and wanders vertically —
    // all three are what make real forms hard. It is LEGIBLE now (see
    // stroke-font.ts for why the statistical scrawl had to go), and what it
    // says is returned as ground truth beside where it landed.
    const value = withHandwriting ? (FIELD_VALUES[label] ?? "") : "";
    const box = handwrittenValue(
      canvas,
      value,
      Math.round(page.x + 56 * mmX),
      Math.round(boxTop + 0.5 * mmY),
      rowEnd - valueStart - Math.round(2 * mmX),
      Math.round(6 * mmY),
      random,
      photocopy,
    );
    fields.push({ label, value, box });
  }

  y = Math.round(page.y + (ROW0_MM + ROW_PITCH_MM * (fieldLabels.length - 1) + BOX_HEIGHT_MM) * mmY) + 24;

  // ---- signature and thumb impression, side by side at the foot ----
  const footY = Math.max(y, page.y + Math.round(page.height * 0.78));
  const halfWidth = Math.round((right - left) * 0.42);

  let signatureTruth: Rect | null = null;
  const signatureRuleY = footY + 76;
  fill(canvas, left, signatureRuleY, halfWidth, 2, [168, 170, 176]);
  printedText(canvas, left, signatureRuleY + 10, Math.round(halfWidth * 0.42), 10, [110, 112, 120], random);
  if (withSignature) {
    signatureTruth = drawSignature(canvas, left + 12, footY + 18, halfWidth - 30, 66, random, photocopy);
  }

  let thumbTruth: Rect | null = null;
  const thumbX = right - Math.round(halfWidth * 0.55);
  const thumbBox: Rect = { x: thumbX, y: footY + 8, width: Math.round(page.width * 0.1), height: Math.round(page.width * 0.13) };
  strokeRect(canvas, thumbBox, [140, 143, 150], 2);
  printedText(canvas, thumbBox.x, thumbBox.y + thumbBox.height + 10, thumbBox.width, 10, [110, 112, 120], random);
  if (withThumb) {
    thumbTruth = drawThumbprint(canvas, thumbBox, random);
  }

  // ---- capture defects, applied in physical order ----
  if (photocopy) applySpeckle(canvas, page, random, 0.006);
  if (shadow > 0) applyShadow(canvas, shadow);
  if (glare) applyGlare(canvas, page, random);
  if (noise > 0) applyNoise(canvas, noise, random);

  let output: Canvas = canvas;
  let truth = {
    page,
    photo: photoTruth,
    signature: signatureTruth,
    thumb: thumbTruth,
    fields,
  };

  if (Math.abs(skew) > 0.01) {
    output = rotateCanvas(canvas, skew, [deskTone, deskTone - 6, deskTone - 12]);
    truth = {
      page: rotateRect(page, skew, width, height),
      photo: photoTruth ? rotateRect(photoTruth, skew, width, height) : null,
      signature: signatureTruth ? rotateRect(signatureTruth, skew, width, height) : null,
      thumb: thumbTruth ? rotateRect(thumbTruth, skew, width, height) : null,
      fields: fields.map((f) => ({ label: f.label, value: f.value, box: rotateRect(f.box, skew, width, height) })),
    };
  }

  return { rgb: rgbFrom(output.data, output.width, output.height, 3), truth };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

type RGB = readonly [number, number, number];

function setPixel(canvas: Canvas, x: number, y: number, colour: RGB, alpha = 1) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const i = (y * canvas.width + x) * 3;
  if (alpha >= 1) {
    canvas.data[i] = colour[0];
    canvas.data[i + 1] = colour[1];
    canvas.data[i + 2] = colour[2];
    return;
  }
  canvas.data[i] = canvas.data[i]! * (1 - alpha) + colour[0] * alpha;
  canvas.data[i + 1] = canvas.data[i + 1]! * (1 - alpha) + colour[1] * alpha;
  canvas.data[i + 2] = canvas.data[i + 2]! * (1 - alpha) + colour[2] * alpha;
}

function fill(canvas: Canvas, x: number, y: number, width: number, height: number, colour: RGB) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width, Math.round(x + width));
  const y1 = Math.min(canvas.height, Math.round(y + height));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) setPixel(canvas, px, py, colour);
  }
}

function strokeRect(canvas: Canvas, rect: Rect, colour: RGB, thickness: number) {
  fill(canvas, rect.x, rect.y, rect.width, thickness, colour);
  fill(canvas, rect.x, rect.y + rect.height - thickness, rect.width, thickness, colour);
  fill(canvas, rect.x, rect.y, thickness, rect.height, colour);
  fill(canvas, rect.x + rect.width - thickness, rect.y, thickness, rect.height, colour);
}

/**
 * Printed type, as a row of small blocks with word gaps. Not readable, and does
 * not need to be — what the detectors measure about printed text is its
 * regularity: consistent stroke width, aligned baseline, uniform height. Those
 * properties are reproduced here; glyph shapes are not.
 */
function printedText(canvas: Canvas, x: number, y: number, width: number, size: number, colour: RGB, random: () => number) {
  const strokeWidth = Math.max(1, Math.round(size / 8));
  let cursor = x;
  const end = x + width;
  while (cursor < end) {
    const wordLength = 3 + Math.floor(random() * 6);
    for (let i = 0; i < wordLength && cursor < end; i += 1) {
      const glyphWidth = Math.round(size * 0.5);
      // Two verticals and a crossbar: enough structure for a uniform
      // stroke-width distribution, which is the property under test.
      fill(canvas, cursor, y, strokeWidth, size, colour);
      if (random() > 0.35) {
        fill(canvas, cursor + glyphWidth - strokeWidth, y, strokeWidth, size, colour);
        fill(canvas, cursor, y + Math.round(size * 0.5), glyphWidth, strokeWidth, colour);
      }
      cursor += glyphWidth + strokeWidth;
    }
    cursor += Math.round(size * 0.45);
  }
}

/**
 * A handwritten field value: legible single-stroke print in blue ballpoint.
 *
 * The properties the detectors key on survive from the scrawl this replaced —
 * stroke width varies, the baseline drifts letter by letter, and the ink sits
 * on (and overhangs) the printed rule. What changed is that it now says
 * something, so the handwriting reader has ground truth to be measured
 * against instead of fixtures that manufacture their own illegibility.
 */
function handwrittenValue(
  canvas: Canvas,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  height: number,
  random: () => number,
  faint: boolean,
): Rect {
  const colour: RGB = faint ? [96, 100, 118] : [38, 44, 96]; // blue ballpoint
  return strokeText({
    text,
    x,
    y,
    height,
    maxWidth,
    random,
    faint,
    mark: (px, py, thickness, alpha) => {
      for (let dy = 0; dy < thickness; dy += 1) {
        for (let dx = 0; dx < thickness; dx += 1) {
          setPixel(canvas, Math.round(px) + dx, Math.round(py) + dy, colour, alpha);
        }
      }
    },
  });
}

/**
 * A signature: wider, faster and more variable than ordinary handwriting, with
 * a long trailing flourish that overshoots its box. Deliberately crosses the
 * printed rule, because that is what breaks naive connected-component analysis.
 */
function drawSignature(
  canvas: Canvas,
  x: number,
  y: number,
  width: number,
  height: number,
  random: () => number,
  faint: boolean,
): Rect {
  const colour: RGB = faint ? [88, 92, 110] : [24, 28, 78];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  const mark = (px: number, py: number, thickness: number) => {
    for (let dy = 0; dy < thickness; dy += 1) {
      for (let dx = 0; dx < thickness; dx += 1) {
        setPixel(canvas, Math.round(px) + dx, Math.round(py) + dy, colour, faint ? 0.7 : 1);
      }
    }
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px + thickness);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py + thickness);
  };

  // Three overlapping loops plus a flourish — the shape of most signatures.
  const loops = 3;
  for (let loop = 0; loop < loops; loop += 1) {
    const centreX = x + (width / (loops + 1)) * (loop + 1);
    const centreY = y + height * (0.45 + (random() - 0.5) * 0.2);
    const radiusX = width / (loops + 2.2);
    const radiusY = height * (0.3 + random() * 0.18);
    const tilt = (random() - 0.5) * 0.8;
    for (let t = 0; t < Math.PI * 2.4; t += 0.02) {
      const px = centreX + Math.cos(t) * radiusX + Math.sin(t * 2.3) * 4;
      const py = centreY + Math.sin(t) * radiusY + tilt * (px - centreX) * 0.35;
      mark(px, py, 1 + Math.round(Math.abs(Math.cos(t * 1.7)) * 2));
    }
  }
  // The flourish: a long fast tail that leaves the box and crosses the rule.
  //
  // The step must keep consecutive marks OVERLAPPING. At a coarser step the
  // thin end of the tail is drawn as a dashed line rather than continuous ink,
  // which is not what a pen does, and it fragments into sub-pixel components
  // that any speckle filter correctly discards. That is a defect in the
  // fixture, not in a detector — but it presents as a detector losing the last
  // 6 mm of every flourish, which is exactly the kind of false signal a
  // synthetic corpus exists to avoid.
  const flourishLength = width * 0.85;
  const flourishStep = 0.5 / flourishLength;
  for (let t = 0; t < 1; t += flourishStep) {
    const px = x + width * 0.2 + t * flourishLength;
    const py = y + height * 0.72 + Math.sin(t * Math.PI * 1.2) * height * 0.3;
    mark(px, py, t > 0.85 ? 1 : 2);
  }

  return {
    x: Math.round(minX),
    y: Math.round(minY),
    width: Math.round(maxX - minX),
    height: Math.round(maxY - minY),
  };
}

/**
 * A thumb impression: a dense elliptical smudge carrying concentric friction
 * ridges at a realistic spacing, with the edges lighter than the centre where
 * the ink thins.
 *
 * The two properties the detector keys on are both modelled: high fill ratio
 * (the ink covers most of its bounding box, unlike a signature) and a narrow
 * ridge frequency (unlike anything else on the page).
 */
function drawThumbprint(canvas: Canvas, box: Rect, random: () => number): Rect {
  const colour: RGB = [42, 46, 74];
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;
  const radiusX = box.width * 0.36;
  const radiusY = box.height * 0.38;
  // ~0.45mm ridge spacing; at this generator's scale that is a few pixels.
  const ridgePeriod = Math.max(3, Math.round(box.width / 22));

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let y = Math.round(centreY - radiusY); y <= centreY + radiusY; y += 1) {
    for (let x = Math.round(centreX - radiusX); x <= centreX + radiusX; x += 1) {
      const nx = (x - centreX) / radiusX;
      const ny = (y - centreY) / radiusY;
      const r = Math.hypot(nx, ny);
      if (r > 1) continue;
      // Concentric ridges, slightly warped so they are not perfect circles.
      const distance = Math.hypot((x - centreX) * 1.1, (y - centreY)) + Math.sin(nx * 4) * 2;
      const ridge = Math.sin((distance / ridgePeriod) * Math.PI * 2);
      if (ridge < 0.05) continue;
      // Ink thins toward the edge of the contact patch.
      const alpha = Math.min(1, (1 - r) * 2.2) * (0.55 + ridge * 0.45) * (0.85 + random() * 0.15);
      if (alpha <= 0.05) continue;
      setPixel(canvas, x, y, colour, alpha);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * A passport photograph: a portrait-like image with a plain studio background,
 * a head-and-shoulders silhouette in skin tones, and photographic texture
 * throughout.
 *
 * The properties under test: sustained local variance across the whole
 * rectangle (no blank paper anywhere inside it), colour saturation, and four
 * hard cut edges. `monochrome` strips the saturation to model a photocopied
 * form, which is the case where colour-based detection has to fail over to
 * variance and edge cues.
 */
function drawPortrait(
  canvas: Canvas,
  rect: Rect,
  random: () => number,
  monochrome: boolean,
  rotationDegrees: number,
  backdrop: "studio" | "pale" = "studio",
) {
  const radians = (rotationDegrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const centreX = rect.x + rect.width / 2;
  const centreY = rect.y + rect.height / 2;

  const desaturate = (colour: RGB): RGB => {
    if (!monochrome) return colour;
    const luma = Math.round(colour[0] * 0.299 + colour[1] * 0.587 + colour[2] * 0.114);
    return [luma, luma, luma];
  };

  for (let y = Math.floor(rect.y - rect.height); y < rect.y + rect.height * 2; y += 1) {
    for (let x = Math.floor(rect.x - rect.width); x < rect.x + rect.width * 2; x += 1) {
      // Rotate the sample point back into the photo's own frame.
      const dx = x - centreX;
      const dy = y - centreY;
      const lx = dx * cos + dy * sin + rect.width / 2;
      const ly = -dx * sin + dy * cos + rect.height / 2;
      if (lx < 0 || ly < 0 || lx >= rect.width || ly >= rect.height) continue;

      const u = lx / rect.width;
      const v = ly / rect.height;

      // Studio backdrop: a soft vertical gradient, never pure white.
      //
      // The pale variant runs the gradient the other way — lightest at the
      // bottom, as a lit backdrop falls off — so the bottom edge and the
      // lower half of each side sit within a few grey levels of the paper
      // around them. That is not a contrived worst case; it is what a
      // high-street studio print looks like on a white form.
      let colour: RGB =
        backdrop === "pale"
          ? [230 + v * 8, 233 + v * 7, 238 + v * 6]
          : [172 - v * 26, 178 - v * 24, 186 - v * 20];

      // Head: an ellipse in the upper middle.
      const headX = (u - 0.5) / 0.30;
      const headY = (v - 0.40) / 0.34;
      if (headX * headX + headY * headY < 1) {
        const shade = 1 - 0.28 * Math.max(0, headX);
        colour = [222 * shade, 176 * shade, 138 * shade];
        // Hair across the top of the head.
        if (v < 0.30 + 0.05 * Math.abs(headX)) colour = [58, 44, 38];
        // Eyes.
        if (v > 0.40 && v < 0.45 && Math.abs(Math.abs(u - 0.5) - 0.10) < 0.028) colour = [46, 40, 44];
      }

      // Shoulders: an arc entering from the bottom.
      const shoulderY = (v - 1.02) / 0.42;
      const shoulderX = (u - 0.5) / 0.72;
      if (v > 0.68 && shoulderX * shoulderX + shoulderY * shoulderY < 1) colour = [64, 78, 122];

      // Photographic grain — the reason local variance stays high everywhere
      // inside a photo and near zero on the paper around it.
      const grain = (random() - 0.5) * 26;
      setPixel(canvas, x, y, desaturate([colour[0] + grain, colour[1] + grain, colour[2] + grain]));
    }
  }
}

// ---------------------------------------------------------------------------
// Capture defects
// ---------------------------------------------------------------------------

function applyShadow(canvas: Canvas, strength: number) {
  // A diagonal falloff, as a hand or phone casts.
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const t = (x / canvas.width) * 0.6 + (y / canvas.height) * 0.4;
      const factor = 1 - strength * t;
      const i = (y * canvas.width + x) * 3;
      canvas.data[i] = canvas.data[i]! * factor;
      canvas.data[i + 1] = canvas.data[i + 1]! * factor;
      canvas.data[i + 2] = canvas.data[i + 2]! * factor;
    }
  }
}

function applyGlare(canvas: Canvas, page: Rect, random: () => number) {
  const cx = page.x + page.width * (0.3 + random() * 0.4);
  const cy = page.y + page.height * (0.2 + random() * 0.3);
  const radius = Math.min(page.width, page.height) * 0.22;
  for (let y = Math.round(cy - radius); y < cy + radius; y += 1) {
    for (let x = Math.round(cx - radius); x < cx + radius; x += 1) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) continue;
      const r = Math.hypot(x - cx, y - cy) / radius;
      if (r > 1) continue;
      const lift = (1 - r) * (1 - r) * 130;
      const i = (y * canvas.width + x) * 3;
      canvas.data[i] = canvas.data[i]! + lift;
      canvas.data[i + 1] = canvas.data[i + 1]! + lift;
      canvas.data[i + 2] = canvas.data[i + 2]! + lift;
    }
  }
}

function applySpeckle(canvas: Canvas, page: Rect, random: () => number, density: number) {
  const count = Math.round(page.width * page.height * density);
  for (let i = 0; i < count; i += 1) {
    const x = page.x + Math.floor(random() * page.width);
    const y = page.y + Math.floor(random() * page.height);
    const tone = 90 + random() * 70;
    setPixel(canvas, x, y, [tone, tone, tone], 0.8);
  }
}

function applyNoise(canvas: Canvas, amplitude: number, random: () => number) {
  const scale = amplitude * 255;
  for (let i = 0; i < canvas.data.length; i += 1) {
    canvas.data[i] = canvas.data[i]! + (random() - 0.5) * scale;
  }
}

function rotateCanvas(canvas: Canvas, degrees: number, background: RGB): Canvas {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const out: Canvas = { data: new Uint8ClampedArray(canvas.data.length), width: canvas.width, height: canvas.height };

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      const sx = dx * cos + dy * sin + cx;
      const sy = -dx * sin + dy * cos + cy;
      const i = (y * canvas.width + x) * 3;
      if (sx < 0 || sy < 0 || sx >= canvas.width - 1 || sy >= canvas.height - 1) {
        out.data[i] = background[0];
        out.data[i + 1] = background[1];
        out.data[i + 2] = background[2];
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let c = 0; c < 3; c += 1) {
        const a = canvas.data[(y0 * canvas.width + x0) * 3 + c]!;
        const b = canvas.data[(y0 * canvas.width + x0 + 1) * 3 + c]!;
        const d = canvas.data[((y0 + 1) * canvas.width + x0) * 3 + c]!;
        const e = canvas.data[((y0 + 1) * canvas.width + x0 + 1) * 3 + c]!;
        const top = a + (b - a) * fx;
        const bottom = d + (e - d) * fx;
        out.data[i + c] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}

function rotateRect(rect: Rect, degrees: number, width: number, height: number): Rect {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = width / 2;
  const cy = height / 2;
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    // Forward rotation, matching rotateCanvas's inverse map.
    return { x: dx * cos - dy * sin + cx, y: dx * sin + dy * cos + cy };
  });

  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}
