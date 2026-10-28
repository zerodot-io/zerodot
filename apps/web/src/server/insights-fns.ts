// SPDX-License-Identifier: AGPL-3.0-only
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { projectFor } from "./settings-fns";

const insightsInput = z.object({
  projectSlug: z.string().min(1),
  range: z.enum(["24h", "7d", "30d", "90d"]),
  workflowIds: z.array(z.string().uuid()).max(50),
  triggerType: z.string().min(1).optional(),
  includeTest: z.boolean(),
});

export const getInsightsFn = createServerFn({ method: "GET" })
  .validator(insightsInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const { buildInsights } = await import("@zerodot/server/insights.server");
    const { allNodes: _all, ...insights } = await buildInsights(ctx.scope, data);
    return insights;
  });

export const setMinutesSavedFn = createServerFn({ method: "POST" })
  .validator(
    z.object({
      projectSlug: z.string().min(1),
      workflowId: z.string().uuid(),
      minutes: z.number().int().min(0).max(100_000).nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const row = await ctx.scope.workflows.setMinutesSaved(data.workflowId, data.minutes);
    if (!row) throw new Error("Not found");
    return { minutes: row.minutesSavedPerRun };
  });
