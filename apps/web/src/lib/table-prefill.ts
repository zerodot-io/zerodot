// SPDX-License-Identifier: AGPL-3.0-only

/** The columns of a table that matter for the node form. */
export type PrefillColumn = { key: string; unique: boolean };

/**
 * Puts the columns of a table in a row as keys with empty values.
 * Keys that have a value stay. An empty key of the old table that the new table does not have goes.
 * A list of rows stays as it is.
 */
export function prefillRow(
  current: unknown,
  oldColumns: PrefillColumn[],
  newColumns: PrefillColumn[],
): Record<string, unknown> | undefined {
  if (Array.isArray(current)) return undefined;
  const row: Record<string, unknown> =
    typeof current === "object" && current !== null ? { ...current } : {};
  const next = new Set(newColumns.map((c) => c.key));
  for (const { key } of oldColumns) {
    if (!next.has(key) && row[key] === "") delete row[key];
  }
  for (const { key } of newColumns) {
    if (!(key in row)) row[key] = "";
  }
  return row;
}

/** The columns a column picker offers. `id` first when it is allowed. */
export function columnOptions(
  columns: PrefillColumn[],
  kind: "unique" | "all",
  idOption: boolean,
): string[] {
  const keys = columns.filter((c) => kind === "all" || c.unique).map((c) => c.key);
  return idOption ? ["id", ...keys] : keys;
}
