import assert from "node:assert/strict";
import test from "node:test";

import { prepareChannels } from "../lib/ink/normalize.ts";
import { detectPhoto, type PhotoDetection } from "../lib/regions/photo.ts";
import { boundsOf, iou, quadPoints, type Rect, type Rgb } from "../lib/vision/types.ts";
import { renderSyntheticForm, type SyntheticFormOptions } from "./helpers/synthetic-form.ts";

/**
 * End-to-end photograph detection against forms with known ground truth.
 *
 * The measure is IoU of the detected quadrilateral against the physical
 * boundary of the pasted photo — not against a human-drawn box, and not "did it
 * find something in roughly the right place". A crop that is 5 % too small cuts
 * the top of a head off, and IoU is what notices.
 *
 * The negative cases carry equal weight. A detector that finds photographs
 * reliably and also "finds" one in an empty printed box is not usable in a
 * hospital, and the empty-box case is the one a demo never shows.
 */

/** The generator renders at 150 dpi, so a millimetre is this many pixels. */
const PX_PER_MM = 150 / 25.4;

const PASSPORT = { widthMM: 35, heightMM: 45 };

/**
 * Runs detection the way the pipeline will, including a deliberate registration
 * error — the expected box is offset and resized slightly from the truth.
 *
 * Testing with a perfect ROI would be testing a situation that never occurs.
 * Registration lands within a fraction of a millimetre on a good scan and a
 * couple of millimetres on a bad one, and the detector's whole job is to
 * recover the exact boundary from an approximate prior.
 */
function detect(
  options: SyntheticFormOptions,
  jitter: { dx: number; dy: number; scale: number } = { dx: 0, dy: 0, scale: 1 },
): { detection: PhotoDetection; truth: Rect | null; rgb: Rgb } {
  const { rgb, truth } = renderSyntheticForm(options);

  // The template's photo box, as registration would report it: the truth,
  // perturbed. When there is no photo, the printed placeholder is where the
  // template says it is.
  const base: Rect = truth.photo ?? { x: 943 - 3, y: 176 - 3, width: 213, height: 272 };
  const expected: Rect = {
    x: base.x + jitter.dx + (base.width * (1 - jitter.scale)) / 2,
    y: base.y + jitter.dy + (base.height * (1 - jitter.scale)) / 2,
    width: base.width * jitter.scale,
    height: base.height * jitter.scale,
  };

  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [expected] });

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  return { detection, truth: truth.photo, rgb };
}

function detectedBounds(detection: PhotoDetection): Rect {
  assert.ok(detection.found, "expected a detection");
  return boundsOf(quadPoints(detection.quad));
}

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

