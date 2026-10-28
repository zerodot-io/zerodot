// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client";
import { errorStats, nodeStats, runStats, workflow, workflowVersion } from "./schema";
import { errorFingerprint } from "./stats-fingerprint";
import {
  addHistograms,
  bucketStarts,
  emptyHistogram,
  type Granularity,
  histogramOf,
  hourStart,
} from "./stats-math";

type RunStatsRow = typeof runStats.$inferInsert;
type NodeStatsRow = typeof nodeStats.$inferInsert;
type ErrorStatsRow = typeof errorStats.$inferInsert;

/** The range is `from` (included) to `to` (excluded). Both sit on hour boundaries. */
export type StatsFilter = {
  from: Date;
  to: Date;
  workflowIds?: string[];
  /** Applies to run rollups only. Node and error rollups do not keep the trigger type. */
  triggerType?: string;
  /** Production runs only, unless this is true. */
  includeTest?: boolean;
};

export type RunAggregate = {
  succeeded: number;
  failed: number;
  cancelled: number;
  durationSumMs: number;
  durationBuckets: number[];
  timeSavedMinutes: number;
  /** False when no workflow in the filter has `minutes_saved_per_run`. */
  hasTimeSaved: boolean;
};

export type TimeseriesPoint = Omit<RunAggregate, "hasTimeSaved"> & { bucket: Date };

export type WorkflowStatsRow = RunAggregate & {
  workflowId: string;
  workflowName: string;
  lastRunAt: Date | null;
  lastFailureAt: Date | null;
  /** Finished runs for each bucket from `bucketStarts(from, to, granularity)`. */
  trend: number[];
};

export type NodeAggregate = {
  workflowId: string;
  workflowName: string;
  nodeType: string;
  nodeId: string;
  succeeded: number;
  failed: number;
  durationSumMs: number;
  durationBuckets: number[];
};

export type ErrorGroup = {
  fingerprint: string;
  count: number;
  sampleMessage: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastRunId: string;
  workflowId: string;
  workflowName: string;
};

export type RunEndInput = {
  runId: string;
  workflowId: string;
  mode: "production" | "test";
  triggerType: string;
  status: "succeeded" | "failed" | "cancelled";
  startedAt: Date | null;
  finishedAt: Date;
  error: unknown;
};

export type NodeEndInput = {
  workflowId: string;
  nodeType: string;
  nodeId: string;
  mode: "production" | "test";
  status: "succeeded" | "failed";
  durationMs: number;
  finishedAt: Date;
};

const sumNumber = (column: SQL | { name: string }) =>
  sql<number>`coalesce(sum(${column}), 0)::float8`.mapWith(Number);
const epochMs = (expression: SQL) =>
  sql<number | null>`(extract(epoch from ${expression}) * 1000)::float8`.mapWith((v) =>
    v === null ? null : Number(v),
  );

const runAggregateFields = {
  succeeded: sumNumber(runStats.succeeded),
  failed: sumNumber(runStats.failed),
  cancelled: sumNumber(runStats.cancelled),
  durationSumMs: sumNumber(runStats.durationSumMs),
  durationBuckets: sql<
    number[]
  >`coalesce(zerodot_sum_arrays(${runStats.durationBuckets}), '{}'::integer[])`,
  timeSavedMinutes:
    sql<number>`coalesce(sum(${runStats.succeeded} * coalesce(${workflow.minutesSavedPerRun}, 0)), 0)::float8`.mapWith(
      Number,
    ),
  hasTimeSaved: sql<boolean>`coalesce(bool_or(${workflow.minutesSavedPerRun} is not null), false)`,
};

function durationMsOf(startedAt: Date | null, finishedAt: Date): number {
  return startedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : 0;
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : "Unknown error";
}

