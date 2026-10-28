// SPDX-License-Identifier: AGPL-3.0-only
import { type ConnectionOptions, Queue } from "bullmq";
import { Cluster, Redis } from "ioredis";

/** Run jobs only. They are the work of users, so they get their own queue and workers. */
export const RUN_QUEUE = "zerodot-runs";
/** Cron, poll, retention and sweep jobs. A slow run cannot delay them. */
export const SYSTEM_QUEUE = "zerodot-system";

/** Workers only take jobs with the same version. Set ZERODOT_APP_VERSION in every deploy. */
export const APP_VERSION = process.env.ZERODOT_APP_VERSION ?? "dev";

/** A job holds only ids. All other data lives in Postgres. */
export type RunJob = { runId: string; organizationId: string; appVersion: string };

/** A scheduler makes this job on each tick. A worker turns it into a run. */
export type CronJob = {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  nodeId: string;
  timezone: string;
};

/** A poller makes this job on each interval. A worker asks the trigger node for news. */
export type PollJob = {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  nodeId: string;
  nodeType: string;
};

/** A daily scheduler makes this job. A worker deletes old insight rollups. */
export type StatsRetentionJob = Record<string, never>;

/** A daily scheduler makes this job. A worker deletes old runs. */
export type RunRetentionJob = Record<string, never>;

/** A scheduler makes this job each minute. A worker queues again the runs that lost their job. */
export type RunSweepJob = Record<string, never>;

export type QueueJob =
  | RunJob
  | CronJob
  | PollJob
  | StatsRetentionJob
  | RunRetentionJob
  | RunSweepJob;

export const RUN_JOB_NAME = "run";
export const CRON_JOB_NAME = "cron";
export const POLL_JOB_NAME = "poll";
export const STATS_RETENTION_JOB_NAME = "stats-retention";
export const RUN_RETENTION_JOB_NAME = "run-retention";
export const RUN_SWEEP_JOB_NAME = "run-sweep";

/** The worker saves the answer of a "respond to webhook" node here. The web app holds the request until it shows up. */
export const runResponseKey = (runId: string) => `zerodot:run-response:${runId}`;

export type ConnectionPlan =
  | { mode: "url"; url: string }
  | {
      mode: "sentinel";
      sentinels: { host: string; port: number }[];
      name: string;
      password?: string;
    }
  | { mode: "cluster"; url: string; password?: string };

function parseHostPort(value: string): { host: string; port: number } {
  const [host, port] = value.trim().split(":");
  const number = Number(port ?? 26379);
  if (!host || !Number.isInteger(number) || number <= 0) {
    throw new Error(`VALKEY_SENTINELS has a bad entry: "${value}". Use host:port.`);
  }
  return { host, port: number };
}

/**
 * Choose how to reach Valkey from the environment.
 * - `VALKEY_SENTINELS=host:port,host:port` with `VALKEY_SENTINEL_NAME` (default `mymaster`): Sentinel.
 * - `VALKEY_CLUSTER=true`: Cluster. `VALKEY_URL` is the first node. The client finds the others.
 * - Otherwise `VALKEY_URL` alone. This is the default.
 * `VALKEY_PASSWORD` is the password of the data nodes in Sentinel and Cluster mode.
 */
export function connectionPlan(
  url: string,
  env: Record<string, string | undefined> = process.env,
): ConnectionPlan {
  const password = env.VALKEY_PASSWORD || undefined;
  const sentinels = (env.VALKEY_SENTINELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentinels.length > 0) {
    return {
      mode: "sentinel",
      sentinels: sentinels.map(parseHostPort),
      name: env.VALKEY_SENTINEL_NAME || "mymaster",
      password,
    };
  }
  if (env.VALKEY_CLUSTER === "true") return { mode: "cluster", url, password };
  return { mode: "url", url };
}

/** In Cluster mode all keys of a queue must share one hash slot. The `{zerodot}` tag does that. */
export function queuePrefix(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.VALKEY_CLUSTER === "true" ? "{zerodot}" : undefined;
}

