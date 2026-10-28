// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { isRecord } from "./list-common";

function rename(value: unknown, keys: Record<string, string>): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [keys[key] ?? key, item]));
}

export default defineNode({
  type: "data.renameKeys",
  label: "Rename Keys",
  description: "Update item field names",
  category: "data",
  icon: "TextCursorInput",
  config: z.object({
    // Old name to new name. The input can be an object or a list of objects.
    keys: z.record(z.string(), z.string().min(1)),
  }),
  defaultConfig: { keys: {} },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => {
    const count = isRecord(config.keys) ? Object.keys(config.keys).length : 0;
    return count === 1 ? "1 key" : `${count} keys`;
  },
  run: ({ config, input }) => ({
    port: "out",
    data: Array.isArray(input)
      ? input.map((item) => rename(item, config.keys))
      : rename(input, config.keys),
  }),
});