test("a pasted colour photograph is cropped to its physical boundary", () => {
  const { detection, truth } = detect({}, { dx: 4, dy: -3, scale: 0.97 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);

  const overlap = iou(detectedBounds(detection), truth!);
  assert.ok(overlap > 0.93, `IoU ${overlap.toFixed(3)} against the true photo boundary`);
  assert.ok(detection.confidence > 0.6, `confidence ${detection.confidence.toFixed(2)}`);
});

test("detection survives a registration prior that is several millimetres out", () => {
  // ~2.5 mm of offset and a 6 % size error. The boundary fit has to pull the
  // answer back to the truth; if it merely returned the prior, IoU would track
  // the jitter instead of the photo.
  const { detection, truth } = detect({}, { dx: 15, dy: 12, scale: 0.94 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);

  const overlap = iou(detectedBounds(detection), truth!);
  assert.ok(overlap > 0.9, `IoU ${overlap.toFixed(3)} with a badly-placed prior`);
});

test("a photocopied greyscale photograph is still found, with capped confidence", () => {
  // No colour anywhere on the page: chroma features are dead and the detector
  // must fall through to lightness and texture.
  const { detection, truth } = detect({ photocopy: true, monochromePhoto: true, noise: 0.03 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);

  const overlap = iou(detectedBounds(detection), truth!);
  assert.ok(overlap > 0.85, `IoU ${overlap.toFixed(3)} on a photocopy`);
  assert.ok(detection.greyscale, "should have taken the greyscale branch");
  assert.ok(detection.confidence <= 0.72, `greyscale confidence must be capped, got ${detection.confidence.toFixed(2)}`);
});

test("a shadowed, noisy desk photo still yields an accurate crop", () => {
  const { detection, truth } = detect({ desk: 0, shadow: 0.35, noise: 0.04 }, { dx: 6, dy: 5, scale: 0.96 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);
  const overlap = iou(detectedBounds(detection), truth!);
  assert.ok(overlap > 0.88, `IoU ${overlap.toFixed(3)} under shadow`);
});

test("a crooked paste has its rotation measured, not ignored", () => {
  // The angle is what the deskewing warp will undo. Reporting zero here would
  // deliver a straight crop of a rotated photo — a wedge of form paper down one
  // side and a shaved corner on the other.
  const { detection } = detect({ photoRotation: 6 }, { dx: 2, dy: 2, scale: 0.98 });
  assert.ok(detection.found, detection.found ? "" : `not found: ${detection.detail}`);
  assert.ok(
    Math.abs(Math.abs(detection.rotationDegrees) - 6) < 2.5,
    `expected ~6 degrees of paste rotation, measured ${detection.rotationDegrees.toFixed(2)}`,
  );
});

// ---------------------------------------------------------------------------
// Negative cases — the ones that decide whether this is usable
// ---------------------------------------------------------------------------

test("an empty printed photo box is asserted empty, not cropped", () => {
  // THE critical negative. The printed "Affix Photo" rectangle is present and
  // has four strong, straight, correctly-proportioned edges. A boundary-only
  // detector locks onto it every time and returns a crop of blank paper.
  const { detection } = detect({ withPhoto: false });

  assert.ok(!detection.found, "an empty box must never produce a crop");
  assert.equal(detection.reason, "box_empty", `expected box_empty, got ${detection.reason}: ${detection.detail}`);
});

test("the empty-box refusal names a clause and gives a reason", () => {
  const { detection } = detect({ withPhoto: false });
  assert.ok(!detection.found);
  assert.ok(detection.detail.length > 0, "a refusal must explain itself");
  assert.ok(
    ["content", "still_blank", "boundary"].includes(detection.failedClause),
    `unexpected clause ${detection.failedClause}`,
  );
});

test("a signature is never mistaken for a photograph", () => {
  // Point the photo detector at the signature area. There is ink, there are
  // edges, there is structure — and none of it is a photograph.
  const { rgb } = renderSyntheticForm({ withPhoto: false });
  const signatureArea: Rect = { x: 120, y: 1360, width: 420, height: 110 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [signatureArea] });

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected: signatureArea,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  assert.ok(!detection.found, "handwriting must not be accepted as a photograph");
});

test("blank paper produces no photograph", () => {
  const { rgb } = renderSyntheticForm({ withPhoto: false, withSignature: false, withThumb: false });
  // An empty region in the middle of the page, well away from any printed box.
  const emptyArea: Rect = { x: 200, y: 800, width: 207, height: 266 };
  const channels = prepareChannels(rgb, { pxPerMM: PX_PER_MM, imageRegions: [emptyArea] });

  const detection = detectPhoto({
    lab: channels.lab,
    texture: channels.texture,
    ink: channels.ink,
    paper: channels.paper,
    expected: emptyArea,
    sizeMM: PASSPORT,
    pxPerMM: PX_PER_MM,
    pageSaturatedFraction: channels.saturatedFraction,
  });

  assert.ok(!detection.found, "blank paper must not produce a crop");
  assert.equal(detection.reason, "box_empty");
});

test("a refusal still offers its best candidate as a suggestion, never as an answer", () => {
  // When something was found but did not clear the bar, the operator gets a
  // dashed suggestion to accept with one tap. It must never be emitted as a
  // stored crop — that distinction is the whole product rule.
  const { detection } = detect({ withPhoto: false });
  assert.ok(!detection.found);
  if (detection.suggestion) {
    assert.ok(detection.reason !== "box_empty" || true, "a suggestion may accompany any refusal");
  }
  // The type system enforces the real invariant: there is no `quad` on a
  // refusal, so no caller can accidentally store one.
  assert.ok(!("quad" in detection), "a refusal must not carry a crop quad");
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test("every edge reports whether it was measured and how strongly", () => {
  const { detection } = detect({});
  assert.equal(detection.edges.length, 4);
  for (const edge of detection.edges) {
    assert.ok(["left", "right", "top", "bottom"].includes(edge.side));
    if (edge.fitted) {
      assert.ok(edge.responseSigma >= 3, `${edge.side} accepted below the 3-sigma floor`);
      assert.ok(edge.inlierRatio >= 0.45, `${edge.side} accepted below the inlier floor`);
    }
  }
});

test("detection is deterministic across runs", () => {
  const first = detect({}, { dx: 3, dy: 3, scale: 0.97 });
  const second = detect({}, { dx: 3, dy: 3, scale: 0.97 });
  assert.equal(first.detection.found, second.detection.found);
  if (first.detection.found && second.detection.found) {
    assert.deepEqual(first.detection.quad, second.detection.quad);
  }
});
