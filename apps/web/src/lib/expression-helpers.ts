// SPDX-License-Identifier: AGPL-3.0-only

export type HelperSuggestion = { label: string; insert: string; hint: string };

const TO_TEXT = { label: "toString()", insert: "toString()", hint: "turn into text" };
const TO_NUMBER = { label: "toNumber()", insert: "toNumber()", hint: "turn into a number" };
const TO_BOOLEAN = { label: "toBoolean()", insert: "toBoolean()", hint: "turn into true or false" };
const INCLUDES = { label: "includes(", insert: "includes(", hint: "has this value" };

/**
 * The expression helpers that fit a value, for the list after a dot. A value that is not known
 * yet (no sample data) gets the three conversions. The engine allows the same set.
 */
export function helpersFor(value: unknown): HelperSuggestion[] {
  if (value === undefined || value === null) return [TO_TEXT, TO_NUMBER, TO_BOOLEAN];
  if (typeof value === "string") return [TO_TEXT, TO_NUMBER, TO_BOOLEAN, INCLUDES];
  if (typeof value === "number" || typeof value === "boolean") {
    return [TO_TEXT, TO_NUMBER, TO_BOOLEAN];
  }
  if (Array.isArray(value)) return [TO_TEXT, INCLUDES];
  return [TO_TEXT];
}
