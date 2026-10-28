// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AuditRow,
  type Db,
  findRunAnyOrganization,
  firstUserId,
  forOrganization,
  getSignupDisabled,
  listAudit,
  recordAudit,
  runThroughput,
  setSignupDisabled,
  type Throughput,
  workflowLabels,
} from "@zerodot/db";
import {
  type CounterName,
  listWorkers,
  publishRunCancel,
  publishRunEvent,
  type QueueCounts,
  queueCounts,
  RUN_JOB_NAME,
  RUN_QUEUE,
  type RunQueue,
  readCounters,
  SYSTEM_QUEUE,
  type WorkerInfo,
} from "@zerodot/queue";
import type { Redis } from "ioredis";
import { conflict, notFound } from "./api/errors";
import { getServices } from "./services.server";
import { sessionFor } from "./session.server";

/**
 * The System page. Only instance admins can use it. Every function holds ids and counts only.
 * No function returns `job.data` or node data.
 */

// ---- Who is an instance admin ----

export type AdminConfig = {
  /** ZERODOT_ADMIN_UI. When false, every admin function acts as if the page does not exist. */
  enabled: boolean;
  /** ZERODOT_ADMIN_EMAILS, lower case. When empty, the first user to sign up is the admin. */
  emails: string[];
};

export function adminConfig(env: Record<string, string | undefined> = process.env): AdminConfig {
  const emails = (env.ZERODOT_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
  return { enabled: (env.ZERODOT_ADMIN_UI ?? "true").trim().toLowerCase() !== "false", emails };
}

export type AdminUser = { id: string; email: string };

/** The rule, with no I/O. `firstUser` is the id of the earliest user. */
export function matchesAdminRule(
  user: AdminUser,
  config: AdminConfig,
  firstUser: string | null,
): boolean {
  if (!config.enabled) return false;
  if (config.emails.length > 0) return config.emails.includes(user.email.trim().toLowerCase());
  return firstUser !== null && firstUser === user.id;
}

export async function isInstanceAdmin(
  user: AdminUser,
  options: { db?: Db; config?: AdminConfig } = {},
): Promise<boolean> {
  const config = options.config ?? adminConfig();
  if (!config.enabled) return false;
  // With a list, the database is not needed.
  if (config.emails.length > 0) return matchesAdminRule(user, config, null);
  const db = options.db ?? (await getServices()).db;
  return matchesAdminRule(user, config, await firstUserId(db));
}

/**
 * Read the session from the request headers. Throws 404 when the page is off, the caller is
 * signed out, or the caller is not an instance admin. 404 hides that the page exists.
 */
export async function requireInstanceAdmin(headers: Headers): Promise<AdminUser> {
  if (!adminConfig().enabled) throw notFound("Page");
  const { session } = await sessionFor(headers);
  if (!session || !(await isInstanceAdmin(session.user))) throw notFound("Page");
  return { id: session.user.id, email: session.user.email };
}

// ---- Types ----

export const QUEUE_NAMES = ["runs", "system"] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

export const JOB_STATES = [
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "failed",
  "completed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** States that `cleanQueue` can clear. Active jobs are never cleaned. */
export const CLEAN_STATES = ["completed", "failed", "delayed", "waiting", "prioritized"] as const;
export type CleanState = (typeof CLEAN_STATES)[number];

export type AdminQueue = RunQueue;
type QueueJobHandle = NonNullable<Awaited<ReturnType<AdminQueue["getJob"]>>>;

export type AdminDeps = {
  db: Db;
  redis: Redis;
  queues: Record<QueueName, AdminQueue>;
  now?: () => number;
};

export type QueueOverview = {
  name: QueueName;
  /** The BullMQ name. */
  queueName: string;
  counts: QueueCounts;
  paused: boolean;
  /** Age in ms of the oldest waiting job. Null when no job waits. Read from the first 100 jobs. */
  oldestWaitingMs: number | null;
};

export type AdminOverview = {
  queues: QueueOverview[];
  workers: WorkerInfo[];
  counters: Record<CounterName, number>;
  audit: AuditRow[];
  /** Runs per minute for the last hour. */
  throughput: Throughput;
};

export type JobSummary = {
  id: string;
  name: string;
  runId: string | null;
  organizationId: string | null;
  workflowId: string | null;
  /** Null when the workflow is gone or the job has no workflow. */
  workflowName: string | null;
  projectName: string | null;
  projectSlug: string | null;
  attemptsMade: number;
  /** At most 300 characters. */
  failedReason: string | null;
  /** When the job was added (ms since epoch). */
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
};

export type CancelRunResult = {
  runId: string;
  /** True when the run was already finished. Nothing changed. */
  alreadyFinished: boolean;
  status: string;
  removedJobs: number;
};

// ---- Pure helpers ----

const FAILED_REASON_MAX = 300;
const THROUGHPUT_MINUTES = 60;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function truncateReason(reason: string | undefined | null): string | null {
  if (!reason) return null;
  return reason.length > FAILED_REASON_MAX ? `${reason.slice(0, FAILED_REASON_MAX - 1)}…` : reason;
}

function idField(data: unknown, key: string): string | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Pick ids from a job. This is the only place that reads `job.data`. */
export function summarizeJob(job: {
  id?: string;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason?: string;
  timestamp: number;
  processedOn?: number;
  finishedOn?: number;
}): JobSummary {
  return {
    id: job.id ?? "",
    name: job.name,
    runId: idField(job.data, "runId"),
    organizationId: idField(job.data, "organizationId"),
    workflowId: idField(job.data, "workflowId"),
    workflowName: null,
    projectName: null,
    projectSlug: null,
    attemptsMade: job.attemptsMade,
    failedReason: truncateReason(job.failedReason),
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
  };
}

/** Age of the oldest job in ms, or null with no jobs. */
export function oldestAgeMs(timestamps: number[], now: number): number | null {
  if (timestamps.length === 0) return null;
  return Math.max(0, now - Math.min(...timestamps));
}

function pickQueue(deps: AdminDeps, name: QueueName): AdminQueue {
  const queue = deps.queues[name];
  if (!queue) throw notFound("Queue");
  return queue;
}

async function findJob(queue: AdminQueue, jobId: string): Promise<QueueJobHandle> {
  const job = await queue.getJob(jobId);
  if (!job) throw notFound("Job");
  return job;
}

// ---- Operations ----

/** The operations, with their dependencies given. `actor` must come from `requireInstanceAdmin`. */
export function createAdminOps(deps: AdminDeps) {
  const now = () => (deps.now ?? Date.now)();

  const audit = (
    actor: AdminUser,
    action: string,
    targetType: string,
    targetId: string,
    details?: Record<string, string | number | boolean | null>,
  ) => recordAudit(deps.db, { actor, action, targetType, targetId, details });

  async function queueOverview(name: QueueName): Promise<QueueOverview> {
    const queue = pickQueue(deps, name);
    const [counts, paused, waiting, prioritized] = await Promise.all([
      queueCounts(queue),
      queue.isPaused(),
      queue.getJobs(["waiting"], 0, 99, true),
      queue.getJobs(["prioritized"], 0, 99, true),
    ]);
    return {
      name,
      queueName: queue.name,
      counts,
      paused,
      oldestWaitingMs: oldestAgeMs(
        [...waiting, ...prioritized].map((j) => j.timestamp),
        now(),
      ),
    };
  }

  /** Remove the jobs of a run that wait or are delayed. An active job stays: the worker aborts it. */
  async function removeRunJobs(runId: string): Promise<number> {
    const queue = deps.queues.runs;
    let removed = 0;
    const jobs = await queue.getJobs(["waiting", "delayed", "prioritized"], 0, 4999);
    for (const job of jobs) {
      if (job.name !== RUN_JOB_NAME || idField(job.data, "runId") !== runId) continue;
      try {
        await job.remove();
        removed += 1;
      } catch {
        // A worker took the job at this moment. The cancel message stops it.
      }
    }
    return removed;
  }

  return {
    async overview(): Promise<AdminOverview> {
      const [queues, workers, counters, auditRows, throughput] = await Promise.all([
        Promise.all(QUEUE_NAMES.map(queueOverview)),
        listWorkers(deps.redis),
        readCounters(deps.redis),
        listAudit(deps.db, 20),
        runThroughput(deps.db, THROUGHPUT_MINUTES, now()),
      ]);
      return { queues, workers, counters, audit: auditRows, throughput };
    },

    async listJobs(input: { queue: QueueName; state: JobState; limit?: number }) {
      const queue = pickQueue(deps, input.queue);
      const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 50)), 200);
      const jobs = await queue.getJobs([input.state], 0, limit - 1, false);
      const rows = jobs.map(summarizeJob);
      const labels = await workflowLabels(
        deps.db,
        rows.flatMap((r) => (r.workflowId ? [r.workflowId] : [])),
      );
      return rows.map((r) => {
        const label = r.workflowId ? labels.get(r.workflowId) : undefined;
        return label
          ? {
              ...r,
              workflowName: label.name,
              projectName: label.projectName,
              projectSlug: label.projectSlug,
            }
          : r;
      });
    },

    /** Idempotent. A finished run stays as it is. */
    async cancelRun(actor: AdminUser, runId: string): Promise<CancelRunResult> {
      if (!UUID.test(runId)) throw notFound("Run");
      const found = await findRunAnyOrganization(deps.db, runId);
      if (!found) throw notFound("Run");
      const alreadyFinished = !ACTIVE_RUN_STATUSES.has(found.status);
      let status: string = found.status;
      if (!alreadyFinished) {
        const error = { message: "Cancelled by an administrator" };
        const scope = forOrganization(deps.db, found.organizationId);
        const row = await scope.runs.finish(runId, { status: "cancelled", error });
        status = row?.status ?? "cancelled";
        await publishRunEvent(deps.redis, found.organizationId, {
          type: "run.finished",
          runId,
          status: "cancelled",
          error,
        });
        // The worker that holds the run aborts it.
        await publishRunCancel(deps.redis, runId);
      }
      const removedJobs = await removeRunJobs(runId);
      if (!alreadyFinished) {
        await audit(actor, "run.cancel", "run", runId, {
          organizationId: found.organizationId,
          removedJobs,
        });
      }
      return { runId, alreadyFinished, status, removedJobs };
    },

    async retryJob(actor: AdminUser, input: { queue: QueueName; jobId: string }) {
      const job = await findJob(pickQueue(deps, input.queue), input.jobId);
      const state = await job.getState();
      if (state !== "failed" && state !== "completed") {
        throw conflict(`A job in state "${state}" cannot be retried`);
      }
      await job.retry(state);
      await audit(actor, "job.retry", "job", input.jobId, { queue: input.queue, state });
      return { ok: true as const };
    },

    async removeJob(actor: AdminUser, input: { queue: QueueName; jobId: string }) {
      const job = await findJob(pickQueue(deps, input.queue), input.jobId);
      if ((await job.getState()) === "active")
        throw conflict("Cancel the run to stop an active job");
      await job.remove();
      await audit(actor, "job.remove", "job", input.jobId, { queue: input.queue });
      return { ok: true as const };
    },

    /** Removes up to 1000 jobs in one state that are older than `olderThanMs`. Returns the count. */
    async cleanQueue(
      actor: AdminUser,
      input: { queue: QueueName; state: CleanState; olderThanMs: number },
    ) {
      const queue = pickQueue(deps, input.queue);
      const ids = await queue.clean(
        Math.max(0, input.olderThanMs),
        1000,
        input.state === "waiting" ? "wait" : input.state,
      );
      await audit(actor, "queue.clean", "queue", input.queue, {
        state: input.state,
        olderThanMs: input.olderThanMs,
        removed: ids.length,
      });
      return { removed: ids.length };
    },

    async promoteDelayedJob(actor: AdminUser, input: { queue: QueueName; jobId: string }) {
      const job = await findJob(pickQueue(deps, input.queue), input.jobId);
      if ((await job.getState()) !== "delayed")
        throw conflict("Only a delayed job can be promoted");
      await job.promote();
      await audit(actor, "job.promote", "job", input.jobId, { queue: input.queue });
      return { ok: true as const };
    },

    async pauseQueue(actor: AdminUser, input: { queue: QueueName }) {
      await pickQueue(deps, input.queue).pause();
      await audit(actor, "queue.pause", "queue", input.queue);
      return { ok: true as const };
    },

    async resumeQueue(actor: AdminUser, input: { queue: QueueName }) {
      await pickQueue(deps, input.queue).resume();
      await audit(actor, "queue.resume", "queue", input.queue);
      return { ok: true as const };
    },
  };
}

