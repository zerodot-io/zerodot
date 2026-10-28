// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Filter,
  filterSchema,
  type NodeRunContext,
  type Sort,
  sortSchema,
  type TableStore,
} from "@zerodot/engine";
import { z } from "zod";

/** A table node config key that holds a table. The editor shows a table picker. */
export const tableRef = z
  .string()
  .min(1, "Pick a table")
  .meta({ ui: "table", description: "The id or the name of a data table" });

export const rowObject = z.record(z.string(), z.unknown());

export function storeOf(ctx: Pick<NodeRunContext<unknown>, "tables">): TableStore {
  if (!ctx.tables)
    throw new Error("Data tables cannot be used here: the worker has no table store");
  return ctx.tables;
}

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (typeof value === "object" && Object.keys(value).length === 0);

/** An empty filter means no filter. A filter that is not valid fails with a clear message. */
export function readFilter(value: unknown): Filter | undefined {
  if (isEmpty(value)) return undefined;
  const parsed = filterSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      'The filter is not valid. Use { "field": "name", "op": "eq", "value": "x" }, or { "and": [...] } or { "or": [...] }',
    );
  }
  return parsed.data;
}

export function readSort(value: unknown): Sort | undefined {
  if (isEmpty(value)) return undefined;
  const parsed = sortSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('The sort is not valid. Use [{ "field": "name", "direction": "asc" }]');
  }
  return parsed.data;
}

/** A list of row objects, or one row object. */
export function readRows(value: unknown): Record<string, unknown>[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((item, index) => {
    const parsed = rowObject.safeParse(item);
    if (!parsed.success) {
      throw new Error(
        list.length > 1 ? `Row ${index + 1} must be an object` : "A row must be an object",
      );
    }
    return parsed.data;
  });
}

export const numberRecord = z.record(z.string(), z.number());
