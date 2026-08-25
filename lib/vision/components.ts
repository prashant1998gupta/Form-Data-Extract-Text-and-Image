/**
 * Connected-component labelling with per-component statistics.
 *
 * Two-pass union-find with 8-connectivity. Eight rather than four is not a
 * detail: handwriting is full of strokes that touch only at a corner, and under
 * 4-connectivity a single pen stroke routinely splits into three components.
 * Every shape statistic we compute — fill ratio, aspect, elongation — is then
 * measured on a fragment instead of the object, and the signature/thumb
 * discrimination that depends on those statistics fails.
 *
 * The union-find uses path compression with a flat Int32Array parent table. No
 * recursion anywhere: a diagonal stroke across a 3000px image produces a chain
 * thousands of links long, and a recursive find blows the stack on exactly the
 * inputs we care about.
 */

import { createMask, type Mask, type Point, type Rect } from "./types.ts";

export interface Component {
  /** Label id, 1-based. 0 is background and never appears here. */
  readonly label: number;
  /** Number of set pixels. */
  readonly area: number;
  readonly bounds: Rect;
  readonly centroid: Point;
  /** area / (bounds.width * bounds.height). The key signature-vs-thumb discriminator. */
  readonly fillRatio: number;
  /** Longer bounds edge / shorter. Always >= 1. */
  readonly aspect: number;
}

export interface LabelledImage {
  /** Per-pixel label, 0 = background. */
  readonly labels: Int32Array;
  readonly width: number;
  readonly height: number;
  /** Sorted by area, largest first — callers almost always want the biggest thing. */
  readonly components: readonly Component[];
}

/**
 * Labels the set pixels of `mask`.
 *
 * @param minArea Components smaller than this are dropped from `components` and
 *   zeroed in `labels`. Set it to a few pixels to discard sensor speckle
 *   without touching the dot on an 'i'.
 */
export function connectedComponents(mask: Mask, minArea = 1): LabelledImage {
  const { width, height, data } = mask;
  const labels = new Int32Array(width * height);

  // Worst case is a checkerboard: every other pixel its own provisional label.
  const maxLabels = Math.floor((width * height) / 2) + 2;
  const parent = new Int32Array(maxLabels);
  let next = 1;

  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression, iterative.
    let walk = a;
    while (parent[walk] !== root) {
      const up = parent[walk]!;
      parent[walk] = root;
      walk = up;
    }
    return root;
  };

  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Pass 1 — provisional labels, scanning the four already-visited neighbours
  // (NW, N, NE, W). Checking only the causal half is what makes one pass enough.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      if (data[i]! === 0) continue;

      const west = x > 0 ? labels[i - 1]! : 0;
      const north = y > 0 ? labels[i - width]! : 0;
      const northWest = x > 0 && y > 0 ? labels[i - width - 1]! : 0;
      const northEast = x < width - 1 && y > 0 ? labels[i - width + 1]! : 0;

      let best = 0;
      if (west !== 0) best = west;
      if (north !== 0 && (best === 0 || north < best)) best = north;
      if (northWest !== 0 && (best === 0 || northWest < best)) best = northWest;
      if (northEast !== 0 && (best === 0 || northEast < best)) best = northEast;

      if (best === 0) {
        parent[next] = next;
        labels[i] = next;
        next += 1;
        continue;
      }

      labels[i] = best;
      if (west !== 0) union(best, west);
      if (north !== 0) union(best, north);
      if (northWest !== 0) union(best, northWest);
      if (northEast !== 0) union(best, northEast);
    }
  }

  // Pass 2 — resolve to roots, renumber densely, and accumulate statistics in
  // the same sweep. Doing stats here rather than in a third pass matters: at
  // 8 MP a third full traversal is a measurable fraction of the request budget.
  const remap = new Int32Array(next);
  const areas: number[] = [];
  const minX: number[] = [];
  const minY: number[] = [];
  const maxX: number[] = [];
  const maxY: number[] = [];
  const sumX: number[] = [];
  const sumY: number[] = [];
  let count = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const provisional = labels[i]!;
      if (provisional === 0) continue;
      const root = find(provisional);
      let dense = remap[root]!;
      if (dense === 0) {
        count += 1;
        dense = count;
        remap[root] = dense;
        areas[dense] = 0;
        minX[dense] = x;
        minY[dense] = y;
        maxX[dense] = x;
        maxY[dense] = y;
        sumX[dense] = 0;
        sumY[dense] = 0;
      }
      labels[i] = dense;
      areas[dense] += 1;
      if (x < minX[dense]!) minX[dense] = x;
      if (x > maxX[dense]!) maxX[dense] = x;
      if (y < minY[dense]!) minY[dense] = y;
      if (y > maxY[dense]!) maxY[dense] = y;
      sumX[dense] += x;
      sumY[dense] += y;
    }
  }

  const kept = new Int32Array(count + 1);
  const components: Component[] = [];
  let keptCount = 0;
  for (let label = 1; label <= count; label += 1) {
    const area = areas[label]!;
    if (area < minArea) continue;
    keptCount += 1;
    kept[label] = keptCount;
    const width_ = maxX[label]! - minX[label]! + 1;
    const height_ = maxY[label]! - minY[label]! + 1;
    components.push({
      label: keptCount,
      area,
      bounds: { x: minX[label]!, y: minY[label]!, width: width_, height: height_ },
      centroid: { x: sumX[label]! / area, y: sumY[label]! / area },
      fillRatio: area / (width_ * height_),
      aspect: width_ >= height_ ? width_ / height_ : height_ / width_,
    });
  }

  // Rewrite labels to the kept numbering, zeroing anything filtered out.
  if (keptCount !== count) {
    for (let i = 0; i < labels.length; i += 1) {
      const label = labels[i]!;
      if (label !== 0) labels[i] = kept[label]!;
    }
  }

  components.sort((a, b) => b.area - a.area);
  return { labels, width, height, components };
}

