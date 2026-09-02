/**
 * Reading every declared text field of one scan — the orchestrator.
 *
 * Two modes, one preference. PER-FIELD — one request per field, a few in
 * flight at a time — is the default wherever the provider's limits allow,
 * because it buys three properties at the price of round trips:
 *
 * - THE MAPPING IS STRUCTURAL. Request N is field N; the model is never asked
 *   to attribute values to fields, so a real value cannot land under a wrong
 *   label — the failure this product considers worse than no value at all.
 * - THE EVIDENCE IS EXACT. The crop shown for review is byte-for-byte what
 *   the model read.
 * - FAULTS ARE ISOLATED. One field timing out costs one field, not the scan.
 *
 * COMPOSITE — every crop in one numbered image, one request per scan — exists
 * because some tiers price those round trips out entirely (Groq bills a flat
 * ~2k tokens per image; eight requests cannot fit its free tier's minute).
 * It trades each property down honestly rather than away: mapping rides on
 * strip numbers WE print into the pixels (a skipped strip fails alone, never
 * shifting neighbours); the review strip is the same pixels the model read at
 * that position, re-encoded; and one transport fault fails the scan's
 * readings in one banner. The trade is stated in `composite.ts`.
 *
 * Callers gate this on registration, not this module — but it is a
 * load-bearing gate worth restating: a text value is a labelled claim, it
 * only means anything if the label is known to be right, so NO field is read
 * from a page that did not register as this template. The route enforces it.
 */

import type { PageSizeMM } from "../geometry/frames.ts";
import type { FormField, FormTemplate } from "../templates/types.ts";
import type { Rgb } from "../vision/types.ts";
import { encodeRgbJpeg } from "../vision/io.ts";
import { buildComposite } from "./composite.ts";
import { cropRgb, evidenceRect } from "./crop.ts";
import { COMPOSITE_SYSTEM_PROMPT, compositeInstruction, fieldInstruction, READER_SYSTEM_PROMPT } from "./prompt.ts";
import { parseCompositeReadings, parseReading } from "./parse.ts";
import { ProviderError, type ReadMode, type TextProvider } from "./provider-types.ts";
import { readableFields, type FieldReading } from "./types.ts";

/** JPEG quality for the crop the model reads. Higher than the screen preview: strokes are the payload. */
const EVIDENCE_JPEG_QUALITY = 90;
/** Requests in flight at once. Polite to free-tier rate limits; 8 fields still finish in ~2 waves. */
const CONCURRENCY = 4;
/** Per-request ceiling, further capped by whatever remains of the scan budget. */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * The SCAN-level ceiling, and the constant that actually keeps the route
 * alive. Per-request timeouts alone do not: eight fields at concurrency 4 is
 * two waves, and two waves of full 30 s timeouts is 60 s — the route's entire
 * `maxDuration`, spent before extraction's ~3 s is even counted, so a provider
 * outage would kill the whole response and take the already-extracted crops
 * with it. Every request's timeout is clamped to what remains of this budget,
 * and a field whose turn arrives with less than `MIN_CALL_MS` left is failed
 * in words instead of started — a late field costs itself, never the scan.
 */
const SCAN_BUDGET_MS = 40_000;
/** Below this there is no point contacting a provider at all. */
const MIN_CALL_MS = 3_000;
/**
 * Attempts per request, counting the first. Three, because a rate limit on a
 * free tier is a WINDOW: the first retry lands inside the same window more
 * often than not, and the second is the one that gets through. Measured on
 * the failure that motivated this — one composite request, refused with a
 * 429, retried once after a 5 s cap, refused again — every field on the
 * screen read "the reader is rate limited", while the identical scan a moment
 * later read all of them. Two chances were not enough; the budget below is
 * what bounds it, not the count.
 */
const MAX_ATTEMPTS = 3;
/** The longest single wait between attempts, whatever the server asked for. */
const MAX_RETRY_DELAY_MS = 15_000;
/** The wait when a retryable fault names no delay: doubled per attempt. */
const BASE_RETRY_DELAY_MS = 2_000;

