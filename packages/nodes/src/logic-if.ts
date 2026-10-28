// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export default defineNode({
  type: "logic.if",
  label: "If",
  description: "Split items into true and false paths",
  category: "logic",
  icon: "GitBranch",
  config: z.object({
    // Usually an expression, for example {{ $input.status == 200 }}.
    condition: z.unknown().meta({ ui: "condition" }),
  }),
  defaultConfig: { condition: "{{ $input.status == 200 }}" },
  ports: { in: ["in"], out: ["true", "false"] },
  subtitle: (config) => (typeof config.condition === "string" ? config.condition : undefined),
  run: ({ config, input }) => ({ port: config.condition ? "true" : "false", data: input }),
});
