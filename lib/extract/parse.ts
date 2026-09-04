/**
 * The model's reply, turned into the form's values — or refused.
 *
 * Nothing here trusts the reply's shape. The JSON may be fenced, the fields
 * may be nested under "fields" or not, a checklist may come back as an array,
 * a string or an object of booleans, and any key the form does not declare is
 * dropped. What comes out has exactly the form's keys, every value a cleaned
 * string, with the keys the model could not read listed separately so the
 * screen can send the person back to the paper for those.
 */

import {
  checklistItems,
  fieldsOf,
  joinChecklist,
  type FieldDefinition,
  type FormDefinition,
  type FormValues,
} from "../forms/definitions.ts";

export interface ParsedReading {
  /** False when the model said the image is not a readable copy of this form. */
  readonly readable: boolean;
  /** Every key of the form; "" for blank and for unreadable. */
  readonly values: FormValues;
  /** Keys the model returned null for — writing it could not read with fair certainty. */
  readonly unreadable: readonly string[];
  /** Choice keys whose value is not one of the printed options. Kept as written. */
  readonly notInOptions: readonly string[];
  /** How many values are non-empty. */
  readonly filled: number;
  /**
   * Where the reader saw the pasted photograph: four numbers, x1 y1 x2 y2, in
   * whatever scale the model used (the prompt asks for thousandths of the
   * image). Null when it saw none or answered in a shape that is not a box.
   */
  readonly photoBox: readonly [number, number, number, number] | null;
}

export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyFormatError";
  }
}

const MAX_VALUE_LENGTH = 2000;

export function parseReaderReply(text: string, form: FormDefinition): ParsedReading {
  const object = extractObject(text);
  const readable = object.readable !== false;
  const source = isRecord(object.fields) ? object.fields : object;

  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  const notInOptions: string[] = [];

  for (const field of fieldsOf(form)) {
    if (!readable) {
      values[field.key] = "";
      continue;
    }
    const raw = source[field.key];
    if (raw === null) {
      values[field.key] = "";
      unreadable.push(field.key);
      continue;
    }
    const coerced = coerce(raw, field);
    if (coerced === null) {
      values[field.key] = "";
      unreadable.push(field.key);
      continue;
    }
    if ((field.kind === "choice" || field.kind === "yesno") && coerced !== "" && !matchesOption(coerced, field)) {
      notInOptions.push(field.key);
    }
    values[field.key] = coerced;
  }

  const filled = Object.values(values).filter((value) => value !== "").length;
  const photoBox = readable ? parseBox(object.photo ?? object.photoBox ?? object.photo_box ?? source.photo) : null;
  return { readable, values, unreadable, notInOptions, filled, photoBox };
}

/**
 * A bounding box in any of the shapes a model reaches for: `[x1, y1, x2, y2]`,
 * `{x1, y1, x2, y2}`, `{left, top, right, bottom}`, `{x, y, width, height}`,
 * Qwen's `{bbox_2d: [...]}`, or any of those as a string. Anything else is no
 * box — never a guess.
 */
export function parseBox(raw: unknown): readonly [number, number, number, number] | null {
  if (raw === null || raw === undefined || raw === "" || raw === false) return null;
  if (typeof raw === "string") {
    try {
      return parseBox(JSON.parse(raw));
    } catch {
      const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      return numbers && numbers.length === 4 ? asBox(numbers) : null;
    }
  }
  if (Array.isArray(raw)) return raw.length === 4 ? asBox(raw.map(Number)) : null;
  if (!isRecord(raw)) return null;
  for (const nested of ["bbox_2d", "bbox", "box", "photo"]) {
    if (nested in raw) return parseBox(raw[nested]);
  }
  const n = (key: string) => (typeof raw[key] === "number" || typeof raw[key] === "string" ? Number(raw[key]) : Number.NaN);
  if ("x1" in raw) return asBox([n("x1"), n("y1"), n("x2"), n("y2")]);
  if ("left" in raw) return asBox([n("left"), n("top"), n("right"), n("bottom")]);
  if ("x" in raw) {
    const width = "width" in raw ? n("width") : n("w");
    const height = "height" in raw ? n("height") : n("h");
    return asBox([n("x"), n("y"), n("x") + width, n("y") + height]);
  }
  return null;
}

