// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import type { Db } from "./client";

const DAY_MS = 86_400_000;

export type PurgeRunsResult = {
  testRuns: number;
  productionRuns: number;
  /** Number of delete statements that ran. */
  batches: number;
  /** False when the job stopped at `maxBatches`. Old runs may remain. The next job continues. */
  complete: boolean;
};

export const DEFAULT_PURGE_BATCH_SIZE = 1000;
export const DEFAULT_PURGE_MAX_BATCHES = 200;
const DEFAULT_PURGE_PAUSE_MS = 25;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Delete old runs of all projects. A job calls this on a schedule.
 * Test runs go after `testDays`. A finished production run goes after the retention days of its
 * project, or `defaultDays` when the project has no setting. A run that is not finished stays.
 * Node results go with the run (cascade). Insight rollups are separate and stay.
 *
 * The delete runs in batches of `batchSize` runs, each in its own statement. So a job never holds
 * locks on many rows for a long time. The job stops after `maxBatches` statements (test runs
 * first, then production runs) and sets `complete` to false. A job on a short schedule (for
 * example each hour) can use a small `maxBatches` and still catch up over time.
 * `pauseMs` is the wait between two batches.
 */
export async function purgeRuns(
  db: Db,
  options: {
    testDays: number;
    defaultDays: number;
    now?: Date;
    batchSize?: number;
    maxBatches?: number;
    pauseMs?: number;
  },
): Promise<PurgeRunsResult> {
  const now = options.now ?? new Date();
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_PURGE_BATCH_SIZE));
  const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? DEFAULT_PURGE_MAX_BATCHES));
  const pauseMs = options.pauseMs ?? DEFAULT_PURGE_PAUSE_MS;
  const testBefore = new Date(now.getTime() - options.testDays * DAY_MS);

  const deleteTests = () =>
    db.execute<{ n: number }>(sql`
      with doomed as (
        select id from run
        where mode = 'test'
          and status in ('succeeded', 'failed', 'cancelled')
          and created_at < ${testBefore.toISOString()}::timestamptz
        order by created_at
        limit ${batchSize}
        for update skip locked),
      gone as (delete from run where id in (select id from doomed) returning 1)
      select count(*)::int as n from gone`);

  const deleteProduction = () =>
    db.execute<{ n: number }>(sql`
      with doomed as (
        select r.id from run r
        join (select o.id as organization_id,
                     coalesce(s.run_retention_days, ${options.defaultDays}) as days
              from organization o
              left join project_settings s on s.organization_id = o.id) p
          on r.organization_id = p.organization_id
        where r.mode = 'production'
          and r.status in ('succeeded', 'failed', 'cancelled')
          and r.created_at < ${now.toISOString()}::timestamptz - make_interval(days => p.days)
        order by r.created_at
        limit ${batchSize}
        for update of r skip locked),
      gone as (delete from run where id in (select id from doomed) returning 1)
      select count(*)::int as n from gone`);

  let batches = 0;
  let complete = true;
  const drain = async (step: () => ReturnType<typeof deleteTests>) => {
    let total = 0;
    for (;;) {
      if (batches >= maxBatches) {
        complete = false;
        return total;
      }
      if (batches > 0) await pause(pauseMs);
      const [row] = await step();
      batches += 1;
      const count = Number(row?.n ?? 0);
      total += count;
      if (count < batchSize) return total;
    }
  };
  const testRuns = await drain(deleteTests);
  const productionRuns = await drain(deleteProduction);
  return { testRuns, productionRuns, batches, complete };
}

export type StuckRun = { id: string; organizationId: string; mode: "production" | "test" };

/**
 * Runs that are queued since before `queuedBefore`, or running since before `runningBefore`,
 * in all projects. The sweeper checks if the queue still has a job for each one.
 */
export async function listStuckRuns(
  db: Db,
  options: { queuedBefore: Date; runningBefore: Date; limit?: number },
): Promise<StuckRun[]> {
  const rows = await db.execute<{
    id: string;
    organization_id: string;
    mode: "production" | "test";
  }>(sql`
    select id, organization_id, mode from run
    where (status = 'queued' and created_at < ${options.queuedBefore.toISOString()}::timestamptz)
       or (status = 'running' and coalesce(started_at, created_at) < ${options.runningBefore.toISOString()}::timestamptz)
    order by created_at
    limit ${options.limit ?? 500}`);
  return rows.map((r) => ({ id: r.id, organizationId: r.organization_id, mode: r.mode }));
}
