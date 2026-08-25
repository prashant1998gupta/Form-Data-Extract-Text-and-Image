/**
 * Bicubic projective warping of colour images.
 *
 * WHY THIS EXISTS AT ALL. sharp cannot do it. `sharp.affine()` takes a 2x2
 * matrix, which is mathematically incapable of a projective transform — no 2x2
 * matrix can make parallel lines converge, and that convergence is exactly what
 * a photographed page has. There is no perspective-warp API in libvips's
 * JavaScript binding, so the one operation this whole product depends on has to
 * be written here.
 *
 * WHY BICUBIC. This is the single resample between the original pixels and a
 * delivered crop, and it is the last thing that happens to a patient's
 * photograph before a human looks at it. Bilinear costs one visible step of
 * softness on a face; Catmull-Rom's negative lobes preserve the edge contrast
 * that makes a small portrait readable. The cost is four times the taps on an
 * operation that runs on a region a few hundred pixels across.
 *
 * ONE RESAMPLE, ALWAYS. Deskew, perspective correction and scaling compose into
 * a single homography applied once. Warping to an upright rectangle and then
 * resizing to the output size is two interpolations, and the second one undoes
 * some of what the first preserved.
 */

import { estimateHomography } from "./geometry.ts";
import { rgbFrom, type Matrix3, type Point, type Quad, type Rgb } from "./types.ts";

/**
 * Catmull-Rom cubic kernel with a = -0.5.
 *
 * The negative lobes at |t| between 1 and 2 are the point: they sharpen the
 * result slightly, which counteracts the blur any resampling introduces. A
 * positive-only kernel (bilinear, Gaussian) can only ever soften.
 */
function cubicWeight(t: number): number {
  const x = Math.abs(t);
  if (x <= 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  return 0;
}

/**
 * Warps `image` by a destination-to-source homography.
 *
 * Backward mapping: for each destination pixel, find where it came from. Forward
 * mapping leaves unwritten holes wherever the transform expands.
 *
 * @param background Colour for destination pixels that map outside the source.
 *   Defaults to white, because these crops sit on paper — a black fringe would
 *   read as ink to anything that looked at the result afterwards.
 */
export function warpPerspectiveRgb(
  image: Rgb,
  destinationToSource: Matrix3,
  width: number,
  height: number,
  background: readonly [number, number, number] = [255, 255, 255],
): Rgb {
  const channels = 3;
  const out = new Uint8ClampedArray(width * height * channels);
  const [a, b, c, d, e, f, g, h, i] = destinationToSource;
  const sourceWidth = image.width;
  const sourceHeight = image.height;
  const sourceChannels = image.channels;

  const weightsX = new Float64Array(4);
  const weightsY = new Float64Array(4);

  for (let y = 0; y < height; y += 1) {
    // Incremental evaluation along the row: for fixed y the numerators are
    // affine in x, so each step is three adds instead of nine multiply-adds.
    let nx = b * y + c;
    let ny = e * y + f;
    let nw = h * y + i;

    for (let x = 0; x < width; x += 1) {
      const destination = (y * width + x) * channels;

      if (Math.abs(nw) < 1e-12) {
        out[destination] = background[0];
        out[destination + 1] = background[1];
        out[destination + 2] = background[2];
        nx += a;
        ny += d;
        nw += g;
        continue;
      }

      const sx = nx / nw;
      const sy = ny / nw;

      if (sx < -1 || sy < -1 || sx > sourceWidth || sy > sourceHeight) {
        out[destination] = background[0];
        out[destination + 1] = background[1];
        out[destination + 2] = background[2];
        nx += a;
        ny += d;
        nw += g;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      for (let k = 0; k < 4; k += 1) {
        weightsX[k] = cubicWeight(k - 1 - fx);
        weightsY[k] = cubicWeight(k - 1 - fy);
      }

      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;

      for (let ky = 0; ky < 4; ky += 1) {
        const wy = weightsY[ky]!;
        if (wy === 0) continue;
        // Clamp at the border rather than skipping: dropping out-of-range taps
        // renormalises the kernel toward the interior and darkens every edge
        // pixel of the crop by a visible amount.
        const py = Math.min(sourceHeight - 1, Math.max(0, y0 - 1 + ky));
        const rowOffset = py * sourceWidth;
        for (let kx = 0; kx < 4; kx += 1) {
          const w = wy * weightsX[kx]!;
          if (w === 0) continue;
          const px = Math.min(sourceWidth - 1, Math.max(0, x0 - 1 + kx));
          const source = (rowOffset + px) * sourceChannels;
          red += image.data[source]! * w;
          green += image.data[source + 1]! * w;
          blue += image.data[source + 2]! * w;
          total += w;
        }
      }

      if (total > 0) {
        red /= total;
        green /= total;
        blue /= total;
      }
      out[destination] = red;
      out[destination + 1] = green;
      out[destination + 2] = blue;

      nx += a;
      ny += d;
      nw += g;
    }
  }

  return rgbFrom(out, width, height, 3);
}

/**
 * Warps the region bounded by `quad` into an upright rectangle of the given
 * size, in one resample.
 *
 * This is what turns a crooked pasted photograph into a straight portrait, and
 * it is the visible quality difference between this and an axis-aligned crop:
 * an axis-aligned crop of a 6-degree paste has a wedge of form paper down one
 * side and a shaved corner on the other.
 */
export function warpQuadRgb(
  image: Rgb,
  quad: Quad,
  width: number,
  height: number,
  background?: readonly [number, number, number],
): Rgb {
  const destination: Point[] = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const source = [quad.tl, quad.tr, quad.br, quad.bl];
  // Estimated in the destination-to-source direction, which is the direction
  // the sampling loop needs — inverting afterwards would add avoidable error.
  const h = estimateHomography(destination, source);
  return warpPerspectiveRgb(image, h, width, height, background);
}

/**
 * Shrinks a quadrilateral toward its centre by a fraction of each side.
 *
 * The fitted boundary lands ON the physical edge of the photograph, where there
 * is a drop shadow, a paper sliver and the cut edge itself. Insetting removes
 * them. Insetting is always safer than outsetting: a crop one percent small
 * loses a sliver of background, while a crop one percent large includes a dark
 * line down one side that looks like a defect in the photograph.
 */
export function insetQuad(quad: Quad, fraction: number): Quad {
  const centre = {
    x: (quad.tl.x + quad.tr.x + quad.br.x + quad.bl.x) / 4,
    y: (quad.tl.y + quad.tr.y + quad.br.y + quad.bl.y) / 4,
  };
  const pull = (p: Point): Point => ({
    x: p.x + (centre.x - p.x) * fraction,
    y: p.y + (centre.y - p.y) * fraction,
  });
  return { tl: pull(quad.tl), tr: pull(quad.tr), br: pull(quad.br), bl: pull(quad.bl) };
}
