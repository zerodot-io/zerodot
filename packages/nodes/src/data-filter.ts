// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, resolveTemplate } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, listField, toList } from "./list-common";

export default defineNode({
  type: "data.filter",
  label: "Filter",
  description: "Keep only items matching a condition",
  category: "data",
  icon: "FilterIcon",
  config: z.object({
    list: listField,
    // Runs once for each item. Read the item with $item and its position with $index.
    condition: z.string().min(1).meta({ ui: "expression" }),
  }),
  defaultConfig: { list: DEFAULT_LIST, condition: "{{ $item.status == 200 }}" },
  rawConfigKeys: ["condition"],
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (typeof config.condition === "string" ? config.condition : undefined),
  run: ({ config, scope }) => {
    const kept = toList(config.list).filter(
      (item, index) =>
        !!resolveTemplate(config.condition, { ...scope, $item: item, $index: index }),
    );
    return { port: "out", data: kept };
  },
});