/** The rows one finished run adds to the rollups. Live writes and `rebuildStats` share it. */
export function runRollupRows(organizationId: string, input: RunEndInput) {
  const durationMs = durationMsOf(input.startedAt, input.finishedAt);
  const run: RunStatsRow = {
    organizationId,
    workflowId: input.workflowId,
    bucketStart: hourStart(input.finishedAt),
    mode: input.mode,
    triggerType: input.triggerType,
    succeeded: input.status === "succeeded" ? 1 : 0,
    failed: input.status === "failed" ? 1 : 0,
    cancelled: input.status === "cancelled" ? 1 : 0,
    durationSumMs: durationMs,
    durationBuckets: histogramOf(durationMs),
    lastRunAt: input.finishedAt,
  };
  const message = messageOf(input.error);
  const error: ErrorStatsRow | null =
    input.status === "failed"
      ? {
          organizationId,
          workflowId: input.workflowId,
          fingerprint: errorFingerprint(message),
          bucketStart: hourStart(input.finishedAt),
          mode: input.mode,
          count: 1,
          sampleMessage: message.slice(0, 500),
          lastRunId: input.runId,
          firstSeenAt: input.finishedAt,
          lastSeenAt: input.finishedAt,
        }
      : null;
  return { run, error };
}

export function nodeRollupRow(organizationId: string, input: NodeEndInput): NodeStatsRow {
  return {
    organizationId,
    workflowId: input.workflowId,
    nodeType: input.nodeType,
    nodeId: input.nodeId,
    bucketStart: hourStart(input.finishedAt),
    mode: input.mode,
    succeeded: input.status === "succeeded" ? 1 : 0,
    failed: input.status === "failed" ? 1 : 0,
    durationSumMs: input.durationMs,
    durationBuckets: histogramOf(input.durationMs),
  };
}

/** Adds counters of rows with the same key. Used before a bulk insert. */
export function mergeRunRows(a: RunStatsRow, b: RunStatsRow): RunStatsRow {
  return {
    ...a,
    succeeded: (a.succeeded ?? 0) + (b.succeeded ?? 0),
    failed: (a.failed ?? 0) + (b.failed ?? 0),
    cancelled: (a.cancelled ?? 0) + (b.cancelled ?? 0),
    durationSumMs: (a.durationSumMs ?? 0) + (b.durationSumMs ?? 0),
    durationBuckets: addHistograms(a.durationBuckets, b.durationBuckets),
    lastRunAt: new Date(Math.max(a.lastRunAt.getTime(), b.lastRunAt.getTime())),
  };
}

export function mergeNodeRows(a: NodeStatsRow, b: NodeStatsRow): NodeStatsRow {
  return {
    ...a,
    succeeded: (a.succeeded ?? 0) + (b.succeeded ?? 0),
    failed: (a.failed ?? 0) + (b.failed ?? 0),
    durationSumMs: (a.durationSumMs ?? 0) + (b.durationSumMs ?? 0),
    durationBuckets: addHistograms(a.durationBuckets, b.durationBuckets),
  };
}

export function mergeErrorRows(a: ErrorStatsRow, b: ErrorStatsRow): ErrorStatsRow {
  const bIsLater = b.lastSeenAt >= a.lastSeenAt;
  return {
    ...a,
    count: (a.count ?? 0) + (b.count ?? 0),
    sampleMessage: bIsLater ? b.sampleMessage : a.sampleMessage,
    lastRunId: bIsLater ? b.lastRunId : a.lastRunId,
    firstSeenAt: new Date(Math.min(a.firstSeenAt.getTime(), b.firstSeenAt.getTime())),
    lastSeenAt: bIsLater ? b.lastSeenAt : a.lastSeenAt,
  };
}

