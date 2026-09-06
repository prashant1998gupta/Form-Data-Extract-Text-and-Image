/**
 * Two readings of the same page, reconciled.
 *
 * A vision model that cannot read a word does not say so — it writes a
 * plausible one, and the same photo yields a different plausible word on
 * the next call. Two calls therefore tell what one cannot: the fields where
 * the readings agree are as good as the model gets, and the fields where
 * they differ are exactly the ones a person must check. The first reading
 * is delivered; the second's word is shown beside a flagged field.
 */

import { checklistItems, fieldsOf, type FieldDefinition, type FormDefinition, type FormValues } from "../forms/definitions.ts";
import type { ParsedReading } from "./parse.ts";

export interface Uncertain {
  readonly key: string;
  /** What the other reading had — "" when it had the field blank. */
  readonly alternative: string;
}

export interface Reconciled {
  readonly readable: boolean;
  readonly values: FormValues;
  readonly unreadable: readonly string[];
  readonly notInOptions: readonly string[];
  readonly filled: number;
  readonly uncertain: readonly Uncertain[];
  /** The photograph's box and picture, from whichever reading gave one. */
  readonly photoBox: ParsedReading["photoBox"];
  readonly photoPicture: ParsedReading["photoPicture"];
}

/** One reading alone, in the reconciled shape. */
export function singleReading(reading: ParsedReading): Reconciled {
  return {
    readable: reading.readable,
    values: reading.values,
    unreadable: reading.unreadable,
    notInOptions: reading.notInOptions,
    filled: reading.filled,
    uncertain: [],
    photoBox: reading.photoBox,
    photoPicture: reading.photoPicture,
  };
}

export function reconcileReadings(first: ParsedReading, second: ParsedReading, form: FormDefinition): Reconciled {
  // A reading that saw no form at all says nothing against one that did.
  if (!first.readable) return singleReading(second);
  if (!second.readable) return singleReading(first);

  const values: Record<string, string> = {};
  const unreadable = new Set(first.unreadable);
  const notInOptions: string[] = [];
  const uncertain: Uncertain[] = [];
  for (const field of fieldsOf(form)) {
    const a = first.values[field.key] ?? "";
    const b = second.values[field.key] ?? "";
    if (sameReading(a, b, field)) {
      values[field.key] = a;
      if (first.notInOptions.includes(field.key)) notInOptions.push(field.key);
      continue;
    }
    if (a === "") {
      // Blank or unreadable once, read the other time: show the reading, say it stood alone.
      values[field.key] = b;
      unreadable.delete(field.key);
      if (second.notInOptions.includes(field.key)) notInOptions.push(field.key);
      uncertain.push({ key: field.key, alternative: "" });
    } else {
      values[field.key] = a;
      if (first.notInOptions.includes(field.key)) notInOptions.push(field.key);
      uncertain.push({ key: field.key, alternative: b });
    }
  }
  const filled = Object.values(values).filter((value) => value !== "").length;
  const withBox = first.photoBox ? first : second;
  return {
    readable: true,
    values,
    unreadable: [...unreadable],
    notInOptions,
    filled,
    uncertain,
    photoBox: withBox.photoBox,
    photoPicture: withBox.photoPicture,
  };
}

/** Equal for the purpose of "did the two readings agree": spacing, case and punctuation do not count. */
export function sameReading(a: string, b: string, field: FieldDefinition): boolean {
  if (field.kind === "phone" || field.kind === "number") return digits(a) === digits(b);
  if (field.kind === "checklist") {
    const itemsA = new Set(checklistItems(a).map(loose));
    const itemsB = new Set(checklistItems(b).map(loose));
    return itemsA.size === itemsB.size && [...itemsA].every((item) => itemsB.has(item));
  }
  return loose(a) === loose(b);
}

function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

function loose(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s.,;:'"`()\-_/]+/g, " ")
    .trim();
}
