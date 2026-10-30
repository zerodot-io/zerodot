// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { numberRecord, readFilter, rowObject, storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.update",
  usableAsTool: true,
  label: "Update Rows",
  description: "Change rows in a table that match a filter",
  category: "data",
  app: "Tables",
  icon: "FileEditIcon",
  config: z.object({
    table: tableRef,
    filter: z.unknown().optional().meta({ ui: "filter" }),
    // Without a filter the node fails, unless `all` is on.
    all: z.boolean().default(false),
    // Values to write. A null clears a column.
    set: rowObject.optional(),
    // Numbers to add to number columns. The database adds them, so parallel runs keep every count.
    increment: numberRecord.optional(),
  }),
  defaultConfig: { table: "", all: false, set: {} },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const { count, rows } = await storeOf(ctx).update(ctx.config.table, {
      filter: readFilter(ctx.config.filter),
      all: ctx.config.all,
      set: ctx.config.set,
      increment: ctx.config.increment,
    });
    // `rows` holds up to 100 changed rows. `count` is the total.
    return { port: "out", data: { count, rows } };
  },
});
