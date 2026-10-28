// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "./client";
import { adminAudit, organization, run, user, workflow } from "./schema";

export type AuditInput = {
  actor: { id: string; email: string };
  action: string;
  targetType: string;
  targetId: string;
  /** Ids and counts only. */
  details?: Record<string, string | number | boolean | null>;
};

export type AuditRow = typeof adminAudit.$inferSelect;

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(adminAudit).values({
    actorUserId: input.actor.id,
    actorEmail: input.actor.email,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    details: input.details ?? null,
  });
}

/** Newest first. */
export async function listAudit(db: Db, limit = 20): Promise<AuditRow[]> {
  return db
    .select()
    .from(adminAudit)
    .orderBy(desc(adminAudit.createdAt), desc(adminAudit.id))
    .limit(Math.min(Math.max(1, Math.floor(limit)), 500));
}

/** The id of the user who signed up first. Null when there is no user. */
export async function firstUserId(db: Db): Promise<string | null> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(1);
  return row?.id ?? null;
}

/** Find a run by id only, with no project check. For the instance admin only. */
export async function findRunAnyOrganization(
  db: Db,
  runId: string,
): Promise<{ id: string; organizationId: string; status: typeof run.$inferSelect.status } | null> {
  const [row] = await db
    .select({ id: run.id, organizationId: run.organizationId, status: run.status })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  return row ?? null;
}

export type ThroughputBucket = {
  /** Start of the minute, in ms since epoch. */
  at: number;
  created: number;
  succeeded: number;
  failed: number;
  cancelled: number;
};

export type Throughput = {
  buckets: ThroughputBucket[];
  /** Run time in ms of runs that finished in the window. Null when none did. */
  p50Ms: number | null;
  p95Ms: number | null;
};

const MINUTE_MS = 60_000;

/** Runs of all projects, per minute, for the last `minutes` minutes. For the instance admin only. */
export async function runThroughput(
  db: Db,
  minutes: number,
  now = Date.now(),
): Promise<Throughput> {
  const count = Math.min(Math.max(1, Math.floor(minutes)), 24 * 60);
  const end = Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const start = end - count * MINUTE_MS;
  const since = new Date(start);
  const [rows, latency] = await Promise.all([
    db
      .select({
        minute: sql<string>`date_trunc('minute', ${run.createdAt})`,
        created: sql<number>`count(*)::int`,
        succeeded: sql<number>`count(*) filter (where ${run.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${run.status} = 'failed')::int`,
        cancelled: sql<number>`count(*) filter (where ${run.status} = 'cancelled')::int`,
      })
      .from(run)
      .where(gte(run.createdAt, since))
      .groupBy(sql`1`),
    db
      .select({
        p50: sql<
          number | null
        >`percentile_cont(0.5) within group (order by extract(epoch from (${run.finishedAt} - ${run.startedAt})) * 1000)`,
        p95: sql<
          number | null
        >`percentile_cont(0.95) within group (order by extract(epoch from (${run.finishedAt} - ${run.startedAt})) * 1000)`,
      })
      .from(run)
      .where(and(gte(run.finishedAt, since), isNotNull(run.startedAt))),
  ]);
  const byMinute = new Map(rows.map((r) => [new Date(r.minute).getTime(), r]));
  const buckets: ThroughputBucket[] = [];
  for (let at = start; at < end; at += MINUTE_MS) {
    const r = byMinute.get(at);
    buckets.push({
      at,
      created: r?.created ?? 0,
      succeeded: r?.succeeded ?? 0,
      failed: r?.failed ?? 0,
      cancelled: r?.cancelled ?? 0,
    });
  }
  const l = latency[0];
  return {
    buckets,
    p50Ms: l?.p50 == null ? null : Math.round(Number(l.p50)),
    p95Ms: l?.p95 == null ? null : Math.round(Number(l.p95)),
  };
}

export type WorkflowLabel = { name: string; projectName: string; projectSlug: string };

/** Workflow and project names by workflow id, with no project check. For the instance admin only. */
export async function workflowLabels(db: Db, ids: string[]): Promise<Map<string, WorkflowLabel>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({
      id: workflow.id,
      name: workflow.name,
      projectName: organization.name,
      projectSlug: organization.slug,
    })
    .from(workflow)
    .innerJoin(organization, eq(organization.id, workflow.organizationId))
    .where(inArray(workflow.id, unique));
  return new Map(
    rows.map((r) => [
      r.id,
      { name: r.name, projectName: r.projectName, projectSlug: r.projectSlug },
    ]),
  );
}
