/**
 * Binary morphology.
 *
 * Implemented over an integral image rather than by convolving a structuring
 * element. For a *binary* mask and a *rectangular* SE the equivalences are
 * exact and worth stating, because they are why this file is short and fast:
 *
 *   dilate(p) = (count of set pixels in the window around p) > 0
 *   erode(p)  = (count of set pixels in the window around p) == window area
 *
 * Both are one integral-image box query, so cost is O(1) per pixel and
 * independent of SE size. A 41x41 close — which is what it takes to weld
 * separate strokes of a signature into one component — costs the same as a 3x3.
 * The naive version is 1681 lookups per pixel and would be the slowest thing in
 * the pipeline by two orders of magnitude.
 *
 * Rectangular SEs only. A disk would need a different method, and for document
 * work the difference does not survive the next thresholding step.
 *
 * Border handling: `boxArea` clamps to the image, so erode compares against the
 * *clipped* area. That means erosion does not eat the image border, which is
 * the behaviour we want — a signature touching the edge of its crop should not
 * be thinned away for being near the edge.
 */

import { createMask, type Mask } from "./types.ts";
import { boxArea, boxSum, integralOfMask } from "./integral.ts";

/** Grows set regions by `radius` in each direction (SE is (2r+1) square). */
export function dilate(mask: Mask, radius: number): Mask {
  if (radius <= 0) return copy(mask);
  const table = integralOfMask(mask);
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      out.data[y * mask.width + x] =
        boxSum(table, x - radius, y - radius, x + radius + 1, y + radius + 1) > 0 ? 255 : 0;
    }
  }
  return out;
}

/** Shrinks set regions by `radius`. Isolated specks smaller than the SE disappear. */
export function erode(mask: Mask, radius: number): Mask {
  if (radius <= 0) return copy(mask);
  const table = integralOfMask(mask);
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const x0 = x - radius;
      const y0 = y - radius;
      const x1 = x + radius + 1;
      const y1 = y + radius + 1;
      const area = boxArea(table, x0, y0, x1, y1);
      out.data[y * mask.width + x] = area > 0 && boxSum(table, x0, y0, x1, y1) >= area ? 255 : 0;
    }
  }
  return out;
}

/**
 * Erode then dilate. Removes specks and thin bridges while leaving large
 * regions the size they were. This is the speckle cleanup after binarization.
 */
export function open(mask: Mask, radius: number): Mask {
  return dilate(erode(mask, radius), radius);
}

/**
 * Dilate then erode. Fills gaps and joins nearby pieces without growing the
 * outline. This is how the separate strokes of a signature — which are
 * genuinely disconnected on paper — become one connected component that can be
 * measured as a single object.
 */
export function close(mask: Mask, radius: number): Mask {
  return erode(dilate(mask, radius), radius);
}

/**
 * Anisotropic close, with independent horizontal and vertical reach.
 *
 * Signatures need this. A signature is wide and short, and its pieces are
 * separated horizontally (between letters) far more than vertically. A square
 * close large enough to bridge the horizontal gaps also bridges *vertically*
 * into the printed line above and the printed label below, merging the
 * signature with page furniture into one useless blob. Closing with, say,
 * rx=18 ry=4 joins the signature to itself and to nothing else.
 */
export function closeRect(mask: Mask, radiusX: number, radiusY: number): Mask {
  return erodeRect(dilateRect(mask, radiusX, radiusY), radiusX, radiusY);
}

export function openRect(mask: Mask, radiusX: number, radiusY: number): Mask {
  return dilateRect(erodeRect(mask, radiusX, radiusY), radiusX, radiusY);
}

export function dilateRect(mask: Mask, radiusX: number, radiusY: number): Mask {
  if (radiusX <= 0 && radiusY <= 0) return copy(mask);
  const table = integralOfMask(mask);
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      out.data[y * mask.width + x] =
        boxSum(table, x - radiusX, y - radiusY, x + radiusX + 1, y + radiusY + 1) > 0 ? 255 : 0;
    }
  }
  return out;
}

export function erodeRect(mask: Mask, radiusX: number, radiusY: number): Mask {
  if (radiusX <= 0 && radiusY <= 0) return copy(mask);
  const table = integralOfMask(mask);
  const out = createMask(mask.width, mask.height);
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const x0 = x - radiusX;
      const y0 = y - radiusY;
      const x1 = x + radiusX + 1;
      const y1 = y + radiusY + 1;
      const area = boxArea(table, x0, y0, x1, y1);
      out.data[y * mask.width + x] = area > 0 && boxSum(table, x0, y0, x1, y1) >= area ? 255 : 0;
    }
  }
  return out;
}

/**
 * Removes horizontal and vertical rules — the printed lines people write on and
 * the boxes around fields.
 *
 * These are the single biggest nuisance in form processing. A signature written
 * across its rule is connected to that rule, and the rule usually runs the full
 * width of the form, so the signature's connected component becomes 800px wide
 * and every shape statistic about it is meaningless.
 *
 * The method is the classic one: a rule is the only thing that survives erosion
 * by a structuring element much longer than it is thick, in exactly one
 * direction. Erode with a long thin horizontal SE and only horizontal rules
 * remain; dilate that back to recover the rule's thickness; subtract. Same
 * vertically.
 *
 * `minLength` is in pixels and should be set well above the longest stroke a
 * human hand produces in one direction — a fifth of the page width is a good
 * default and is what the caller passes.
 */
export function removeRules(mask: Mask, minLength: number, thickness = 1): Mask {
  const halfLength = Math.max(1, Math.floor(minLength / 2));
  const halfThick = Math.max(0, thickness);

  // Horizontal rules: survive a wide-flat erosion.
  const horizontal = dilateRect(erodeRect(mask, halfLength, 0), halfLength, halfThick);
  // Vertical rules: survive a tall-narrow erosion.
  const vertical = dilateRect(erodeRect(mask, 0, halfLength), halfThick, halfLength);

  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) {
    const isRule = horizontal.data[i]! !== 0 || vertical.data[i]! !== 0;
    out.data[i] = mask.data[i]! !== 0 && !isRule ? 255 : 0;
  }
  return out;
}

/**
 * Isolates the rules instead of removing them. The page-geometry stage uses
 * this: a form's printed rules and boxes are a stable skeleton that survives
 * being written on, which makes them excellent registration anchors — far more
 * reliable than text, which changes on every filled copy.
 */
export function extractRules(mask: Mask, minLength: number, thickness = 1): Mask {
  const halfLength = Math.max(1, Math.floor(minLength / 2));
  const halfThick = Math.max(0, thickness);
  const horizontal = dilateRect(erodeRect(mask, halfLength, 0), halfLength, halfThick);
  const vertical = dilateRect(erodeRect(mask, 0, halfLength), halfThick, halfLength);
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) {
    out.data[i] = horizontal.data[i]! !== 0 || vertical.data[i]! !== 0 ? 255 : 0;
  }
  return out;
}

/**
 * Morphological gradient — the one-pixel outline of every set region.
 * Used to measure how much real edge support a candidate rectangle has.
 */
export function boundary(mask: Mask): Mask {
  const eroded = erode(mask, 1);
  const out = createMask(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i += 1) {
    out.data[i] = mask.data[i]! !== 0 && eroded.data[i]! === 0 ? 255 : 0;
  }
  return out;
}

function copy(mask: Mask): Mask {
  return { data: new Uint8ClampedArray(mask.data), width: mask.width, height: mask.height };
}
