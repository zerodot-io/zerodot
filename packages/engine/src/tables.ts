// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

export const COLUMN_TYPES = ["string", "number", "boolean", "date", "json"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export const MAX_TABLES = 100;
export const MAX_COLUMNS = 20;
export const MAX_ROW_BYTES = 64 * 1024;
export const MAX_QUERY_ROWS = 1000;
export const MAX_INSERT_ROWS = 1000;
export const DEFAULT_TABLE_MAX_ROWS = 100_000;

export const COLUMN_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Every row has these. A column cannot use these keys. */
export const SYSTEM_FIELDS = ["id", "createdAt", "updatedAt"] as const;
export type SystemField = (typeof SYSTEM_FIELDS)[number];

export type Column = {
  key: string;
  type: ColumnType;
  required: boolean;
  unique: boolean;
  default?: unknown;
};

/** A row as workflows see it: the system fields, then the columns. A missing value is null. */
export type TableRow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  [column: string]: unknown;
};

// ---- Column schema ----

export const columnKeySchema = z
  .string()
  .max(64)
  .regex(COLUMN_KEY_PATTERN, "Use letters, digits, and _. Do not start with a digit.")
  .refine((key) => !(SYSTEM_FIELDS as readonly string[]).includes(key), {
    message: "id, createdAt, and updatedAt are reserved",
  });

export const columnSchema = z
  .object({
    key: columnKeySchema,
    type: z.enum(COLUMN_TYPES),
    required: z.boolean().default(false),
    unique: z.boolean().default(false),
    default: z.unknown().optional(),
  })
  .superRefine((column, ctx) => {
    if (column.unique && column.type === "json") {
      ctx.addIssue({ code: "custom", message: "A json column cannot be unique", path: ["unique"] });
    }
    if (column.default !== undefined && column.default !== null) {
      const checked = checkValue(column.type, column.default);
      if (!checked.ok) {
        ctx.addIssue({ code: "custom", message: checked.message, path: ["default"] });
      }
    }
    if (column.unique && column.default !== undefined && column.default !== null) {
      ctx.addIssue({
        code: "custom",
        message: "A unique column cannot have a default",
        path: ["default"],
      });
    }
  });

export const columnsSchema = z
  .array(columnSchema)
  .max(MAX_COLUMNS, `A table can have ${MAX_COLUMNS} columns`)
  .superRefine((columns, ctx) => {
    const seen = new Set<string>();
    for (const [index, column] of columns.entries()) {
      if (seen.has(column.key)) {
        ctx.addIssue({
          code: "custom",
          message: `Column "${column.key}" is listed twice`,
          path: [index, "key"],
        });
      }
      seen.add(column.key);
    }
  });

export const tableNameSchema = z.string().trim().min(1).max(80);

// ---- Values and rows ----

type Checked = { ok: true; value: unknown } | { ok: false; message: string };

/** ISO 8601 text, as `Date.prototype.toISOString` writes it. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

function isJson(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      return Array.isArray(value)
        ? value.every((item) => isJson(item, depth + 1))
        : Object.values(value as object).every((item) => isJson(item, depth + 1));
    default:
      return false;
  }
}

/** Checks one non-null value against a column type. A date is stored as an ISO text in UTC. */
export function checkValue(type: ColumnType, value: unknown): Checked {
  switch (type) {
    case "string":
      return typeof value === "string"
        ? { ok: true, value }
        : { ok: false, message: "must be a string" };
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true, value }
        : { ok: false, message: "must be a number" };
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true, value }
        : { ok: false, message: "must be true or false" };
    case "date": {
      if (typeof value !== "string" && !(value instanceof Date) && typeof value !== "number") {
        return { ok: false, message: "must be a date" };
      }
      const time = new Date(value).getTime();
      if (Number.isNaN(time)) return { ok: false, message: "must be a date" };
      return { ok: true, value: new Date(time).toISOString() };
    }
    case "json":
      return isJson(value) ? { ok: true, value } : { ok: false, message: "must be JSON" };
  }
}

export type CheckedRow =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Checks the values of a row against the columns. Returns the data to store: normalized,
 * without nulls. A wrong type names the column in the message.
 *
 * - `insert`: defaults fill the missing columns, and a required column needs a value.
 * - `patch`: only the given columns are checked. A required column cannot be set to null.
 *   A `null` is kept in the result, so the writer knows to clear that column.
 */
