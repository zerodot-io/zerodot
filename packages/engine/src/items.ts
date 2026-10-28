// SPDX-License-Identifier: AGPL-3.0-only

/** One item of a node run: a plain object. */
export type Item = Record<string, unknown>;

export const isRecord = (value: unknown): value is Item =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The items of a node run. A list is the items. One object is one item. Null is one empty item. */
export function toItems(input: unknown): Item[] {
  if (Array.isArray(input)) return input.map((item) => (isRecord(item) ? item : { value: item }));
  if (isRecord(input)) return [input];
  if (input === null || input === undefined) return [{}];
  return [{ value: input }];
}
