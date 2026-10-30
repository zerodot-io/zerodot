// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, listField, toList } from "./list-common";

export default defineNode({
  type: "data.limit",
  label: "Limit",
  description: "Restrict the number of items",
  category: "data",
  icon: "TextIndentLessIcon",
  config: z.object({
    list: listField,
    max: z.number().int().min(0).default(1),
    keep: z
      .enum(["first", "last"])
      .default("first")
      .meta({
        title: "Keep",
        labels: { first: "First Items", last: "Last Items" },
        hints: {
          first: "Keep items from the start of the list",
          last: "Keep items from the end of the list",
        },
      }),
  }),
  defaultConfig: { list: DEFAULT_LIST, max: 1, keep: "first" },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => `${String(config.keep ?? "first")} ${String(config.max ?? 1)}`,
  run: ({ config }) => {
    const list = toList(config.list);
    const data =
      config.max === 0
        ? []
        : config.keep === "last"
          ? list.slice(-config.max)
          : list.slice(0, config.max);
    return { port: "out", data };
  },
});
