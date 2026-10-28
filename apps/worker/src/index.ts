// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { blobSetup } from "@zerodot/blob";
import {
  createDb,
  deleteOrphanBlobs,
  forOrganization,
  getNodePackages,
  listActiveCronSchedules,
  listActivePollSchedules,
  listStuckRuns,
  parseSecretKey,
  purgeRuns,
  purgeStats,
  runMigrations,
} from "@zerodot/db";
import { createSandboxClient } from "@zerodot/engine";
import { registry } from "@zerodot/nodes";
import { createPackageSyncer, mergeWanted } from "@zerodot/nodes/install";
import { parseNodePackages } from "@zerodot/nodes/load";
import {
  APP_VERSION,
  acquireSlots,
  CRON_JOB_NAME,
  type CronJob,
  createConnection,
  createRunQueue,
  createSystemQueue,
  enqueueResume,
  enqueueRun,
  findLiveRuns,
  listenForNodesChanged,
  POLL_JOB_NAME,
  type PollJob,
  type QueueJob,
  queueCounts,
  queuePrefix,
  RUN_JOB_NAME,
  RUN_QUEUE,
  RUN_RETENTION_JOB_NAME,
  RUN_SWEEP_JOB_NAME,
  type RunJob,
  removeLegacySchedulers,
  runSlotScopes,
  STATS_RETENTION_JOB_NAME,
  SYSTEM_QUEUE,
  slotRetryDelayMs,
  syncPollers,
  syncRunRetention,
  syncRunSweep,
  syncSchedulers,
  syncStatsRetention,
  WORKER_HEARTBEAT_MS,
} from "@zerodot/queue";
import { DelayedError, type Job, Worker } from "bullmq";
import {
  capCounterFor,
  countSafely,
  createActiveRuns,
  listenForCancel,
  startHeartbeat,
  workerInfo,
} from "./admin-runtime";
import { handleCronJob } from "./cron-job";
import { env } from "./env";
import { createListenManager, LISTEN_TICK_MS } from "./listen-manager";
import { log } from "./log";
import { renderMetrics } from "./metrics";
import { handlePollJob } from "./poll-job";
import { processRun } from "./process-run";
import { handleSweepJob } from "./sweep-job";

const database = createDb(env.DATABASE_URL, {
  max:
    env.ZERODOT_DB_POOL_MAX ?? env.ZERODOT_WORKER_CONCURRENCY + env.ZERODOT_SYSTEM_CONCURRENCY + 5,
});
// The worker can start before the web app. Both run migrations. A lock makes them take turns.
await runMigrations(database);

const syncNodePackages = createPackageSyncer(
  async () =>
    mergeWanted(
      parseNodePackages(process.env.ZERODOT_NODE_PACKAGES),
      await getNodePackages(database.db),
    ),
  (level, msg, fields) => log(level, msg, fields),
);
await syncNodePackages();
const eventsRedis = createConnection(env.VALKEY_URL);
const workerRedis = createConnection(env.VALKEY_URL, { blocking: true });
const systemWorkerRedis = createConnection(env.VALKEY_URL, { blocking: true });
const queue = createRunQueue(createConnection(env.VALKEY_URL));
const systemQueue = createSystemQueue(createConnection(env.VALKEY_URL));
const shutdown = new AbortController();
const workerId = randomUUID();
const startedAt = Date.now();
const activeRuns = createActiveRuns();
// A connection in subscribe mode cannot run other commands, so cancel messages get their own.
const cancelRedis = createConnection(env.VALKEY_URL);
const nodesRedis = createConnection(env.VALKEY_URL);

