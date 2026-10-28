// SPDX-License-Identifier: AGPL-3.0-only
import { graphSchema } from "@zerodot/engine";
import { and, asc, eq, gt, inArray, lt } from "drizzle-orm";
import type { Db } from "./client";
import { errorStats, nodeStats, run, runNodeResult, runStats, workflowVersion } from "./schema";
import {
  mergeErrorRows,
  mergeNodeRows,
  mergeRunRows,
  nodeRollupRow,
  runRollupRows,
  upsertErrorStats,
  upsertNodeStats,
  upsertRunStats,
} from "./scoped-stats";

/** Delete rollup rows of all projects that end before `before`. A daily job calls this. */
export async function purgeStats(db: Db, before: Date): Promise<number> {
  const [runs, nodes, errors] = await Promise.all([
    db
      .delete(runStats)
      .where(lt(runStats.bucketStart, before))
      .returning({ id: runStats.workflowId }),
    db
      .delete(nodeStats)
      .where(lt(nodeStats.bucketStart, before))
      .returning({ id: nodeStats.workflowId }),
    db
      .delete(errorStats)
      .where(lt(errorStats.bucketStart, before))
      .returning({ id: errorStats.workflowId }),
  ]);
  return runs.length + nodes.length + errors.length;
}

const BATCH = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function addTo<T>(map: Map<string, T>, key: string, row: T, merge: (a: T, b: T) => T) {
  const existing = map.get(key);
  map.set(key, existing ? merge(existing, row) : row);
}

/** Node ids and types of a stored graph. A graph that does not parse has no nodes. */
function nodeTypes(graph: unknown): Map<string, string> {
  const parsed = graphSchema.safeParse(graph);
  return new Map(parsed.success ? parsed.data.nodes.map((n) => [n.id, n.type]) : []);
}

/**
 * Build the rollups again from `run` and `run_node_result`. Use it after an import or a bug fix.
 * It deletes the rollups first, for one project or for all.
 */
export async function rebuildStats(
  db: Db,
  options: { organizationId?: string } = {},
): Promise<{ runs: number; nodes: number }> {
  const scope = options.organizationId;
  await db.transaction(async (tx) => {
    await tx.delete(runStats).where(scope ? eq(runStats.organizationId, scope) : undefined);
    await tx.delete(nodeStats).where(scope ? eq(nodeStats.organizationId, scope) : undefined);
    await tx.delete(errorStats).where(scope ? eq(errorStats.organizationId, scope) : undefined);
  });

  const runRows = new Map<string, ReturnType<typeof runRollupRows>["run"]>();
  const nodeRows = new Map<string, ReturnType<typeof nodeRollupRow>>();
  const errorRows = new Map<string, NonNullable<ReturnType<typeof runRollupRows>["error"]>>();
  const versionGraphs = new Map<string, Map<string, string>>();
  let runCount = 0;
  let nodeCount = 0;
  // Keyset by id. A timestamp loses microseconds in JS, and a page could repeat for ever.
  let afterId: string | null = null;

  for (;;) {
    const batch: (typeof run.$inferSelect)[] = await db
      .select()
      .from(run)
      .where(
        and(
          scope ? eq(run.organizationId, scope) : undefined,
          inArray(run.status, ["succeeded", "failed", "cancelled"]),
          afterId ? gt(run.id, afterId) : undefined,
        ),
      )
      .orderBy(asc(run.id))
      .limit(BATCH);
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id ?? null;

    const missing = [
      ...new Set(
        batch.flatMap((r) => (r.versionId && !versionGraphs.has(r.versionId) ? [r.versionId] : [])),
      ),
    ];
    if (missing.length > 0) {
      const versions = await db
        .select({ id: workflowVersion.id, graph: workflowVersion.graph })
        .from(workflowVersion)
        .where(inArray(workflowVersion.id, missing));
      for (const v of versions) versionGraphs.set(v.id, nodeTypes(v.graph));
    }
    const results = await db
      .select()
      .from(runNodeResult)
      .where(
        and(
          inArray(
            runNodeResult.runId,
            batch.map((r) => r.id),
          ),
          inArray(runNodeResult.status, ["succeeded", "failed"]),
        ),
      );
    const resultsByRun = new Map<string, (typeof runNodeResult.$inferSelect)[]>();
    for (const result of results) {
      const list = resultsByRun.get(result.runId) ?? [];
      list.push(result);
      resultsByRun.set(result.runId, list);
    }

    for (const r of batch) {
      if (
        !r.finishedAt ||
        (r.status !== "succeeded" && r.status !== "failed" && r.status !== "cancelled")
      )
        continue;
      const { run: runRow, error } = runRollupRows(r.organizationId, {
        runId: r.id,
        workflowId: r.workflowId,
        mode: r.mode,
        triggerType: r.triggerType,
        status: r.status,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        error: r.error,
      });
      runCount++;
      addTo(
        runRows,
        [
          runRow.organizationId,
          runRow.workflowId,
          runRow.bucketStart.getTime(),
          runRow.mode,
          runRow.triggerType,
        ].join("|"),
        runRow,
        mergeRunRows,
      );
      if (error) {
        addTo(
          errorRows,
          [
            error.organizationId,
            error.workflowId,
            error.fingerprint,
            error.bucketStart.getTime(),
            error.mode,
          ].join("|"),
          error,
          mergeErrorRows,
        );
      }
      const types = r.versionId ? versionGraphs.get(r.versionId) : nodeTypes(r.graphSnapshot);
      for (const result of resultsByRun.get(r.id) ?? []) {
        const nodeType = types?.get(result.nodeId);
        if (
          !nodeType ||
          !result.finishedAt ||
          (result.status !== "succeeded" && result.status !== "failed")
        )
          continue;
        const nodeRow = nodeRollupRow(r.organizationId, {
          workflowId: r.workflowId,
          nodeType,
          nodeId: result.nodeId,
          mode: r.mode,
          status: result.status,
          durationMs: result.startedAt
            ? Math.max(0, result.finishedAt.getTime() - result.startedAt.getTime())
            : 0,
          finishedAt: result.finishedAt,
        });
        nodeCount++;
        addTo(
          nodeRows,
          [
            nodeRow.organizationId,
            nodeRow.workflowId,
            nodeRow.nodeType,
            nodeRow.nodeId,
            nodeRow.bucketStart.getTime(),
            nodeRow.mode,
          ].join("|"),
          nodeRow,
          mergeNodeRows,
        );
      }
    }
  }

  for (const part of chunks([...runRows.values()], BATCH)) await upsertRunStats(db, part);
  for (const part of chunks([...nodeRows.values()], BATCH)) await upsertNodeStats(db, part);
  for (const part of chunks([...errorRows.values()], BATCH)) await upsertErrorStats(db, part);
  return { runs: runCount, nodes: nodeCount };
}