/** Mask containing only the pixels of one component. */
export function componentMask(labelled: LabelledImage, label: number): Mask {
  const out = createMask(labelled.width, labelled.height);
  for (let i = 0; i < labelled.labels.length; i += 1) {
    if (labelled.labels[i] === label) out.data[i] = 255;
  }
  return out;
}

/** Mask cropped to the component's own bounding box — the usual input to a shape measurement. */
export function componentPatch(labelled: LabelledImage, component: Component): Mask {
  const { bounds } = component;
  const out = createMask(bounds.width, bounds.height);
  for (let y = 0; y < bounds.height; y += 1) {
    const src = (bounds.y + y) * labelled.width + bounds.x;
    const dst = y * bounds.width;
    for (let x = 0; x < bounds.width; x += 1) {
      if (labelled.labels[src + x] === component.label) out.data[dst + x] = 255;
    }
  }
  return out;
}

/** Mask of every component satisfying `keep`. */
export function filterComponents(labelled: LabelledImage, keep: (component: Component) => boolean): Mask {
  const allowed = new Uint8Array(labelled.components.length + 1);
  for (const component of labelled.components) {
    if (keep(component)) allowed[component.label] = 1;
  }
  const out = createMask(labelled.width, labelled.height);
  for (let i = 0; i < labelled.labels.length; i += 1) {
    const label = labelled.labels[i]!;
    if (label !== 0 && allowed[label] === 1) out.data[i] = 255;
  }
  return out;
}

/** Components whose bounding box lies wholly inside `rect`. */
export function componentsWithin(labelled: LabelledImage, rect: Rect): Component[] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return labelled.components.filter(
    (c) =>
      c.bounds.x >= rect.x &&
      c.bounds.y >= rect.y &&
      c.bounds.x + c.bounds.width <= right &&
      c.bounds.y + c.bounds.height <= bottom,
  );
}

/** Pixel coordinates of one component. Feeds the convex-hull and rotated-rect fitting. */
export function componentPoints(labelled: LabelledImage, label: number): Point[] {
  const points: Point[] = [];
  for (let y = 0; y < labelled.height; y += 1) {
    const row = y * labelled.width;
    for (let x = 0; x < labelled.width; x += 1) {
      if (labelled.labels[row + x] === label) points.push({ x, y });
    }
  }
  return points;
}

/**
 * Merges components whose bounding boxes are within `gapX`/`gapY` of each
 * other, returning grouped bounding boxes.
 *
 * This is how scattered ink becomes a candidate region. A signature is several
 * disconnected strokes; a handwritten field value is several separate letters.
 * Neither is one component, and both are one *object*. Grouping by proximity
 * with asymmetric gaps — generous horizontally, tight vertically — reconstructs
 * the object without merging it into the line above.
 *
 * Iterates to a fixed point, because merging two boxes can bring a third within
 * range of the union when it was near neither original.
 */
export function groupByProximity(components: readonly Component[], gapX: number, gapY: number): Rect[] {
  let boxes: Rect[] = components.map((c) => c.bounds);
  let merged = true;
  while (merged) {
    merged = false;
    const output: Rect[] = [];
    const consumed = new Set<number>();
    for (let i = 0; i < boxes.length; i += 1) {
      if (consumed.has(i)) continue;
      let current = boxes[i]!;
      for (let j = i + 1; j < boxes.length; j += 1) {
        if (consumed.has(j)) continue;
        if (near(current, boxes[j]!, gapX, gapY)) {
          current = unionRect(current, boxes[j]!);
          consumed.add(j);
          merged = true;
        }
      }
      output.push(current);
    }
    boxes = output;
  }
  return boxes;
}

function near(a: Rect, b: Rect, gapX: number, gapY: number): boolean {
  const horizontalGap = Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width));
  const verticalGap = Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height));
  return horizontalGap <= gapX && verticalGap <= gapY;
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}
