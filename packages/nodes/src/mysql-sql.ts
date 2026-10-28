// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers of the MySQL node. They build SQL text and values. Nothing here connects.
import type { Param, SortRule, WhereClause } from "./postgres-sql";

export type MysqlQuery = { query: string; values: Param[] };

/** A name of a table or column, quoted with backticks. A backtick doubles. */
export const quoteIdent = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

/** `table`, or `database.table`. */
export const qualifiedTable = (table: string, database?: string): string =>
  database ? `${quoteIdent(database)}.${quoteIdent(table)}` : quoteIdent(table);

/** A value for a `?` mark. Objects become JSON text. */
export function toMysqlParam(value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString().slice(0, 23).replace("T", " ");
  return JSON.stringify(value);
}

/**
 * Adds ` WHERE ...` with `?` marks. A numeric value for `>`, `<`, `>=`, `<=` is a number. A
 * column name is quoted. The condition was checked against a fixed list by `readWhereClauses`.
 */
export function addWhere(
  query: string,
  clauses: WhereClause[],
  values: Param[],
  combine: string,
): MysqlQuery {
  if (clauses.length === 0) return { query, values };
  const joiner = combine === "OR" ? "OR" : "AND";
  const params = [...values];
  const parts = clauses.map((clause) => {
    const condition = clause.condition === "equal" ? "=" : clause.condition;
    const column = quoteIdent(clause.column);
    if (condition === "IS NULL" || condition === "IS NOT NULL") return `${column} ${condition}`;
    let value = clause.value;
    if ([">", "<", ">=", "<="].includes(condition)) {
      const numeric = Number(value);
      if (String(value).trim() !== "" && !Number.isNaN(numeric)) value = numeric;
    }
    params.push(toMysqlParam(value));
    return `${column} ${condition} ?`;
  });
  return { query: `${query} WHERE ${parts.join(` ${joiner} `)}`, values: params };
}

export function addOrderBy(query: string, rules: SortRule[]): string {
  if (rules.length === 0) return query;
  const parts = rules.map(
    (rule) => `${quoteIdent(rule.column)} ${rule.direction === "DESC" ? "DESC" : "ASC"}`,
  );
  return `${query} ORDER BY ${parts.join(", ")}`;
}

/** `INSERT INTO t (a, b) VALUES (?, ?)`. With `ignore`: `INSERT IGNORE`. */
export function buildInsert(
  table: string,
  row: Record<string, unknown>,
  options: { ignore?: boolean } = {},
): MysqlQuery {
  const keys = Object.keys(row);
  const verb = options.ignore ? "INSERT IGNORE INTO" : "INSERT INTO";
  if (keys.length === 0) return { query: `${verb} ${table} () VALUES ()`, values: [] };
  return {
    query: `${verb} ${table} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    values: keys.map((key) => toMysqlParam(row[key])),
  };
}

/**
 * Insert, and update the row when a primary key or unique key matches. The update sets every
 * column of the item.
 */
export function buildUpsert(table: string, row: Record<string, unknown>): MysqlQuery {
  const keys = Object.keys(row);
  if (keys.length === 0) throw new Error("The item has no values to insert or update");
  const updates = keys.map((key) => `${quoteIdent(key)} = VALUES(${quoteIdent(key)})`);
  return {
    query: `INSERT INTO ${table} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) ON DUPLICATE KEY UPDATE ${updates.join(", ")}`,
    values: keys.map((key) => toMysqlParam(row[key])),
  };
}

/** `UPDATE t SET a = ? WHERE m = ?`. The matching columns are in the WHERE, not in the SET. */
export function buildUpdate(
  table: string,
  row: Record<string, unknown>,
  matching: string[],
): MysqlQuery {
  if (matching.length === 0) throw new Error("Pick the columns to match on");
  const missing = matching.filter((column) => !(column in row));
  if (missing.length > 0) {
    throw new Error(`The item has no value for the match column "${missing[0]}"`);
  }
  const setColumns = Object.keys(row).filter((key) => !matching.includes(key));
  if (setColumns.length === 0) {
    throw new Error(
      "Add values to update to the input item, or set the 'Data Mode' to 'Map Each Column Manually'.",
    );
  }
  return {
    query: `UPDATE ${table} SET ${setColumns.map((key) => `${quoteIdent(key)} = ?`).join(", ")} WHERE ${matching.map((key) => `${quoteIdent(key)} = ?`).join(" AND ")}`,
    values: [...setColumns, ...matching].map((key) => toMysqlParam(row[key])),
  };
}