function asBox(numbers: number[]): readonly [number, number, number, number] | null {
  if (numbers.length !== 4 || numbers.some((value) => !Number.isFinite(value))) return null;
  return [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!];
}

/**
 * The JSON object in the reply. JSON mode makes a bare object the normal
 * case; the fence-stripping and brace-hunting cover a model that talks first.
 */
function extractObject(text: string): Record<string, unknown> {
  const candidates = [text.trim(), text.replace(/```(?:json)?/gi, "").trim()];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next, looser reading.
    }
  }
  throw new ReplyFormatError("the reader's reply was not the agreed JSON object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One raw reply value into one stored string, or null for "could not read". */
function coerce(raw: unknown, field: FieldDefinition): string | null {
  if (raw === undefined) return "";
  if (field.kind === "checklist") return coerceChecklist(raw, field);
  if (field.kind === "yesno") return coerceYesNo(raw);
  if (field.kind === "choice") {
    const text = scalarText(raw, field);
    if (text === null) return null;
    return canonicalOption(text, field) ?? text;
  }
  return scalarText(raw, field);
}

function scalarText(raw: unknown, field: FieldDefinition): string | null {
  if (typeof raw === "string") return clean(raw, field.kind === "multiline");
  if (typeof raw === "number" || typeof raw === "bigint") return String(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (Array.isArray(raw)) {
    const parts = raw.map((item) => scalarText(item, field)).filter((part): part is string => part !== null && part !== "");
    return clean(parts.join(", "), field.kind === "multiline");
  }
  // An object where a string belongs is a shape the model was never asked
  // for; treating it as unreadable sends the person to the paper rather than
  // saving a JSON fragment as somebody's name.
  return null;
}

function coerceYesNo(raw: unknown): string | null {
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (typeof raw !== "string" && typeof raw !== "number") return raw === undefined ? "" : null;
  const text = clean(String(raw), false);
  const key = normalise(text);
  if (key === "") return "";
  if (["yes", "y", "true", "ticked", "checked", "1"].includes(key)) return "Yes";
  if (["no", "n", "false", "unticked", "unchecked", "0"].includes(key)) return "No";
  return text;
}

function coerceChecklist(raw: unknown, field: FieldDefinition): string | null {
  let items: string[];
  if (Array.isArray(raw)) {
    items = raw.filter((item): item is string => typeof item === "string");
  } else if (typeof raw === "string") {
    items = checklistItems(raw.replace(/[;\n]/g, ","));
  } else if (isRecord(raw)) {
    // {"Birth Certificate": true, ...} — the other shape a model reaches for.
    items = Object.entries(raw)
      .filter(([, ticked]) => ticked === true || ticked === "Yes" || ticked === "yes")
      .map(([name]) => name);
  } else if (raw === undefined) {
    return "";
  } else {
    return null;
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const text = clean(item, false);
    if (!text) continue;
    const canonical = canonicalOption(text, field) ?? text;
    const key = normalise(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return joinChecklist(out);
}

function matchesOption(value: string, field: FieldDefinition): boolean {
  const options = field.kind === "yesno" ? ["Yes", "No"] : (field.options ?? []);
  return options.some((option) => normalise(option) === normalise(value));
}

/** The printed spelling of an option the model may have written loosely. */
function canonicalOption(value: string, field: FieldDefinition): string | null {
  const key = normalise(value);
  for (const option of field.options ?? []) {
    if (normalise(option) === key) return option;
  }
  return null;
}

/** Case, spacing and punctuation-insensitive comparison key. */
function normalise(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Drops control characters other than line breaks. */
function stripControl(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 10 || (code >= 32 && code !== 127)) out += character;
  }
  return out;
}

/**
 * Whitespace and control characters tidied, length clamped. A single-line
 * field folds its line breaks into commas rather than losing what was after
 * them.
 */
function clean(value: string, multiline: boolean): string {
  const lines = stripControl(value.replace(/\r\n?/g, "\n"))
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.join(multiline ? "\n" : ", ");
  return text.length > MAX_VALUE_LENGTH ? text.slice(0, MAX_VALUE_LENGTH) : text;
}