const deps = {
  db: database.db,
  redis: eventsRedis,
  runTimeoutMs: env.ZERODOT_RUN_TIMEOUT_MS,
  maxOutputBytes: env.ZERODOT_MAX_NODE_OUTPUT_BYTES,
  maxNodeRuns: env.ZERODOT_MAX_NODE_RUNS,
  envAllowlist: env.ZERODOT_ENV_ALLOWLIST,
  secretKey: parseSecretKey(env.ZERODOT_SECRET_KEY),
  baseUrl: env.ZERODOT_BASE_URL,
  tableMaxRows: env.ZERODOT_TABLE_MAX_ROWS,
  sandbox: env.SANDBOX_URL ? createSandboxClient(env.SANDBOX_URL) : undefined,
  scheduleResume: (input: { runId: string; organizationId: string; delayMs: number }) =>
    enqueueResume(queue, input),
  enqueueRun: ({ runId, organizationId }: { runId: string; organizationId: string }) =>
    enqueueRun(queue, { runId, organizationId, mode: "production" }),
};

const VERSION_RETRY_MS = 5000;

// Listen triggers keep a connection open. A lock in Valkey gives each trigger to one worker.
const listenManager = createListenManager({
  db: database.db,
  registry,
  secretKey: deps.secretKey,
  enqueueRun: ({ runId, organizationId }) =>
    enqueueRun(queue, { runId, organizationId, mode: "production" }),
  acquire: async (key, ttlMs) => {
    const token = randomUUID();
    if ((await eventsRedis.set(key, token, "PX", ttlMs, "NX")) !== "OK") return null;
    return {
      // Only the holder renews or gives the lock back.
      renew: async () =>
        (await eventsRedis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) end return 0',
          1,
          key,
          token,
          String(ttlMs),
        )) === 1,
      release: async () => {
        await eventsRedis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end',
          1,
          key,
          token,
        );
      },
    };
  },
  signal: shutdown.signal,
  maxTriggers: env.ZERODOT_MAX_LISTEN_TRIGGERS,
});

/** Cron, poll, retention and sweep jobs. They have their own queue and a small worker. */
async function handleSystemJob(job: Job<QueueJob>): Promise<void> {
  if (job.name === CRON_JOB_NAME) {
    await handleCronJob(
      {
        db: database.db,
        enqueueRun: ({ runId, organizationId }) =>
          enqueueRun(queue, { runId, organizationId, mode: "production" }),
      },
      job.data as CronJob,
      job,
    );
    return;
  }
  if (job.name === POLL_JOB_NAME) {
    await handlePollJob(
      {
        db: database.db,
        registry,
        secretKey: deps.secretKey,
        enqueueRun: ({ runId, organizationId }) =>
          enqueueRun(queue, { runId, organizationId, mode: "production" }),
        tryLock: async (key, ttlMs) => {
          const token = randomUUID();
          if ((await eventsRedis.set(key, token, "PX", ttlMs, "NX")) !== "OK") return null;
          return async () => {
            // Only the holder gives the lock back. A lock that expired may belong to a later poll.
            await eventsRedis.eval(
              'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end',
              1,
              key,
              token,
            );
          };
        },
        signal: shutdown.signal,
      },
      job.data as PollJob,
    );
    return;
  }
  if (job.name === STATS_RETENTION_JOB_NAME) {
    const before = new Date(Date.now() - env.ZERODOT_STATS_RETENTION_DAYS * 86_400_000);
    const deleted = await purgeStats(database.db, before);
    log("info", "stats.purged", {
      stats: { deletedRows: deleted, before: before.toISOString() },
    });
    return;
  }
  if (job.name === RUN_RETENTION_JOB_NAME) {
    const deleted = await purgeRuns(database.db, {
      testDays: env.ZERODOT_TEST_RUN_RETENTION_DAYS,
      defaultDays: env.ZERODOT_RUN_RETENTION_DAYS,
    });
    log("info", "runs.purged", { runs: deleted });
    // Runs are gone, so remove the files they left in the blob store.
    const blobStore = blobSetup()?.store;
    if (blobStore) {
      const removed = await deleteOrphanBlobs(database.db, blobStore);
      log("info", "blobs.purged", { blobs: { removed } });
    }
    return;
  }
  if (job.name === RUN_SWEEP_JOB_NAME) {
    const requeued = await handleSweepJob({
      listStuck: () =>
        listStuckRuns(database.db, {
          queuedBefore: new Date(Date.now() - env.ZERODOT_SWEEP_QUEUED_AFTER_MS),
          runningBefore: new Date(Date.now() - env.ZERODOT_RUN_TIMEOUT_MS * 2),
        }),
      findLive: (ids) => findLiveRuns(queue, ids),
      requeue: (run) =>
        enqueueResume(queue, { runId: run.id, organizationId: run.organizationId, delayMs: 0 }),
    });
    if (requeued > 0) {
      log("warn", "runs.swept", { runs: { requeued } });
      countSafely(eventsRedis, "sweeper_requeued", requeued);
    }
    return;
  }
  log("warn", "job.unknown_system_job", { job: { id: job.id, name: job.name } });
}

