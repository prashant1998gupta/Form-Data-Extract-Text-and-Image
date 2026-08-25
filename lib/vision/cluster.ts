/**
 * Reassembles the separate strokes of one handwritten mark into a single group.
 *
 * A signature is two to six disconnected strokes. A handwritten field value is
 * a row of separate letters. Neither is one connected component, and both are
 * one OBJECT — so the components have to be grouped before anything can measure
 * the object's shape.
 *
 * THE CHAINING PROBLEM. The naive rule — merge any two components that are
 * close, repeat — is single-link clustering, and on a form it runs away. A
 * signature sits on a printed rule, near a printed caption, beside a
 * handwritten date. Each hop is individually short and individually reasonable;
 * the transitive closure spans half the page.
 *
 * The textbook answer is complete linkage: require EVERY member of one cluster
 * to be near EVERY member of the other, so a chain cannot form. It was tried
 * here and it does not work, for a reason specific to this problem — an
 * ELONGATED object has its own ends far apart, and a signature is elongated by
 * definition. Measured on the reference fixture, complete linkage refused to
 * join two halves of the SAME signature whose nearest edges were one pixel
 * apart, because its left-hand loops sat 168 px from the tip of its flourish.
 * The crop silently lost its right third.
 *
 * So grouping is by the gap between cluster BOUNDING BOXES, and runaway growth
 * is prevented by bounding the RESULT rather than the steps:
 *
 *   - a hard `cap` rectangle, outside which no merged cluster may extend;
 *   - a tight VERTICAL gap, so a cluster cannot reach the line above or below
 *     however far it extends sideways;
 *   - upstream, the caption filter removes the printed label that a chain would
 *     otherwise hop through (`lib/ink/text-lines.ts`).
 *
 * The gaps are deliberately ASYMMETRIC — generous horizontally, tight
 * vertically. A signature's strokes are separated along the writing direction,
 * and a symmetric gap large enough to bridge them would also reach the next
 * line of the form.
 */

import type { Component } from "./components.ts";
import type { Rect } from "./types.ts";

export interface Cluster {
  readonly bounds: Rect;
  readonly components: readonly Component[];
  /** Total set-pixel area of the members, NOT the bounding-box area. */
  readonly inkArea: number;
}

/**
 * Groups components into strokes-of-one-mark.
 *
 * @param gapX  Maximum horizontal bounding-box gap, in pixels.
 * @param gapY  Maximum vertical bounding-box gap, in pixels.
 * @param cap   Optional hard bound. A merge whose result would escape this
 *              rectangle is refused, however close the members are. This is the
 *              backstop against a cluster growing along a rule into the next
 *              field, and the mechanism that replaces complete linkage.
 */
export function clusterStrokes(
  components: readonly Component[],
  gapX: number,
  gapY: number,
  cap?: Rect,
): Cluster[] {
  if (components.length === 0) return [];

  let clusters: Cluster[] = components.map((component) => ({
    bounds: component.bounds,
    components: [component],
    inkArea: component.area,
  }));

  let merged = true;
  while (merged) {
    merged = false;

    // Find the closest admissible pair and merge only that one, then restart.
    // Merging every admissible pair in one sweep would reintroduce chaining
    // through the intermediate states.
    let bestI = -1;
    let bestJ = -1;
    let bestCost = Infinity;

    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const linkage = boundsLinkage(clusters[i]!, clusters[j]!);
        if (linkage.x > gapX || linkage.y > gapY) continue;

        const union = unionRect(clusters[i]!.bounds, clusters[j]!.bounds);
        if (cap && !contains(cap, union)) continue;

        // Normalised so the two axes are comparable despite different limits.
        const cost = linkage.x / Math.max(1e-6, gapX) + linkage.y / Math.max(1e-6, gapY);
        if (cost < bestCost) {
          bestCost = cost;
          bestI = i;
          bestJ = j;
        }
      }
    }

    if (bestI >= 0) {
      const a = clusters[bestI]!;
      const b = clusters[bestJ]!;
      const combined: Cluster = {
        bounds: unionRect(a.bounds, b.bounds),
        components: [...a.components, ...b.components],
        inkArea: a.inkArea + b.inkArea,
      };
      clusters = clusters.filter((_, index) => index !== bestI && index !== bestJ);
      clusters.push(combined);
      merged = true;
    }
  }

  clusters.sort((a, b) => b.inkArea - a.inkArea);
  return clusters;
}