// ---- Entry points. Each one checks the caller first. ----

async function ops() {
  const { db, redis, queue, systemQueue } = await getServices();
  return createAdminOps({ db, redis, queues: { runs: queue, system: systemQueue } });
}

/** The queue names for display. */
export const QUEUE_LABELS: Record<QueueName, string> = { runs: RUN_QUEUE, system: SYSTEM_QUEUE };

export async function adminOverview(headers: Headers) {
  await requireInstanceAdmin(headers);
  return (await ops()).overview();
}

export async function listQueueJobs(
  headers: Headers,
  input: { queue: QueueName; state: JobState; limit?: number },
) {
  await requireInstanceAdmin(headers);
  return (await ops()).listJobs(input);
}

export async function cancelRun(headers: Headers, runId: string) {
  return (await ops()).cancelRun(await requireInstanceAdmin(headers), runId);
}

export async function retryJob(headers: Headers, input: { queue: QueueName; jobId: string }) {
  return (await ops()).retryJob(await requireInstanceAdmin(headers), input);
}

export async function removeJob(headers: Headers, input: { queue: QueueName; jobId: string }) {
  return (await ops()).removeJob(await requireInstanceAdmin(headers), input);
}

export async function cleanQueue(
  headers: Headers,
  input: { queue: QueueName; state: CleanState; olderThanMs: number },
) {
  return (await ops()).cleanQueue(await requireInstanceAdmin(headers), input);
}