export interface ReadTextFieldsOptions {
  readonly rectified: Rgb;
  readonly template: FormTemplate;
  readonly provider: TextProvider;
  /** Defaults to the provider's preference. See `ReadMode` for the trade. */
  readonly mode?: ReadMode;
  readonly timeoutMs?: number;
  readonly scanBudgetMs?: number;
}

export async function readTextFields(options: ReadTextFieldsOptions): Promise<FieldReading[]> {
  const { rectified, template, provider } = options;
  const mode = options.mode ?? provider.preferredMode;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + (options.scanBudgetMs ?? SCAN_BUDGET_MS);
  const fields = readableFields(template);

  if (mode === "composite") {
    return readComposite(fields, rectified, template.page, provider, timeoutMs, deadline);
  }

  const readings: FieldReading[] = new Array<FieldReading>(fields.length);
  let next = 0;

  const worker = async () => {
    while (next < fields.length) {
      const index = next;
      next += 1;
      readings[index] = await readOne(fields[index], rectified, template.page, provider, timeoutMs, deadline);
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, fields.length) }, worker));
  return readings;
}

/**
 * The one-request mode: every crop in one numbered image, one reply for the
 * scan. Chosen for providers whose per-minute token caps make per-field
 * requests impossible — the trade it makes, and the mitigations for it, are
 * stated in `composite.ts`. Evidence stays per field: each strip shown for
 * review is the same pixels the model read at that strip's position.
 */
/**
 * The composite's size ceiling, checked BEFORE a single crop is materialised.
 *
 * A valid template can declare forty page-sized text boxes — parseBox clamps
 * to the page, not to good sense — and stacking those would build a ~160 MP
 * raster: past every provider's image limits and, first, past the memory a
 * shared serverless function survives. The bounds are provider-shaped: 7,500
 * px stays under Anthropic's 8,000 px dimension cap, and ~30 MP keeps the
 * JPEG comfortably inside Groq's base64 request budget. A form that cannot
 * fit is failed in words, before any allocation, not discovered as an OOM.
 */
const MAX_COMPOSITE_EDGE_PX = 7_500;
const MAX_COMPOSITE_PIXELS = 30_000_000;

async function readComposite(
  fields: readonly FormField[],
  rectified: Rgb,
  page: PageSizeMM,
  provider: TextProvider,
  timeoutMs: number,
  deadline: number,
): Promise<FieldReading[]> {
  const rects = fields.map((field) => evidenceRect(field.box!, page));
  const stackedHeight = rects.reduce((sum, rect) => sum + Math.max(rect.height, 50), 0) + rects.length * 10;
  const stackedWidth = 80 + Math.max(0, ...rects.map((rect) => rect.width));
  if (
    stackedHeight > MAX_COMPOSITE_EDGE_PX ||
    stackedWidth > MAX_COMPOSITE_EDGE_PX ||
    stackedHeight * stackedWidth > MAX_COMPOSITE_PIXELS
  ) {
    return fields.map((field, index) => ({
      fieldId: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required,
      options: field.options,
      hint: field.hint,
      value: null,
      blank: false,
      failure: "this form's text fields are too large to read in one pass — set FORMLINK_TEXT_MODE=perField",
      regionInPage: rects[index],
    }));
  }

  const cropped = await Promise.all(
    fields.map(async (field, index) => {
      const rect = rects[index];
      const crop = cropRgb(rectified, rect);
      return { field, rect, crop, evidenceJpeg: await encodeRgbJpeg(crop, undefined, EVIDENCE_JPEG_QUALITY) };
    }),
  );

  const base = cropped.map(({ field, rect, evidenceJpeg }) => ({
    fieldId: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    hint: field.hint,
    evidenceJpeg,
    regionInPage: rect,
  }));

  const failAll = (message: string): FieldReading[] =>
    base.map((entry) => ({ ...entry, value: null, blank: false, failure: message }));

  const remaining = deadline - Date.now();
  if (remaining < MIN_CALL_MS) return failAll("the reader ran out of time for this scan");

  const composite = buildComposite(cropped.map((entry) => entry.crop));
  const compositeJpeg = await encodeRgbJpeg(composite, undefined, EVIDENCE_JPEG_QUALITY);

  let raw: string;
  try {
    raw = await callWithRetries(
      provider,
      {
        imageJpegBase64: compositeJpeg.toString("base64"),
        system: COMPOSITE_SYSTEM_PROMPT,
        prompt: compositeInstruction(fields),
        timeoutMs: Math.min(timeoutMs, remaining),
      },
      deadline,
    );
  } catch (error) {
    // One request, one fault, every field says the same thing — which the
    // route collapses into a single banner rather than a column of echoes.
    return failAll(error instanceof ProviderError ? error.message : "the reader failed unexpectedly");
  }

  const readings = parseCompositeReadings(raw, fields);
  return base.map((entry, index) => {
    const parsed = readings[index];
    if (parsed.problem) return { ...entry, value: null, blank: false, failure: parsed.problem };
    return { ...entry, value: parsed.value, blank: parsed.blank, notInOptions: parsed.notInOptions };
  });
}

