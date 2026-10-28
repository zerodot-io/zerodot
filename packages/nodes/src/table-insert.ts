// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readRows, storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.insert",
  label: "Insert Rows",
  description: "Add new rows to a table",
  category: "data",
  app: "Tables",
  icon: "ListPlus",
  config: z.object({
    table: tableRef,
    // One row object, or a list of up to 1,000. Values can use expressions.
    rows: z.unknown().optional().meta({ ui: "fields", prefill: "columns" }),
  }),
  defaultConfig: { table: "", rows: {} },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const rows = await storeOf(ctx).insert(ctx.config.table, readRows(ctx.config.rows));
    return { port: "out", data: { count: rows.length, rows } };
  },
});
