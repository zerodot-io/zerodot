// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default defineNode({
  type: "data.set",
  label: "Set Fields",
  description: "Add or change fields on each item",
  category: "data",
  icon: "PencilEdit01Icon",
  config: z.object({
    // Values can use expressions, for example { "name": "{{ $input.body.name }}" }.
    fields: z.record(z.string(), z.unknown()),
    keepInput: z.boolean().default(true),
  }),
  defaultConfig: { fields: {}, keepInput: true },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => {
    const count = isRecord(config.fields) ? Object.keys(config.fields).length : 0;
    return count === 1 ? "1 field" : `${count} fields`;
  },
  // With keepInput the fields are added to the input (when the input is an object).
  run: ({ config, input }) => ({
    port: "out",
    data: { ...(config.keepInput && isRecord(input) ? input : {}), ...config.fields },
  }),
});
