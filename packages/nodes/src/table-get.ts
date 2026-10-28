// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.get",
  label: "Get Row",
  description: "Read one row from a table by ID",
  category: "data",
  app: "Tables",
  icon: "Search",
  config: z.object({
    table: tableRef,
    by: z.string().min(1).default("id").meta({
      ui: "table-column",
      columns: "unique",
      idOption: true,
      description: "The id, or a unique column of the table",
    }),
    value: z.unknown().optional().meta({ ui: "expression" }),
  }),
  defaultConfig: { table: "", by: "id" },
  ports: { in: ["in"], out: ["out"] },
  // A row that is not there is data (`found: false`), not a failure.
  async run(ctx) {
    if (ctx.config.value === undefined) throw new Error("Set the value to look for");
    const row = await storeOf(ctx).get(ctx.config.table, {
      field: ctx.config.by,
      value: ctx.config.value,
    });
    return { port: "out", data: { found: row !== null, row } };
  },
});
