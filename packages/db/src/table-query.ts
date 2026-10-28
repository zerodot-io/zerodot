// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Column,
  checkValue,
  type Filter,
  type FilterCondition,
  filterConditions,
  isCondition,
  MAX_IN_VALUES,
  type Sort,
  SYSTEM_FIELDS,
  TableError,
} from "@zerodot/engine";
import { type SQL, sql } from "drizzle-orm";

/** SQL for the filters and the sort of a row query. Rows use the alias `r`. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);
export const jsonb = (value: unknown): SQL => sql`${JSON.stringify(value)}::jsonb`;

const dataValue = (key: string): SQL => sql`(r.data -> ${key}::text)`;
const dataText = (key: string): SQL => sql`(r.data ->> ${key}::text)`;

type Target = { kind: "column"; column: Column } | { kind: "id" } | { kind: "time"; sql: SQL };

function targetOf(columns: readonly Column[], field: string): Target {
  if (field === "id") return { kind: "id" };
  if (field === "createdAt") return { kind: "time", sql: sql`r.created_at` };
  if (field === "updatedAt") return { kind: "time", sql: sql`r.updated_at` };
  const column = columns.find((c) => c.key === field);
  if (!column) throw new TableError(`Unknown column "${field}"`);
  return { kind: "column", column };
}

function checked(column: Column, value: unknown, field: string): unknown {
  const result = checkValue(column.type, value);
  if (!result.ok) throw new TableError(`Filter on "${field}": the value ${result.message}`);
  return result.value;
}

function isNullSql(key: string): SQL {
  return sql`(${dataValue(key)} is null or jsonb_typeof(${dataValue(key)}) = 'null')`;
}

function idValue(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) throw new TableError("An id must be a UUID");
  return value;
}

function timeValue(value: unknown, field: string): string {
  const result = checkValue("date", value);
  if (!result.ok) throw new TableError(`Filter on "${field}": the value ${result.message}`);
  return String(result.value);
}

function compileCondition(columns: readonly Column[], c: FilterCondition): SQL {
  const target = targetOf(columns, c.field);

  if (target.kind === "id") {
    const id = (v: unknown) => sql`${idValue(v)}::uuid`;
    switch (c.op) {
      case "eq":
        return sql`r.id = ${id(c.value)}`;
      case "neq":
        return sql`r.id <> ${id(c.value)}`;
      case "in": {
        const list = inList(c);
        return list.length === 0
          ? sql`false`
          : sql`r.id in (${sql.join(
              list.map((v) => id(v)),
              sql`, `,
            )})`;
      }
      default:
        throw new TableError(`The operator ${c.op} does not work on "id"`);
    }
  }

  if (target.kind === "time") {
    const when = (v: unknown) => sql`${timeValue(v, c.field)}::timestamptz`;
    const ops = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const;
    if (c.op in ops)
      return sql`${target.sql} ${sql.raw(ops[c.op as keyof typeof ops])} ${when(c.value)}`;
    throw new TableError(`The operator ${c.op} does not work on "${c.field}"`);
  }

  const { column } = target;
  const key = column.key;

  switch (c.op) {
    case "eq":
      if (c.value === null) return isNullSql(key);
      return sql`${dataValue(key)} = ${jsonb(checked(column, c.value, c.field))}`;
    case "neq":
      if (c.value === null) return sql`not ${isNullSql(key)}`;
      return sql`${dataValue(key)} is distinct from ${jsonb(checked(column, c.value, c.field))}`;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[c.op];
      const value = checked(column, c.value, c.field);
      if (column.type === "number") {
        return sql`(${dataText(key)})::numeric ${sql.raw(op)} ${String(value)}::numeric`;
      }
      if (column.type === "string" || column.type === "date") {
        return sql`${dataText(key)} collate "C" ${sql.raw(op)} ${String(value)}::text collate "C"`;
      }
      throw new TableError(`The operator ${c.op} does not work on a ${column.type} column`);
    }
    case "in": {
      const list = inList(c).map((v) => checked(column, v, c.field));
      if (list.length === 0) return sql`false`;
      return sql`${dataValue(key)} in (${sql.join(
        list.map((v) => jsonb(v)),
        sql`, `,
      )})`;
    }
    case "contains": {
      if (column.type === "string") {
        if (typeof c.value !== "string") {
          throw new TableError(`Filter on "${c.field}": the value must be a string`);
        }
        return sql`position(lower(${c.value}::text) in lower(${dataText(key)})) > 0`;
      }
      if (column.type === "json") {
        const value = checked(column, c.value, c.field);
        return sql`${dataValue(key)} @> ${jsonb(value)}`;
      }
      throw new TableError(`The operator contains does not work on a ${column.type} column`);
    }
    case "isNull":
      return c.value === false ? sql`not ${isNullSql(key)}` : isNullSql(key);
  }
}

function inList(c: FilterCondition): unknown[] {
  if (!Array.isArray(c.value)) throw new TableError(`Filter on "${c.field}": "in" needs a list`);
  if (c.value.length > MAX_IN_VALUES) {
    throw new TableError(`An "in" list can have ${MAX_IN_VALUES} values`);
  }
  return c.value;
}

function compile(columns: readonly Column[], filter: Filter): SQL {
  if (isCondition(filter)) return compileCondition(columns, filter);
  const children = "and" in filter ? filter.and : filter.or;
  const joiner = "and" in filter ? sql` and ` : sql` or `;
  return sql`(${sql.join(
    children.map((child) => compile(columns, child)),
    joiner,
  )})`;
}

/** Throws a TableError when the filter is too big, uses an unknown field, or has a wrong value. */
export function compileFilter(columns: readonly Column[], filter: Filter): SQL {
  filterConditions(filter);
  return compile(columns, filter);
}

/** `order by` parts. The last two make the order stable. */
export function compileSort(columns: readonly Column[], sort: Sort): SQL[] {
  const parts = sort.map(({ field, direction }) => {
    const dir = sql.raw(direction === "desc" ? "desc nulls last" : "asc nulls last");
    const target = targetOf(columns, field);
    if (target.kind === "id") return sql`r.id ${dir}`;
    if (target.kind === "time") return sql`${target.sql} ${dir}`;
    switch (target.column.type) {
      case "number":
        return sql`(${dataText(field)})::numeric ${dir}`;
      case "boolean":
        return sql`(${dataText(field)})::boolean ${dir}`;
      case "json":
        throw new TableError(`A json column cannot be sorted: "${field}"`);
      default:
        return sql`${dataText(field)} ${dir}`;
    }
  });
  return [...parts, sql`r.created_at asc`, sql`r.id asc`];
}

export const isSystemField = (field: string) =>
  (SYSTEM_FIELDS as readonly string[]).includes(field);
