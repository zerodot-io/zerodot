// SPDX-License-Identifier: AGPL-3.0-only
import type { OrganizationScope, StatsFilter } from "@zerodot/db";
import { granularityFor, hourStart } from "@zerodot/db/stats-math";
import { graphSchema } from "@zerodot/engine";
import { durationStats, type Kpis, type NodeRow, RANGES, toKpis } from "./insights";

const HOUR_MS = 3_600_000;
const TOP = 5;

export type InsightsInput = {
  range: keyof typeof RANGES;
  workflowIds: string[];
  triggerType?: string;
  includeTest: boolean;
};

/** Everything the insights page shows. The API routes and the MCP tool read parts of it. */
export async function buildInsights(scope: OrganizationScope, data: InsightsInput) {
  const length = RANGES[data.range].ms;
  const to = new Date(hourStart(new Date()).getTime() + HOUR_MS);
  const from = new Date(to.getTime() - length);
  const previousFrom = new Date(from.getTime() - length);
  const granularity = granularityFor(length);
  const filter: StatsFilter = {
    from,
    to,
    workflowIds: data.workflowIds,
    triggerType: data.triggerType,
    includeTest: data.includeTest,
  };
  const single = data.workflowIds.length === 1 ? data.workflowIds[0] : undefined;

  const [current, previous, series, workflowRows, nodeRows, errors, workflows, publishes] =
    await Promise.all([
      scope.stats.summary(filter),
      scope.stats.summary({ ...filter, from: previousFrom, to: from }),
      scope.stats.timeseries(filter, granularity),
      scope.stats.workflows(filter, granularity),
      scope.stats.nodes(filter),
      scope.stats.errors(filter, 10),
      scope.workflows.list({ limit: 200 }),
      single ? scope.stats.publishes(single, filter) : Promise.resolve([]),
    ]);

  // Node names live in the graph. The rollup keeps the id and the type.
  const names = new Map<string, Map<string, string>>();
  for (const wf of workflows.items) {
    const parsed = graphSchema.safeParse(wf.draftGraph);
    if (parsed.success) names.set(wf.id, new Map(parsed.data.nodes.map((n) => [n.id, n.name])));
  }
  const nodes: NodeRow[] = nodeRows.map((n) => {
    const runs = n.succeeded + n.failed;
    const stats = durationStats({
      succeeded: n.succeeded,
      failed: n.failed,
      cancelled: 0,
      durationSumMs: n.durationSumMs,
      durationBuckets: n.durationBuckets,
    });
    return {
      workflowId: n.workflowId,
      workflowName: n.workflowName,
      nodeType: n.nodeType,
      nodeId: n.nodeId,
      nodeName: names.get(n.workflowId)?.get(n.nodeId) ?? null,
      runs,
      failed: n.failed,
      avgMs: stats.avgMs,
      p95Ms: stats.p95Ms,
    };
  });

  const toPoint = (p: (typeof series)[number]) => ({
    bucket: p.bucket,
    ...toKpis({ ...p, hasTimeSaved: true }),
  });
  const currentKpis: Kpis = toKpis(current);
  const previousKpis: Kpis = toKpis(previous);
  const byRuns = [...nodes].sort((a, b) => b.runs - a.runs);
  const selected = single ? workflows.items.find((w) => w.id === single) : undefined;

  return {
    from,
    to,
    granularity,
    workflows: workflows.items.map((w) => ({ id: w.id, name: w.name })),
    kpis: { current: currentKpis, previous: previousKpis },
    series: series.map(toPoint),
    table: workflowRows.map((w) => ({
      workflowId: w.workflowId,
      workflowName: w.workflowName,
      lastRunAt: w.lastRunAt,
      lastFailureAt: w.lastFailureAt,
      trend: w.trend,
      ...toKpis(w),
    })),
    failingNodes: nodes
      .filter((n) => n.failed > 0)
      .sort((a, b) => b.failed - a.failed)
      .slice(0, TOP),
    slowestNodes: nodes
      .filter((n) => n.p95Ms !== null)
      .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
      .slice(0, TOP),
    // The per-node table of the workflow page.
    nodes: single ? byRuns : null,
    allNodes: byRuns,
    errors,
    publishes,
    workflow: selected
      ? { id: selected.id, name: selected.name, minutesSavedPerRun: selected.minutesSavedPerRun }
      : null,
  };
}
