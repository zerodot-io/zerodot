// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, getPath, listField, toList } from "./list-common";

function compare(a: unknown, b: unknown): number {
  // Missing values go last.
  if (a === undefined || a === null) return b === undefined || b === null ? 0 : 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export default defineNode({
  type: "data.sort",
  label: "Sort",
  description: "Change items order",
  category: "data",
  icon: "ArrowUpDownIcon",
  config: z.object({
    list: listField,
    // Path of the field to sort by, for example "user.age". Empty: sort the items themselves.
    field: z.string().default(""),
    order: z
      .enum(["ascending", "descending"])
      .default("ascending")
      .meta({
        title: "Order",
        labels: { ascending: "Ascending", descending: "Descending" },
        hints: { ascending: "Smallest first, A to Z", descending: "Largest first, Z to A" },
      }),
  }),
  defaultConfig: { list: DEFAULT_LIST, field: "", order: "ascending" },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => `${String(config.field || "item")} ${String(config.order ?? "ascending")}`,
  run: ({ config }) => {
    const sign = config.order === "descending" ? -1 : 1;
    const data = [...toList(config.list)].sort(
      (x, y) => sign * compare(getPath(x, config.field), getPath(y, config.field)),
    );
    return { port: "out", data };
  },
});
