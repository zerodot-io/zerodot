// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { validateCron } from "./cron";

export default defineNode({
  type: "trigger.cron",
  label: "Schedule",
  description: "Start the workflow on a time schedule",
  category: "trigger",
  icon: "Calendar03Icon",
  config: z
    .object({
      expression: z.string().min(1).meta({ ui: "cron", title: "Schedule" }),
      // Empty uses the time zone of the workflow, then of the project, then UTC.
      timezone: z.string().optional().meta({ ui: "timezone", title: "Time zone" }),
    })
    .superRefine((config, ctx) => {
      const message = validateCron(config.expression, config.timezone || "UTC");
      if (message) ctx.addIssue({ code: "custom", message, path: ["expression"] });
    }),
  defaultConfig: { expression: "0 * * * *" },
  ports: { in: [], out: ["out"] },
  subtitle: (config) => (typeof config.expression === "string" ? config.expression : undefined),
  // The input holds { scheduledAt, timezone }.
  run: ({ input }) => ({ port: "out", data: input }),
});
