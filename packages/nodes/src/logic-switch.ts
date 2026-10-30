// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export const SWITCH_DEFAULT_PORT = "default";

/** The ports of a switch: one for each case, then "default". */
function casePorts(config: Record<string, unknown>): string[] {
  const cases = Array.isArray(config.cases)
    ? config.cases.filter((c): c is string => typeof c === "string" && c.length > 0)
    : [];
  return [...cases, SWITCH_DEFAULT_PORT];
}

export default defineNode({
  type: "logic.switch",
  label: "Switch",
  description: "Route items to one of many outputs by rules",
  category: "logic",
  icon: "GitForkIcon",
  config: z.object({
    value: z.unknown().meta({ ui: "expression" }),
    // A case matches when the text of the value is the same as the case.
    cases: z
      .array(z.string().min(1))
      .min(1)
      .max(20)
      .refine((cases) => new Set(cases).size === cases.length, "Cases must be different")
      .refine((cases) => !cases.includes(SWITCH_DEFAULT_PORT), '"default" is reserved'),
  }),
  defaultConfig: { value: "{{ $input.status }}", cases: ["200", "404"] },
  ports: { in: ["in"], out: [SWITCH_DEFAULT_PORT] },
  outPorts: casePorts,
  subtitle: (config) => casePorts(config).join(", "),
  run: ({ config, input }) => {
    const text = typeof config.value === "string" ? config.value : JSON.stringify(config.value);
    const match = config.cases.find((c) => c === text);
    return { port: match ?? SWITCH_DEFAULT_PORT, data: input };
  },
});