/** Add rows to the rollups. Rows in one call must have different keys. */
export async function upsertRunStats(db: Db, rows: RunStatsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(runStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        runStats.organizationId,
        runStats.workflowId,
        runStats.bucketStart,
        runStats.mode,
        runStats.triggerType,
      ],
      set: {
        succeeded: sql`${runStats.succeeded} + excluded.succeeded`,
        failed: sql`${runStats.failed} + excluded.failed`,
        cancelled: sql`${runStats.cancelled} + excluded.cancelled`,
        durationSumMs: sql`${runStats.durationSumMs} + excluded.duration_sum_ms`,
        durationBuckets: sql`zerodot_add_arrays(${runStats.durationBuckets}, excluded.duration_buckets)`,
        lastRunAt: sql`greatest(${runStats.lastRunAt}, excluded.last_run_at)`,
      },
    });
}

export async function upsertNodeStats(db: Db, rows: NodeStatsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(nodeStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        nodeStats.organizationId,
        nodeStats.workflowId,
        nodeStats.nodeType,
        nodeStats.nodeId,
        nodeStats.bucketStart,
        nodeStats.mode,
      ],
      set: {
        succeeded: sql`${nodeStats.succeeded} + excluded.succeeded`,
        failed: sql`${nodeStats.failed} + excluded.failed`,
        durationSumMs: sql`${nodeStats.durationSumMs} + excluded.duration_sum_ms`,
        durationBuckets: sql`zerodot_add_arrays(${nodeStats.durationBuckets}, excluded.duration_buckets)`,
      },
    });
}