export function createConnection(
  url: string,
  options: { blocking?: boolean; env?: Record<string, string | undefined> } = {},
): Redis {
  // BullMQ workers need maxRetriesPerRequest: null for blocking commands.
  const maxRetriesPerRequest = options.blocking ? null : 3;
  const plan = connectionPlan(url, options.env);
  if (plan.mode === "sentinel") {
    return new Redis({
      sentinels: plan.sentinels,
      name: plan.name,
      password: plan.password,
      maxRetriesPerRequest,
    });
  }
  if (plan.mode === "cluster") {
    const parsed = new URL(plan.url);
    const cluster = new Cluster([{ host: parsed.hostname, port: Number(parsed.port || 6379) }], {
      redisOptions: {
        password: plan.password ?? (decodeURIComponent(parsed.password) || undefined),
        maxRetriesPerRequest,
      },
    });
    // Cluster has the same commands as Redis. Callers only use commands on one key.
    return cluster as unknown as Redis;
  }
  return new Redis(plan.url, { maxRetriesPerRequest });
}

const jobOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
} as const;

export function createRunQueue(connection: ConnectionOptions) {
  return new Queue<QueueJob>(RUN_QUEUE, {
    connection,
    prefix: queuePrefix(),
    defaultJobOptions: jobOptions,
  });
}

/** The queue of schedulers and housekeeping jobs. Same job options as the run queue. */
export function createSystemQueue(connection: ConnectionOptions) {
  return new Queue<QueueJob>(SYSTEM_QUEUE, {
    connection,
    prefix: queuePrefix(),
    defaultJobOptions: jobOptions,
  });
}

export type RunQueue = ReturnType<typeof createRunQueue>;
export type SystemQueue = ReturnType<typeof createSystemQueue>;

/** The job id is the run id, so a run is never queued twice. Test runs get a lower priority. */
export async function enqueueRun(
  queue: RunQueue,
  input: { runId: string; organizationId: string; mode: "production" | "test" },
) {
  await queue.add(
    RUN_JOB_NAME,
    { runId: input.runId, organizationId: input.organizationId, appVersion: APP_VERSION },
    { jobId: input.runId, priority: input.mode === "test" ? 10 : 1 },
  );
}

export * from "./admin";
export * from "./events";
export * from "./slots";

/**
 * Queue the same run again after a delay. The run waits in Valkey, not in a worker.
 * The job id is new each time, because BullMQ keeps the id of a finished job.
 */
export async function enqueueResume(
  queue: RunQueue,
  input: { runId: string; organizationId: string; delayMs: number },
) {
  await queue.add(
    RUN_JOB_NAME,
    { runId: input.runId, organizationId: input.organizationId, appVersion: APP_VERSION },
    {
      jobId: `${input.runId}:resume:${Date.now()}`,
      delay: Math.max(0, input.delayMs),
      priority: 1,
    },
  );
}

export type CronSchedule = CronJob & { expression: string };

const schedulerId = (s: Pick<CronSchedule, "workflowId" | "triggerId">) =>
  `cron:${s.workflowId}:${s.triggerId}`;

/**
 * Make the schedulers in the queue match `desired`. Schedulers under `prefix` that are not
 * in `desired` are removed. Use `cron:` for all schedulers, or `cron:<workflowId>:` for one workflow.
 */
export async function syncSchedulers(
  queue: SystemQueue,
  desired: CronSchedule[],
  prefix = "cron:",
) {
  const wanted = new Set(desired.map(schedulerId));
  const existing = await queue.getJobSchedulers(0, -1);
  for (const scheduler of existing) {
    const id = scheduler.key;
    if (id.startsWith(prefix) && !wanted.has(id)) await queue.removeJobScheduler(id);
  }
  for (const schedule of desired) {
    const { expression, ...data } = schedule;
    await queue.upsertJobScheduler(
      schedulerId(schedule),
      { pattern: expression, tz: schedule.timezone },
      { name: CRON_JOB_NAME, data, opts: { priority: 1 } },
    );
  }
}

export const workflowSchedulerPrefix = (workflowId: string) => `cron:${workflowId}:`;

export type PollSchedule = PollJob & { intervalSeconds: number };

const pollerId = (s: Pick<PollSchedule, "workflowId" | "triggerId">) =>
  `poll:${s.workflowId}:${s.triggerId}`;

/**
 * Make the pollers in the queue match `desired`, like `syncSchedulers` does for cron. Pollers
 * under `prefix` that are not in `desired` are removed.
 */