async function readOne(
  field: FormField,
  rectified: Rgb,
  page: PageSizeMM,
  provider: TextProvider,
  timeoutMs: number,
  deadline: number,
): Promise<FieldReading> {
  const base = {
    fieldId: field.id,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.options,
    hint: field.hint,
  };

  const rect = evidenceRect(field.box!, page);
  const crop = cropRgb(rectified, rect);
  const evidenceJpeg = await encodeRgbJpeg(crop, undefined, EVIDENCE_JPEG_QUALITY);

  const remaining = deadline - Date.now();
  if (remaining < MIN_CALL_MS) {
    // The budget went on earlier fields. Failing this one in words keeps the
    // scan — and the crops already extracted — alive to say so.
    return {
      ...base,
      value: null,
      blank: false,
      failure: "the reader ran out of time for this scan",
      evidenceJpeg,
      regionInPage: rect,
    };
  }

  let raw: string;
  try {
    raw = await callWithRetries(
      provider,
      {
        imageJpegBase64: evidenceJpeg.toString("base64"),
        system: READER_SYSTEM_PROMPT,
        prompt: fieldInstruction(field),
        timeoutMs: Math.min(timeoutMs, remaining),
      },
      deadline,
    );
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "the reader failed unexpectedly";
    return { ...base, value: null, blank: false, failure: message, evidenceJpeg, regionInPage: rect };
  }

  const parsed = parseReading(raw, field);
  if (parsed.problem) {
    return { ...base, value: null, blank: false, failure: parsed.problem, evidenceJpeg, regionInPage: rect };
  }

  return {
    ...base,
    value: parsed.value,
    blank: parsed.blank,
    notInOptions: parsed.notInOptions,
    evidenceJpeg,
    regionInPage: rect,
  };
}

/**
 * Up to `MAX_ATTEMPTS` tries, only for faults the provider marked retryable.
 *
 * Each wait is the delay the server asked for when it named one, otherwise an
 * exponential backoff with jitter — and either way capped, then clamped to
 * what remains of the scan budget, because the route's own deadline is not
 * negotiable. An attempt is only made when the budget still has room for the
 * wait AND a meaningful call; when it does not, the last fault is what the
 * operator reads, so a scan that ran out of time says so instead of
 * pretending the provider refused it a third time.
 *
 * `sleep` is injectable so the tests can prove the schedule without waiting
 * through it.
 */
async function callWithRetries(
  provider: TextProvider,
  request: { imageJpegBase64: string; system: string; prompt: string; timeoutMs: number },
  deadline: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<string> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const remaining = deadline - Date.now();
    try {
      return await provider.read({ ...request, timeoutMs: Math.max(1, Math.min(request.timeoutMs, remaining)) });
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;

      const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5);
      const delay = Math.min(error.retryAfterMs ?? backoff, MAX_RETRY_DELAY_MS);
      const remainingAfterDelay = deadline - Date.now() - delay;
      if (remainingAfterDelay < MIN_CALL_MS) throw error;
      await sleep(delay);
    }
  }
}