const worker = new Worker<QueueJob>(
  RUN_QUEUE,
  async (job: Job<QueueJob>, token?: string) => {
    // Schedulers lived in this queue before the split. A leftover tick is dropped.
    // The scheduler now lives in the system queue and makes the next tick there.
    if (job.name !== RUN_JOB_NAME) {
      log("warn", "job.legacy_dropped", { job: { id: job.id, name: job.name } });
      return;
    }
    const data = job.data as RunJob;
    // A worker with another app version leaves the job for a matching worker.
    if (data.appVersion !== APP_VERSION) {
      log("error", "job.version_mismatch", {
        job: { id: job.id },
        jobVersion: data.appVersion,
        workerVersion: APP_VERSION,
      });
      await job.moveToDelayed(Date.now() + VERSION_RETRY_MS, token);
      throw new DelayedError();
    }
    // Fair share: a project (and optionally a workflow) may use only so many slots at once.
    // A child run that a node waits for runs inside this job, so it does not take a slot.
    const workflowId =
      env.ZERODOT_WORKFLOW_MAX_CONCURRENT_RUNS > 0
        ? (await forOrganization(database.db, data.organizationId).runs.get(data.runId))?.workflowId
        : undefined;
    const lease = await acquireSlots(
      eventsRedis,
      runSlotScopes({
        organizationId: data.organizationId,
        workflowId,
        orgMax: env.ZERODOT_ORG_MAX_CONCURRENT_RUNS,
        workflowMax: env.ZERODOT_WORKFLOW_MAX_CONCURRENT_RUNS,
      }),
      `${data.runId}:${randomUUID()}`,
      {
        onLost: (key) => log("warn", "slot.lost", { run: { id: data.runId }, key }),
        onFull: (key) => countSafely(eventsRedis, capCounterFor(key)),
      },
    );
    if (!lease) {
      // No free slot. Try again soon. This does not use up an attempt.
      await job.moveToDelayed(Date.now() + slotRetryDelayMs(), token);
      throw new DelayedError();
    }
    const tracked = activeRuns.track(data.runId);
    try {
      await processRun(deps, data, shutdown.signal, tracked.signal);
    } finally {
      tracked.done();
      await lease.release();
    }
  },
  { connection: workerRedis, prefix: queuePrefix(), concurrency: env.ZERODOT_WORKER_CONCURRENCY },
);

const systemWorker = new Worker<QueueJob>(
  SYSTEM_QUEUE,
  (job: Job<QueueJob>) => handleSystemJob(job),
  {
    connection: systemWorkerRedis,
    prefix: queuePrefix(),
    concurrency: env.ZERODOT_SYSTEM_CONCURRENCY,
  },
);

let jobsCompleted = 0;
let jobsFailed = 0;
for (const w of [worker, systemWorker]) {
  w.on("completed", () => {
    jobsCompleted++;
  });
  w.on("failed", (job, error) => {
    jobsFailed++;
    log("error", "job.failed", { job: { id: job?.id }, error: error.message });
  });
}

