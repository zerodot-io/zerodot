// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, getPath, listField, toList } from "./list-common";

const OPERATIONS = ["count", "sum", "average", "min", "max"] as const;

function numbers(items: unknown[], field: string): number[] {
  return items
    .map((item) => Number(getPath(item, field)))
    .filter((value) => Number.isFinite(value));
}

function apply(
  operation: (typeof OPERATIONS)[number],
  items: unknown[],
  field: string,
): number | null {
  if (operation === "count") return items.length;
  const values = numbers(items, field);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (operation === "sum") return total;
  if (operation === "average") return total / values.length;
  return operation === "min" ? Math.min(...values) : Math.max(...values);
}

export default defineNode({
  type: "data.summarize",
  label: "Summarize",
  description: "Sum, count, max, etc. across items",
  category: "data",
  icon: "Sigma",
  config: z.object({
    list: listField,
    summaries: z
      .array(
        z.object({
          operation: z.enum(OPERATIONS),
          // Path of the field. Not used by count.
          field: z.string().default(""),
        }),
      )
      .min(1),
    // Path of a field to group by. Empty: one summary of all items.
    groupBy: z.string().default(""),
  }),
  defaultConfig: {
    list: DEFAULT_LIST,
    summaries: [{ operation: "count", field: "" }],
    groupBy: "",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    Array.isArray(config.summaries)
      ? config.summaries
          .map((s) => (s && typeof s === "object" && "operation" in s ? String(s.operation) : ""))
          .join(", ")
      : undefined,
  run: ({ config }) => {
    const summarize = (items: unknown[]) =>
      Object.fromEntries(
        config.summaries.map(({ operation, field }) => [
          operation === "count" ? "count" : `${operation}_${field}`,
          apply(operation, items, field),
        ]),
      );
    if (config.groupBy === "") return { port: "out", data: summarize(toList(config.list)) };
    const groups = new Map<string, { key: unknown; items: unknown[] }>();
    for (const item of toList(config.list)) {
      const key = getPath(item, config.groupBy) ?? null;
      const id = JSON.stringify(key);
      const group = groups.get(id) ?? { key, items: [] };
      group.items.push(item);
      groups.set(id, group);
    }
    const data = [...groups.values()].map((g) => ({
      [config.groupBy]: g.key,
      ...summarize(g.items),
    }));
    return { port: "out", data };
  },
});
