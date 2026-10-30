// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readFilter, storeOf, tableRef } from "./table-common";

export default defineNode({
  type: "table.delete",
  usableAsTool: true,
  label: "Delete Rows",
  description: "Remove rows from a table that match a filter",
  category: "data",
  app: "Tables",
  icon: "Delete02Icon",
  config: z.object({
    table: tableRef,
    filter: z.unknown().optional().meta({ ui: "filter" }),
    // Without a filter the node fails, unless `all` is on.
    all: z.boolean().default(false),
  }),
  defaultConfig: { table: "", all: false },
  ports: { in: ["in"], out: ["out"] },
  async run(ctx) {
    const { count } = await storeOf(ctx).delete(ctx.config.table, {
      filter: readFilter(ctx.config.filter),
      all: ctx.config.all,
    });
    return { port: "out", data: { count } };
  },
});