export function checkRow(
  columns: readonly Column[],
  input: unknown,
  mode: "insert" | "patch",
): CheckedRow {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "A row must be an object" };
  }
  const given = input as Record<string, unknown>;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  for (const key of Object.keys(given)) {
    if (!byKey.has(key)) return { ok: false, message: `Unknown column "${key}"` };
  }
  const data: Record<string, unknown> = {};
  for (const column of columns) {
    let value = given[column.key];
    if (mode === "insert" && value === undefined) value = column.default;
    if (value === undefined) {
      if (mode === "insert" && column.required) {
        return { ok: false, message: `Column "${column.key}" is required` };
      }
      continue;
    }
    if (value === null) {
      if (column.required) return { ok: false, message: `Column "${column.key}" is required` };
      if (mode === "patch") data[column.key] = null;
      continue;
    }
    const checked = checkValue(column.type, value);
    if (!checked.ok) return { ok: false, message: `Column "${column.key}" ${checked.message}` };
    data[column.key] = checked.value;
  }
  const size = new TextEncoder().encode(JSON.stringify(data)).length;
  if (size > MAX_ROW_BYTES) return { ok: false, message: "A row cannot be larger than 64 KB" };
  return { ok: true, data };
}

// ---- Filters ----

export const FILTER_OPS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
  "isNull",
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const MAX_FILTER_DEPTH = 4;
export const MAX_FILTER_CONDITIONS = 20;
export const MAX_IN_VALUES = 100;

export type FilterCondition = { field: string; op: FilterOp; value?: unknown };
export type Filter = FilterCondition | { and: Filter[] } | { or: Filter[] };

const conditionSchema = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(FILTER_OPS),
  value: z.unknown().optional(),
});

/** A condition, or `{ and: [...] }`, or `{ or: [...] }`. No raw SQL. */
export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(filterSchema).min(1).max(MAX_FILTER_CONDITIONS) }),
    z.object({ or: z.array(filterSchema).min(1).max(MAX_FILTER_CONDITIONS) }),
    conditionSchema,
  ]),
);

export function isCondition(filter: Filter): filter is FilterCondition {
  return "field" in filter;
}

/** Flatten a filter into its conditions, and check the depth and the count. */
export function filterConditions(filter: Filter, depth = 1): FilterCondition[] {
  if (depth > MAX_FILTER_DEPTH) throw new Error(`A filter can have ${MAX_FILTER_DEPTH} levels`);
  if (isCondition(filter)) return [filter];
  const children = "and" in filter ? filter.and : filter.or;
  const all = children.flatMap((child) => filterConditions(child, depth + 1));
  if (all.length > MAX_FILTER_CONDITIONS) {
    throw new Error(`A filter can have ${MAX_FILTER_CONDITIONS} conditions`);
  }
  return all;
}

export const sortSchema = z
  .array(
    z.object({
      field: z.string().min(1).max(64),
      direction: z.enum(["asc", "desc"]).default("asc"),
    }),
  )
  .max(3);
export type Sort = z.output<typeof sortSchema>;

export type RowQuery = {
  filter?: Filter;
  sort?: Sort;
  limit?: number;
  cursor?: string | null;
};
export type RowPage = { rows: TableRow[]; nextCursor: string | null };

export const rowQuerySchema = z.object({
  filter: filterSchema.optional(),
  sort: sortSchema.optional(),
  limit: z.number().int().min(1).max(MAX_QUERY_ROWS).default(100),
  cursor: z.string().max(512).nullish(),
});

// ---- Store ----

export type UpdateInput = {
  filter?: Filter;
  /** Needed when there is no filter. */
  all?: boolean;
  set?: Record<string, unknown>;
  /** Adds to number columns. The database does it in one statement. */
  increment?: Record<string, number>;
};

export type UpsertInput = {
  /** A unique column. The value comes from `row`. */
  column: string;
  row: Record<string, unknown>;
  increment?: Record<string, number>;
};

/**
 * What the table nodes use. The database package implements it.
 * `table` is the id or the name of a table.
 */
export type TableStore = {
  insert(table: string, rows: Record<string, unknown>[]): Promise<TableRow[]>;
  query(table: string, query: RowQuery): Promise<RowPage>;
  get(table: string, by: { field: string; value: unknown }): Promise<TableRow | null>;
  /** `rows` holds up to 100 of the changed rows. `count` is the total. */
  update(table: string, input: UpdateInput): Promise<{ count: number; rows: TableRow[] }>;
  upsert(table: string, input: UpsertInput): Promise<{ row: TableRow; created: boolean }>;
  delete(table: string, input: { filter?: Filter; all?: boolean }): Promise<{ count: number }>;
};

/** A table problem the user can fix (unknown table, wrong type, limit). Not a crash. */
export class TableError extends Error {
  override readonly name = "TableError";
}
