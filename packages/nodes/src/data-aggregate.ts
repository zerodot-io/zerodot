// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, getPath, listField, toList } from "./list-common";

export default defineNode({
  type: "data.aggregate",
  label: "Aggregate",
  description: "Combine a field from many items into a list in a single item",
  category: "data",
  icon: "GitMergeIcon",
  config: z.object({
    list: listField,
    // Paths of the fields to collect. Empty: collect the whole items.
    fields: z.array(z.string().min(1)).default([]),
    // Name of the output field when the whole items are collected.
    outputField: z.string().min(1).default("data"),
    skipMissing: z.boolean().default(false),
  }),
  defaultConfig: { list: DEFAULT_LIST, fields: [], outputField: "data", skipMissing: false },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    Array.isArray(config.fields) && config.fields.length > 0
      ? config.fields.join(", ")
      : "all items",
  run: ({ config }) => {
    const list = toList(config.list);
    if (config.fields.length === 0) return { port: "out", data: { [config.outputField]: list } };
    const data: Record<string, unknown[]> = {};
    for (const field of config.fields) {
      const values = list.map((item) => getPath(item, field));
      data[field] = config.skipMissing
        ? values.filter((v) => v !== undefined && v !== null)
        : values;
    }
    return { port: "out", data };
  },
});