export async function syncPollers(queue: SystemQueue, desired: PollSchedule[], prefix = "poll:") {
  const wanted = new Set(desired.map(pollerId));
  const existing = await queue.getJobSchedulers(0, -1);
  for (const scheduler of existing) {
    const id = scheduler.key;
    if (id.startsWith(prefix) && !wanted.has(id)) await queue.removeJobScheduler(id);
  }
  for (const schedule of desired) {
    const { intervalSeconds, ...data } = schedule;
    await queue.upsertJobScheduler(
      pollerId(schedule),
      { every: intervalSeconds * 1000 },
      // One try. The next tick is the retry, and a retry would poll twice at once.
      { name: POLL_JOB_NAME, data, opts: { priority: 1, attempts: 1 } },
    );
  }
}

export const workflowPollerPrefix = (workflowId: string) => `poll:${workflowId}:`;

const STATS_RETENTION_SCHEDULER = "stats:retention";

/** Run the retention job once a day at 03:00 UTC. Safe to call at each worker start. */
export async function syncStatsRetention(queue: SystemQueue) {
  await queue.upsertJobScheduler(
    STATS_RETENTION_SCHEDULER,
    { pattern: "0 3 * * *", tz: "UTC" },
    { name: STATS_RETENTION_JOB_NAME, data: {}, opts: { priority: 10 } },
  );
}

const RUN_RETENTION_SCHEDULER = "runs:retention";

/** Delete old runs once a day at 03:30 UTC. Safe to call at each worker start. */
export async function syncRunRetention(queue: SystemQueue) {
  await queue.upsertJobScheduler(
    RUN_RETENTION_SCHEDULER,
    { pattern: "30 3 * * *", tz: "UTC" },
    { name: RUN_RETENTION_JOB_NAME, data: {}, opts: { priority: 10 } },
  );
}

const RUN_SWEEP_SCHEDULER = "runs:sweep";

/** Check every minute for runs that lost their job (for example after Valkey lost its data). */
export async function syncRunSweep(queue: SystemQueue) {
  await queue.upsertJobScheduler(
    RUN_SWEEP_SCHEDULER,
    { every: 60_000 },
    { name: RUN_SWEEP_JOB_NAME, data: {}, opts: { priority: 10, attempts: 1 } },
  );
}

/**
 * Before the split, schedulers lived in the run queue. Remove them there, or they fire twice.
 * Safe to call at each worker start. Returns the ids it removed.
 */
export async function removeLegacySchedulers(runQueue: RunQueue): Promise<string[]> {
  const legacy = [
    "cron:",
    "poll:",
    STATS_RETENTION_SCHEDULER,
    RUN_RETENTION_SCHEDULER,
    RUN_SWEEP_SCHEDULER,
  ];
  const removed: string[] = [];
  for (const scheduler of await runQueue.getJobSchedulers(0, -1)) {
    const id = scheduler.key;
    if (legacy.some((prefix) => id.startsWith(prefix))) {
      await runQueue.removeJobScheduler(id);
      removed.push(id);
    }
  }
  return removed;
}

const LIVE_STATES = new Set(["waiting", "active", "delayed", "prioritized", "waiting-children"]);

/**
 * The ids of runs that still have a job in the queue. `candidates` are checked by job id.
 * A resumed run has a job with another id, so the active jobs are read too.
 */
export async function findLiveRuns(queue: RunQueue, candidates: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  for (const job of await queue.getActive(0, 1000)) {
    const data = job.data as Partial<RunJob>;
    if (job.name === RUN_JOB_NAME && data.runId) live.add(data.runId);
  }
  for (const runId of candidates) {
    if (live.has(runId)) continue;
    const job = await queue.getJob(runId);
    if (job && LIVE_STATES.has(await job.getState())) live.add(runId);
  }
  return live;
}

export type QueueCounts = Record<
  "waiting" | "active" | "delayed" | "prioritized" | "failed" | "completed",
  number
>;

/** Job counts per state, for the metrics endpoint. */
export async function queueCounts(queue: RunQueue): Promise<QueueCounts> {
  const counts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "prioritized",
    "failed",
    "completed",
  );
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    prioritized: counts.prioritized ?? 0,
    failed: counts.failed ?? 0,
    completed: counts.completed ?? 0,
  };
}
