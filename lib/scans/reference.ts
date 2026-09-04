/**
 * A human-facing reference for a saved scan, e.g. `SCH-4F2A19`.
 *
 * Random rather than sequential: a sequential number on a receipt tells a
 * stranger how many people were seen this week and lets anyone guess the
 * neighbouring record. The alphabet drops I, L, O and U, which are misread on
 * paper and over the phone.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newReference(prefix: string, random: () => number = Math.random): string {
  let suffix = "";
  for (let i = 0; i < 6; i += 1) {
    suffix += ALPHABET[Math.floor(random() * ALPHABET.length)];
  }
  return `${prefix}-${suffix}`;
}

export function isReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2,5}-[0-9A-HJKMNP-TV-Z]{6}$/.test(value);
}
