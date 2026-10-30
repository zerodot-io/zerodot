// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, MAX_QUERY_ROWS } from "@zerodot/engine";
import { z } from "zod";
import { readFilter, readSort, storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.query",
  label: "Query Rows",
  description: "Read rows from a table with filters and sort",
  category: "data",
  app: "Tables",
  icon: "TableIcon",
  config: z.object({
    table: tableRef,
    // { "field": "status", "op": "eq", "value": "new" }, or { "and": [...] } / { "or": [...] }
    filter: z.unknown().optional().meta({ ui: "filter" }),
    // [{ "field": "createdAt", "direction": "desc" }]
    sort: z.unknown().optional().meta({ ui: "sort" }),
    limit: z.number().int().min(1).max(MAX_QUERY_ROWS).default(100),
    // The `nextCursor` of an earlier query.
    cursor: z.string().optional(),
  }),
  defaultConfig: { table: "", limit: 100 },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const { rows, nextCursor } = await storeOf(ctx).query(ctx.config.table, {
      filter: readFilter(ctx.config.filter),
      sort: readSort(ctx.config.sort),
      limit: ctx.config.limit,
      cursor: ctx.config.cursor,
    });
    return { port: "out", data: { count: rows.length, rows, nextCursor } };
  },
});
