/**
 * Reading every declared text field of one scan — the orchestrator.
 *
 * One request per field, a few in flight at a time. Per-field requests cost
 * more round trips than one page-sized request, and are worth every one of
 * them, for three reasons that are really one reason:
 *
 * - THE MAPPING IS STRUCTURAL. Request N is field N. A page-sized request
 *   asks the model to attribute values to fields — which is the model
 *   supplying geometry, the exact thing `lib/reader/types.ts` forbids, and the
 *   failure it produces (a real value under a wrong label) is the one this
 *   product considers worse than no value at all.
 * - THE EVIDENCE IS EXACT. The crop shown for review is byte-for-byte what the
 *   model read. A page-sized request has no honest equivalent.
 * - FAULTS ARE ISOLATED. One field timing out costs one field, not the scan.
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
import { cropRgb, evidenceRect } from "./crop.ts";
import { fieldInstruction, READER_SYSTEM_PROMPT } from "./prompt.ts";
import { parseReading } from "./parse.ts";
import { ProviderError, type TextProvider } from "./provider-types.ts";
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

export interface ReadTextFieldsOptions {
  readonly rectified: Rgb;
  readonly template: FormTemplate;
  readonly provider: TextProvider;
  readonly timeoutMs?: number;
  readonly scanBudgetMs?: number;
}

export async function readTextFields(options: ReadTextFieldsOptions): Promise<FieldReading[]> {
  const { rectified, template, provider } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + (options.scanBudgetMs ?? SCAN_BUDGET_MS);
  const fields = readableFields(template);

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
    raw = await callWithOneRetry(
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
 * One retry, only for faults the provider marked retryable, after the delay it
 * asked for (capped — the route's own deadline is not negotiable), and only
 * when the scan budget still has room for the delay AND a meaningful attempt.
 */
async function callWithOneRetry(
  provider: TextProvider,
  request: { imageJpegBase64: string; system: string; prompt: string; timeoutMs: number },
  deadline: number,
): Promise<string> {
  try {
    return await provider.read(request);
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.retryable) throw error;
    const delay = Math.min(error.retryAfterMs ?? 2_000, 5_000);
    const remainingAfterDelay = deadline - Date.now() - delay;
    if (remainingAfterDelay < MIN_CALL_MS) throw error;
    await new Promise((resolve) => setTimeout(resolve, delay));
    return provider.read({ ...request, timeoutMs: Math.min(request.timeoutMs, remainingAfterDelay) });
  }
}