const heartbeat = startHeartbeat(
  eventsRedis,
  () =>
    workerInfo({
      id: workerId,
      version: APP_VERSION,
      concurrency: env.ZERODOT_WORKER_CONCURRENCY,
      startedAt,
      activeRuns: activeRuns.ids(),
    }),
  WORKER_HEARTBEAT_MS,
);
// Without the listener, an admin cannot cancel a run. The worker still runs, so log and go on.
listenForNodesChanged(nodesRedis, () => void syncNodePackages()).catch((error) =>
  log("error", "nodes.subscribe_failed", { error: String(error) }),
);
listenForCancel(cancelRedis, activeRuns).catch((error) =>
  log("error", "cancel.subscribe_failed", { error: String(error) }),
);

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "worker", version: APP_VERSION }));
    return;
  }
  if (req.url === "/metrics") {
    Promise.all([queueCounts(queue), queueCounts(systemQueue)])
      .then(([runs, system]) => {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(
          renderMetrics({
            queues: [
              { queue: "runs", counts: runs },
              { queue: "system", counts: system },
            ],
            concurrency: [
              { queue: "runs", value: env.ZERODOT_WORKER_CONCURRENCY },
              { queue: "system", value: env.ZERODOT_SYSTEM_CONCURRENCY },
            ],
            runsProcessed: jobsCompleted,
            runsFailed: jobsFailed,
            version: APP_VERSION,
          }),
        );
      })
      .catch(() => res.writeHead(503).end());
    return;
  }
  res.writeHead(404).end();
});
// Schedulers moved to the system queue. Remove the old ones, or each tick would fire twice.
removeLegacySchedulers(queue)
  .then((removed) => {
    if (removed.length > 0) log("info", "scheduler.legacy_removed", { count: removed.length });
  })
  .catch((error) => log("error", "scheduler.legacy_remove_failed", { error: String(error) }));

// Schedulers live in Valkey. Rebuild them from Postgres, so a lost volume loses no schedule.
syncSchedulers(systemQueue, await listActiveCronSchedules(database.db))
  .then(() => log("info", "cron.synced"))
  .catch((error) => log("error", "cron.sync_failed", { error: String(error) }));

syncPollers(systemQueue, await listActivePollSchedules(database.db))
  .then(() => log("info", "poll.synced"))
  .catch((error) => log("error", "poll.sync_failed", { error: String(error) }));

syncStatsRetention(systemQueue).catch((error) =>
  log("error", "stats.retention_sync_failed", { error: String(error) }),
);

syncRunRetention(systemQueue).catch((error) =>
  log("error", "runs.retention_sync_failed", { error: String(error) }),
);

syncRunSweep(systemQueue).catch((error) =>
  log("error", "runs.sweep_sync_failed", { error: String(error) }),
);

void listenManager.reconcile();
const listenTimer = setInterval(() => void listenManager.reconcile(), LISTEN_TICK_MS);

// ZERODOT_BIND_HOST=127.0.0.1 keeps the port off the network when the app runs without Docker.
server.listen(env.PORT, process.env.ZERODOT_BIND_HOST ?? "0.0.0.0", () =>
  log("info", "worker.listening", { port: env.PORT }),
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log("info", "worker.stopping");
  // Stop taking jobs. Wait for current jobs. After the grace time, interrupt them.
  const timer = setTimeout(() => shutdown.abort(), env.ZERODOT_SHUTDOWN_GRACE_MS);
  clearInterval(listenTimer);
  await Promise.all([worker.close(), systemWorker.close()]);
  await listenManager.closeAll();
  await heartbeat.stop();
  cancelRedis.disconnect();
  nodesRedis.disconnect();
  clearTimeout(timer);
  server.close();
  await database.close();
  eventsRedis.disconnect();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
