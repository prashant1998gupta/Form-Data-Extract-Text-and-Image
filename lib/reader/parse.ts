/**
 * The reply-side trust boundary.
 *
 * A model's reply is untrusted input exactly the way a browser-supplied
 * template is (`lib/templates/custom.ts`): parse, do not cast, and let nothing
 * through that the closed contract does not name. The contract is one JSON
 * object with one member, `value`, holding a string or null — everything else
 * in the reply is discarded without comment, because an extra member is not an
 * extension, it is a reply that did not follow the contract.
 *
 * Values are clamped and cleaned here rather than at render time, so no later
 * consumer has to remember to. The clamp lengths are generous for real form
 * answers and exist for the same reason the template parser bounds fields: a
 * reply is one request away from being 10 MB of text, and this runs on a
 * shared serverless function.
 */

import type { FormField } from "../templates/types.ts";

/** Longest credible handwritten answer, by field shape. */
const MAX_VALUE_CHARS = 300;
const MAX_LONG_VALUE_CHARS = 1000;
const LONG_TYPES: readonly FormField["type"][] = ["longText", "address"];

export interface ParsedReading {
  readonly value: string | null;
  readonly blank: boolean;
  readonly notInOptions?: boolean;
  /** Present when the reply violated the contract. Operator-readable. */
  readonly problem?: string;
}

/**
 * Parses one model reply against one field.
 *
 * Returns rather than throws: a malformed reply is an expected outcome to
 * present ("the reader's answer could not be used"), not an exception to
 * crash a scan over.
 */
export function parseReading(raw: string, field: FormField): ParsedReading {
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return { value: null, blank: false, problem: "the reader's reply was not in the agreed format" };
  }

  if (!("value" in parsed)) {
    return { value: null, blank: false, problem: "the reader's reply did not carry a value" };
  }

  const rawValue: unknown = parsed.value;

  if (rawValue === null) {
    // The model examined the crop and declined to guess. A successful call.
    return { value: null, blank: false };
  }

  // Numbers and booleans are accepted and stringified: a model replying
  // {"value": 42} for an age field followed the spirit of the contract, and
  // refusing it would report a readable answer as unreadable. Objects and
  // arrays are not values by any reading.
  let text: string;
  if (typeof rawValue === "string") text = rawValue;
  else if (typeof rawValue === "number" && Number.isFinite(rawValue)) text = String(rawValue);
  else if (typeof rawValue === "boolean") text = String(rawValue);
  else {
    return { value: null, blank: false, problem: "the reader's reply was not readable text" };
  }

  text = clean(text, LONG_TYPES.includes(field.type));

  if (text === "") {
    // An asserted empty: the model looked and says nothing is written there.
    return { value: "", blank: true };
  }

  if (field.options && field.options.length > 0) {
    const matched = matchOption(text, field.options);
    if (matched !== null) return { value: matched, blank: false };
    // Keep what the paper says and flag the mismatch. Snapping to the nearest
    // option would silently replace a measurement with a guess.
    return { value: text, blank: false, notInOptions: true };
  }

  return { value: text, blank: false };
}

/**
 * Extracts the JSON object from a reply.
 *
 * JSON mode makes the fence-stripping path rare, but "rare" is not "never" —
 * a provider fallback model, or a future provider without JSON mode, answers
 * in markdown fences, and losing every reading over punctuation would be a
 * poor trade. The recovery is bounded: first `{` to last `}`, one attempt.
 */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const attempts = [raw.trim()];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) attempts.push(raw.slice(start, end + 1));

  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to the next attempt
    }
  }
  return null;
}

/**
 * Normalises a transcription for display and comparison.
 *
 * Control characters are removed because no pen produces one. Newlines are
 * kept only for the field shapes that plausibly span lines; everywhere else a
 * newline is the model wrapping text, not the writer meaning one.
 */
function clean(text: string, multiline: boolean): string {
  // Everything below 0x20 except tab and newline, plus DEL. Carriage returns
  // fold into the whitespace collapse on the next line.
  // eslint-disable-next-line no-control-regex
  let value = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  value = multiline ? value.replace(/[ \t\r]+/g, " ") : value.replace(/\s+/g, " ");
  value = value.trim();
  const cap = multiline ? MAX_LONG_VALUE_CHARS : MAX_VALUE_CHARS;
  return value.length > cap ? value.slice(0, cap) : value;
}

/**
 * Matches a transcription against declared options, forgiving case and
 * spacing but nothing else. "b+" may become "B+"; "B" must NOT become "B+",
 * because the missing stroke is exactly the difference that matters.
 */
function matchOption(value: string, options: readonly string[]): string | null {
  // All whitespace is removed for the comparison, not just collapsed: "AB -"
  // and "AB-" are the same mark on paper. Characters are never forgiven.
  const canon = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = canon(value);
  for (const option of options) {
    if (canon(option) === target) return option;
  }
  return null;
}