export async function promoteDelayedJob(
  headers: Headers,
  input: { queue: QueueName; jobId: string },
) {
  return (await ops()).promoteDelayedJob(await requireInstanceAdmin(headers), input);
}

export async function pauseQueue(headers: Headers, input: { queue: QueueName }) {
  return (await ops()).pauseQueue(await requireInstanceAdmin(headers), input);
}

export async function resumeQueue(headers: Headers, input: { queue: QueueName }) {
  return (await ops()).resumeQueue(await requireInstanceAdmin(headers), input);
}

// ---- Public signup ----

export type SignupSetting = {
  /** The admin switch. */
  disabled: boolean;
  /** True when ZERODOT_SIGNUP_DISABLED=true. Signup is off and the switch cannot turn it on. */
  lockedByEnv: boolean;
};

export async function getSignupSetting(headers: Headers): Promise<SignupSetting> {
  await requireInstanceAdmin(headers);
  const { db, config } = await getServices();
  return { disabled: await getSignupDisabled(db), lockedByEnv: config.ZERODOT_SIGNUP_DISABLED };
}

export async function updateSignupSetting(
  headers: Headers,
  input: { disabled: boolean },
): Promise<SignupSetting> {
  const actor = await requireInstanceAdmin(headers);
  const { db, config } = await getServices();
  await setSignupDisabled(db, input.disabled);
  await recordAudit(db, {
    actor,
    action: "signup.set",
    targetType: "instance",
    targetId: "signup",
    details: { disabled: input.disabled },
  });
  return { disabled: input.disabled, lockedByEnv: config.ZERODOT_SIGNUP_DISABLED };
}
