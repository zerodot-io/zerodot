// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, MAX_QUERY_ROWS, type TableRow } from "@zerodot/engine";
import { z } from "zod";
import { readFilter, readSort, storeOf, tableRef } from "./table-common";

/** Without a limit the node reads all rows, up to this number. */
export const GET_ALL_MAX_ROWS = 10_000;

export default defineNode({
  type: "table.get_all",
  usableAsTool: true,
  label: "Get All Rows",
  description: "Read all rows of a table, or the rows that match a filter",
  category: "data",
  app: "Tables",
  icon: "TableIcon",
  config: z.object({
    table: tableRef,
    // { "field": "status", "op": "eq", "value": "new" }, or { "and": [...] } / { "or": [...] }
    filter: z.unknown().optional().meta({ ui: "filter" }),
    // [{ "field": "createdAt", "direction": "desc" }]
    sort: z.unknown().optional().meta({ ui: "sort" }),
    limit: z
      .number()
      .int()
      .min(1)
      .max(GET_ALL_MAX_ROWS)
      .optional()
      .meta({ description: "The most rows to return. Leave empty to return all rows" }),
  }),
  defaultConfig: { table: "" },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const store = storeOf(ctx);
    const filter = readFilter(ctx.config.filter);
    const sort = readSort(ctx.config.sort);
    // One more than the cap, so a table that is too big can be found.
    const wanted = ctx.config.limit ?? GET_ALL_MAX_ROWS + 1;
    const rows: TableRow[] = [];
    let cursor: string | null | undefined;
    while (rows.length < wanted) {
      const page = await store.query(ctx.config.table, {
        filter,
        sort,
        limit: Math.min(MAX_QUERY_ROWS, wanted - rows.length),
        cursor,
      });
      rows.push(...page.rows);
      cursor = page.nextCursor;
      if (!cursor || page.rows.length === 0) break;
    }
    if (ctx.config.limit === undefined && rows.length > GET_ALL_MAX_ROWS) {
      throw new Error(
        `The table has more than ${GET_ALL_MAX_ROWS} rows. Set a limit, or add a filter`,
      );
    }
    return { port: "out", data: { count: rows.length, rows } };
  },
});
