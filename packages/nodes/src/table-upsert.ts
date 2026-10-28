// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { numberRecord, rowObject, storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.upsert",
  label: "Upsert Row",
  description: "Update a row if it exists, else insert it",
  category: "data",
  app: "Tables",
  icon: "Replace",
  config: z.object({
    table: tableRef,
    // The key of a unique column. The value comes from `row`.
    column: z.string().min(1).meta({
      ui: "table-column",
      columns: "unique",
      description: "A unique column. The value comes from the row",
    }),
    row: rowObject.meta({ ui: "fields", prefill: "columns" }),
    increment: numberRecord.optional(),
  }),
  defaultConfig: { table: "", column: "", row: {} },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const { row, created } = await storeOf(ctx).upsert(ctx.config.table, {
      column: ctx.config.column,
      row: ctx.config.row,
      increment: ctx.config.increment,
    });
    return { port: "out", data: { created, row } };
  },
});