/**
 * Linkage between two clusters: the gap between their bounding boxes.
 *
 * NOT complete linkage, and the reason is worth recording because complete
 * linkage is the textbook answer here and it does not work.
 *
 * Complete linkage requires EVERY member of one cluster to be near EVERY member
 * of the other. That is exactly what stops a chain forming — but it also makes
 * an ELONGATED object unassemblable, because its own ends are far apart. A
 * signature is elongated by definition. Measured on the reference fixture, the
 * loops at the left of a signature sit 168 px from the tip of its flourish, so
 * complete linkage refused to join two halves of the same signature whose
 * nearest edges were ONE pixel apart, and the crop lost its right third.
 *
 * Chaining is therefore prevented by three other mechanisms, which between them
 * cover the cases complete linkage was protecting against:
 *
 *   - the caption filter, which removes the printed label a chain would hop
 *     through (`lib/ink/text-lines.ts`);
 *   - a tight VERTICAL gap, so a cluster cannot reach the line above or below
 *     however far it extends sideways;
 *   - the hard `cap` rectangle, which refuses any merge whose result escapes
 *     the search region, whatever the gaps say.
 *
 * The third is the real backstop: chaining is unbounded growth, and a bound on
 * the result is a direct answer to it.
 */
function boundsLinkage(a: Cluster, b: Cluster): { x: number; y: number } {
  return rectGap(a.bounds, b.bounds);
}

/** Axis gaps between two rectangles. Zero on an axis where they overlap. */
export function rectGap(a: Rect, b: Rect): { x: number; y: number } {
  const x = Math.max(0, Math.max(a.x - (b.x + b.width), b.x - (a.x + a.width)));
  const y = Math.max(0, Math.max(a.y - (b.y + b.height), b.y - (a.y + a.height)));
  return { x, y };
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Splits a cluster at its widest internal horizontal gap.
 *
 * Used when a cluster breaches its area cap: rather than truncating silently or
 * rejecting outright, the group is cut where it is most plausibly two things,
 * and the caller keeps whichever half is nearest the baseline anchor. The other
 * half is reported as excluded, which is information the operator can act on.
 */
export function splitAtWidestGap(cluster: Cluster): [Cluster, Cluster] | null {
  if (cluster.components.length < 2) return null;

  const ordered = [...cluster.components].sort((a, b) => a.bounds.x - b.bounds.x);
  let bestIndex = -1;
  let bestGap = -1;

  for (let i = 0; i < ordered.length - 1; i += 1) {
    // The gap between everything up to i and everything after.
    let rightmost = -Infinity;
    for (let k = 0; k <= i; k += 1) rightmost = Math.max(rightmost, ordered[k]!.bounds.x + ordered[k]!.bounds.width);
    const gap = ordered[i + 1]!.bounds.x - rightmost;
    if (gap > bestGap) {
      bestGap = gap;
      bestIndex = i;
    }
  }

  if (bestIndex < 0) return null;
  return [clusterOf(ordered.slice(0, bestIndex + 1)), clusterOf(ordered.slice(bestIndex + 1))];
}

function clusterOf(components: readonly Component[]): Cluster {
  let bounds = components[0]!.bounds;
  let inkArea = 0;
  for (const component of components) {
    bounds = unionRect(bounds, component.bounds);
    inkArea += component.area;
  }
  return { bounds, components: [...components], inkArea };
}
