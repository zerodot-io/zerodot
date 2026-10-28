// SPDX-License-Identifier: AGPL-3.0-only

import { createServerFn } from "@tanstack/react-start";
import {
  type Column,
  filterSchema,
  MAX_INSERT_ROWS,
  rowQuerySchema,
  TableError,
} from "@zerodot/engine";
import { z } from "zod";
import { asJson, type Json } from "../lib/json";
import { projectFor } from "./settings-fns";

const slugInput = z.object({ projectSlug: z.string().min(1) });
const tableInput = slugInput.extend({ tableId: z.string().uuid() });

/** What the browser gets for a table. */
export type TableSummary = {
  id: string;
  name: string;
  description: string;
  columns: ColumnJson[];
  rowCount: number;
};
export type ColumnJson = {
  key: string;
  type: Column["type"];
  required: boolean;
  unique: boolean;
  default?: Json;
};
export type RowJson = { id: string; createdAt: string; updatedAt: string; [key: string]: Json };

function summary(t: {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  rowCount: number;
}): TableSummary {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    columns: asJson(t.columns) as unknown as ColumnJson[],
    rowCount: t.rowCount,
  };
}

/** A problem the user can fix reaches the browser as an error message. */
async function friendly<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const { ConflictError } = await import("@zerodot/db");
    if (error instanceof TableError || error instanceof ConflictError) {
      throw new Error(error.message);
    }
    throw error;
  }
}

const SCHEMA_ADMIN = { admin: true } as const;

export const listTablesFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return (await ctx.scope.tables.list()).map(summary);
  });

export const getTableFn = createServerFn({ method: "GET" })
  .validator(tableInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const table = await ctx.scope.tables.get(data.tableId);
    if (!table) throw new Error("Not found");
    return summary(table);
  });

// Rows can be changed by any member. The shape of a table (create, columns, delete) is for admins.

export const createTableFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      name: z.string(),
      description: z.string().max(500).default(""),
      columns: z.array(z.unknown()),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, SCHEMA_ADMIN);
    return summary(
      await friendly(
        ctx.scope.tables.create({
          name: data.name,
          description: data.description,
          columns: data.columns,
        }),
      ),
    );
  });

export const renameTableFn = createServerFn({ method: "POST" })
  .validator(tableInput.extend({ name: z.string(), description: z.string().max(500).optional() }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, SCHEMA_ADMIN);
    const table = await friendly(
      ctx.scope.tables.update(data.tableId, { name: data.name, description: data.description }),
    );
    if (!table) throw new Error("Not found");
    return summary(table);
  });

const alterOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), column: z.unknown() }),
  z.object({ op: z.literal("rename"), key: z.string(), to: z.string() }),
  z.object({
    op: z.literal("retype"),
    key: z.string(),
    type: z.enum(["string", "number", "boolean", "date", "json"]),
  }),
  z.object({ op: z.literal("drop"), key: z.string() }),
]);

export const alterTableFn = createServerFn({ method: "POST" })
  .validator(tableInput.extend({ ops: z.array(alterOp).min(1).max(20) }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, SCHEMA_ADMIN);
    return summary(await friendly(ctx.scope.tables.alter(data.tableId, data.ops)));
  });

export const deleteTableFn = createServerFn({ method: "POST" })
  .validator(tableInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, SCHEMA_ADMIN);
    return { deleted: await ctx.scope.tables.remove(data.tableId) };
  });

export const queryRowsFn = createServerFn({ method: "POST" })
  .validator(tableInput.extend({ query: rowQuerySchema }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const page = await friendly(ctx.scope.tables.queryRows(data.tableId, data.query));
    return { rows: asJson(page.rows) as unknown as RowJson[], nextCursor: page.nextCursor };
  });

export const insertRowsFn = createServerFn({ method: "POST" })
  .validator(
    tableInput.extend({ rows: z.array(z.record(z.string(), z.unknown())).max(MAX_INSERT_ROWS) }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const rows = await friendly(ctx.scope.tables.insertRows(data.tableId, data.rows));
    return { count: rows.length };
  });

export const updateRowFn = createServerFn({ method: "POST" })
  .validator(
    tableInput.extend({ rowId: z.string().uuid(), set: z.record(z.string(), z.unknown()) }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const result = await friendly(
      ctx.scope.tables.updateRows(data.tableId, {
        filter: { field: "id", op: "eq", value: data.rowId },
        set: data.set,
      }),
    );
    const row = result.rows[0];
    if (!row) throw new Error("The row does not exist any more");
    return asJson(row) as unknown as RowJson;
  });

export const deleteRowsFn = createServerFn({ method: "POST" })
  .validator(tableInput.extend({ ids: z.array(z.string().uuid()).min(1).max(100) }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return friendly(
      ctx.scope.tables.deleteRows(data.tableId, {
        filter: filterSchema.parse({ field: "id", op: "in", value: data.ids }),
      }),
    );
  });
