// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, getPath, listField, toList } from "./list-common";

export default defineNode({
  type: "data.removeDuplicates",
  label: "Remove Duplicates",
  description: "Delete items with matching field values",
  category: "data",
  icon: "CopyXIcon",
  config: z.object({
    list: listField,
    // Paths of the fields to compare. Empty: compare the whole item.
    fields: z.array(z.string().min(1)).default([]),
  }),
  defaultConfig: { list: DEFAULT_LIST, fields: [] },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    Array.isArray(config.fields) && config.fields.length > 0
      ? config.fields.join(", ")
      : "all fields",
  run: ({ config }) => {
    const seen = new Set<string>();
    const data = toList(config.list).filter((item) => {
      const key = JSON.stringify(
        config.fields.length > 0 ? config.fields.map((f) => getPath(item, f) ?? null) : item,
      );
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { port: "out", data };
  },
});