export async function upsertErrorStats(db: Db, rows: ErrorStatsRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db
    .insert(errorStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        errorStats.organizationId,
        errorStats.workflowId,
        errorStats.fingerprint,
        errorStats.bucketStart,
        errorStats.mode,
      ],
      set: {
        count: sql`${errorStats.count} + excluded.count`,
        sampleMessage: sql`case when excluded.last_seen_at >= ${errorStats.lastSeenAt} then excluded.sample_message else ${errorStats.sampleMessage} end`,
        lastRunId: sql`case when excluded.last_seen_at >= ${errorStats.lastSeenAt} then excluded.last_run_id else ${errorStats.lastRunId} end`,
        firstSeenAt: sql`least(${errorStats.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sql`greatest(${errorStats.lastSeenAt}, excluded.last_seen_at)`,
      },
    });
}

export function stats(db: Db, organizationId: string) {
  const runConditions = (f: StatsFilter) =>
    and(
      eq(runStats.organizationId, organizationId),
      gte(runStats.bucketStart, f.from),
      lt(runStats.bucketStart, f.to),
      f.includeTest ? undefined : eq(runStats.mode, "production"),
      f.workflowIds?.length ? inArray(runStats.workflowId, f.workflowIds) : undefined,
      f.triggerType ? eq(runStats.triggerType, f.triggerType) : undefined,
    );
  const nodeConditions = (f: StatsFilter) =>
    and(
      eq(nodeStats.organizationId, organizationId),
      gte(nodeStats.bucketStart, f.from),
      lt(nodeStats.bucketStart, f.to),
      f.includeTest ? undefined : eq(nodeStats.mode, "production"),
      f.workflowIds?.length ? inArray(nodeStats.workflowId, f.workflowIds) : undefined,
    );
  const errorConditions = (f: StatsFilter) =>
    and(
      eq(errorStats.organizationId, organizationId),
      gte(errorStats.bucketStart, f.from),
      lt(errorStats.bucketStart, f.to),
      f.includeTest ? undefined : eq(errorStats.mode, "production"),
      f.workflowIds?.length ? inArray(errorStats.workflowId, f.workflowIds) : undefined,
    );
  const bucketOf = (granularity: Granularity) =>
    sql`date_trunc(${sql.raw(`'${granularity}'`)}, ${runStats.bucketStart}, 'UTC')`;

  return {
    /** A hook calls this when a run ends. The caller logs a failure and keeps the run result. */
    async recordRunEnd(input: RunEndInput): Promise<void> {
      const { run, error } = runRollupRows(organizationId, input);
      await upsertRunStats(db, [run]);
      if (error) await upsertErrorStats(db, [error]);
    },

    async recordNodeEnd(input: NodeEndInput): Promise<void> {
      await upsertNodeStats(db, [nodeRollupRow(organizationId, input)]);
    },

    /** Many node ends in one write. Rows with the same key are added up first. */
    async recordNodeEnds(inputs: NodeEndInput[]): Promise<void> {
      const merged = new Map<string, NodeStatsRow>();
      for (const input of inputs) {
        const row = nodeRollupRow(organizationId, input);
        const key = [
          row.workflowId,
          row.nodeType,
          row.nodeId,
          row.bucketStart.getTime(),
          row.mode,
        ].join("|");
        const previous = merged.get(key);
        merged.set(key, previous ? mergeNodeRows(previous, row) : row);
      }
      await upsertNodeStats(db, [...merged.values()]);
    },

    /** Totals for one range. */
    async summary(filter: StatsFilter): Promise<RunAggregate> {
      const [row] = await db
        .select(runAggregateFields)
        .from(runStats)
        .innerJoin(workflow, eq(runStats.workflowId, workflow.id))
        .where(runConditions(filter));
      return (
        row ?? {
          succeeded: 0,
          failed: 0,
          cancelled: 0,
          durationSumMs: 0,
          durationBuckets: emptyHistogram(),
          timeSavedMinutes: 0,
          hasTimeSaved: false,
        }
      );
    },

    /** One point for each bucket in the range. Empty buckets have zeros. */
    async timeseries(filter: StatsFilter, granularity: Granularity): Promise<TimeseriesPoint[]> {
      const bucket = bucketOf(granularity);
      const rows = await db
        .select({ bucket: epochMs(bucket), ...runAggregateFields })
        .from(runStats)
        .innerJoin(workflow, eq(runStats.workflowId, workflow.id))
        .where(runConditions(filter))
        .groupBy(bucket)
        .orderBy(bucket);
      const byBucket = new Map(rows.map((r) => [r.bucket, r]));
      return bucketStarts(filter.from, filter.to, granularity).map((start) => {
        const row = byBucket.get(start.getTime());
        return {
          bucket: start,
          succeeded: row?.succeeded ?? 0,
          failed: row?.failed ?? 0,
          cancelled: row?.cancelled ?? 0,
          durationSumMs: row?.durationSumMs ?? 0,
          durationBuckets: row?.durationBuckets ?? emptyHistogram(),
          timeSavedMinutes: row?.timeSavedMinutes ?? 0,
        };
      });
    },

    /** One row for each workflow that has runs in the range. */
    async workflows(filter: StatsFilter, granularity: Granularity): Promise<WorkflowStatsRow[]> {
      const bucket = bucketOf(granularity);
      const [totals, failures, trends] = await Promise.all([
        db
          .select({
            workflowId: runStats.workflowId,
            workflowName: workflow.name,
            lastRunAt: epochMs(sql`max(${runStats.lastRunAt})`),
            ...runAggregateFields,
          })
          .from(runStats)
          .innerJoin(workflow, eq(runStats.workflowId, workflow.id))
          .where(runConditions(filter))
          .groupBy(runStats.workflowId, workflow.name),
        db
          .select({
            workflowId: errorStats.workflowId,
            lastFailureAt: epochMs(sql`max(${errorStats.lastSeenAt})`),
          })
          .from(errorStats)
          .where(errorConditions(filter))
          .groupBy(errorStats.workflowId),
        db
          .select({
            workflowId: runStats.workflowId,
            bucket: epochMs(bucket),
            runs: sumNumber(
              sql`${runStats.succeeded} + ${runStats.failed} + ${runStats.cancelled}`,
            ),
          })
          .from(runStats)
          .where(runConditions(filter))
          .groupBy(runStats.workflowId, bucket),
      ]);
      const lastFailure = new Map(failures.map((f) => [f.workflowId, f.lastFailureAt]));
      const starts = bucketStarts(filter.from, filter.to, granularity).map((d) => d.getTime());
      const trendOf = new Map<string, Map<number, number>>();
      for (const t of trends) {
        const points = trendOf.get(t.workflowId) ?? new Map<number, number>();
        points.set(Number(t.bucket), t.runs);
        trendOf.set(t.workflowId, points);
      }
      return totals.map(({ lastRunAt, ...row }) => ({
        ...row,
        lastRunAt: lastRunAt === null ? null : new Date(lastRunAt),
        lastFailureAt: lastFailure.get(row.workflowId)
          ? new Date(Number(lastFailure.get(row.workflowId)))
          : null,
        trend: starts.map((s) => trendOf.get(row.workflowId)?.get(s) ?? 0),
      }));
    },

    /** One row for each node that ran in the range. */
    async nodes(filter: StatsFilter): Promise<NodeAggregate[]> {
      return db
        .select({
          workflowId: nodeStats.workflowId,
          workflowName: workflow.name,
          nodeType: nodeStats.nodeType,
          nodeId: nodeStats.nodeId,
          succeeded: sumNumber(nodeStats.succeeded),
          failed: sumNumber(nodeStats.failed),
          durationSumMs: sumNumber(nodeStats.durationSumMs),
          durationBuckets: sql<
            number[]
          >`coalesce(zerodot_sum_arrays(${nodeStats.durationBuckets}), '{}'::integer[])`,
        })
        .from(nodeStats)
        .innerJoin(workflow, eq(nodeStats.workflowId, workflow.id))
        .where(nodeConditions(filter))
        .groupBy(nodeStats.workflowId, workflow.name, nodeStats.nodeType, nodeStats.nodeId);
    },

    /** Errors grouped by fingerprint. The most frequent first. */
    async errors(filter: StatsFilter, limit = 10): Promise<ErrorGroup[]> {
      const latest = <T>(column: SQL | { name: string }) =>
        sql<T>`(array_agg(${column} order by ${errorStats.lastSeenAt} desc))[1]`;
      const rows = await db
        .select({
          fingerprint: errorStats.fingerprint,
          count: sumNumber(errorStats.count),
          sampleMessage: latest<string>(errorStats.sampleMessage),
          firstSeenAt: epochMs(sql`min(${errorStats.firstSeenAt})`),
          lastSeenAt: epochMs(sql`max(${errorStats.lastSeenAt})`),
          lastRunId: latest<string>(errorStats.lastRunId),
          workflowId: latest<string>(errorStats.workflowId),
          workflowName: latest<string>(workflow.name),
        })
        .from(errorStats)
        .innerJoin(workflow, eq(errorStats.workflowId, workflow.id))
        .where(errorConditions(filter))
        .groupBy(errorStats.fingerprint)
        .orderBy(desc(sumNumber(errorStats.count)), errorStats.fingerprint)
        .limit(limit);
      return rows.map((r) => ({
        ...r,
        firstSeenAt: new Date(Number(r.firstSeenAt)),
        lastSeenAt: new Date(Number(r.lastSeenAt)),
      }));
    },

    /** Publishes of one workflow in the range. The chart marks them. */
    async publishes(
      workflowId: string,
      filter: Pick<StatsFilter, "from" | "to">,
    ): Promise<{ version: number; createdAt: Date }[]> {
      return db
        .select({ version: workflowVersion.version, createdAt: workflowVersion.createdAt })
        .from(workflowVersion)
        .innerJoin(workflow, eq(workflowVersion.workflowId, workflow.id))
        .where(
          and(
            eq(workflow.organizationId, organizationId),
            eq(workflowVersion.workflowId, workflowId),
            gte(workflowVersion.createdAt, filter.from),
            lt(workflowVersion.createdAt, filter.to),
          ),
        )
        .orderBy(workflowVersion.version);
    },
  };
}
