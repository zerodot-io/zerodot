// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from "ioredis";

/**
 * Valkey keys and helpers for the admin page. Workers write; the web app reads and sends commands.
 * Everything here holds ids and counts only, never node data.
 */

export const RUN_CANCEL_CHANNEL = "zerodot:run-cancel";
/** An admin installed or removed a node package. Every process loads the change. */
export const NODES_CHANGED_CHANNEL = "zerodot:nodes-changed";
const WORKER_KEY_PREFIX = "zerodot:workers:";
const COUNTERS_KEY = "zerodot:counters";
export const WORKER_HEARTBEAT_MS = 10_000;
const WORKER_TTL_SECONDS = 30;

export type WorkerInfo = {
  id: string;
  host: string;
  version: string;
  concurrency: number;
  /** Run jobs this worker is running now. */
  activeRuns: string[];
  startedAt: number;
  lastSeenAt: number;
};

/** A worker calls this every `WORKER_HEARTBEAT_MS`. The key expires when the worker is gone. */
export async function writeHeartbeat(redis: Redis, info: WorkerInfo): Promise<void> {
  await redis.set(`${WORKER_KEY_PREFIX}${info.id}`, JSON.stringify(info), "EX", WORKER_TTL_SECONDS);
}

export async function removeHeartbeat(redis: Redis, id: string): Promise<void> {
  await redis.del(`${WORKER_KEY_PREFIX}${id}`);
}

export async function listWorkers(redis: Redis): Promise<WorkerInfo[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", `${WORKER_KEY_PREFIX}*`, "COUNT", 100);
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");
  if (keys.length === 0) return [];
  const values = await redis.mget(keys);
  const workers: WorkerInfo[] = [];
  for (const value of values) {
    if (!value) continue;
    try {
      workers.push(JSON.parse(value) as WorkerInfo);
    } catch {
      // A broken entry expires by itself.
    }
  }
  return workers.sort((a, b) => a.startedAt - b.startedAt);
}

/** Tell all workers to stop a run. The worker that has it aborts it. Returns the listener count. */
export function publishRunCancel(redis: Redis, runId: string): Promise<number> {
  return redis.publish(RUN_CANCEL_CHANNEL, runId);
}

/** Tell all web, API, and worker processes that the node packages changed. */
export function publishNodesChanged(redis: Redis): Promise<number> {
  return redis.publish(NODES_CHANGED_CHANNEL, "changed");
}

/** Calls `onChange` for each message. `subscriber` must be a connection that only subscribes. */
export async function listenForNodesChanged(
  subscriber: Redis,
  onChange: () => void,
): Promise<void> {
  subscriber.on("message", (channel: string) => {
    if (channel === NODES_CHANGED_CHANNEL) onChange();
  });
  await subscriber.subscribe(NODES_CHANGED_CHANNEL);
}

export type CounterName = "sweeper_requeued" | "org_cap_delayed" | "workflow_cap_delayed";

export async function bumpCounter(redis: Redis, name: CounterName, by = 1): Promise<void> {
  await redis.hincrby(COUNTERS_KEY, name, by);
}

export async function readCounters(redis: Redis): Promise<Record<CounterName, number>> {
  const raw = await redis.hgetall(COUNTERS_KEY);
  return {
    sweeper_requeued: Number(raw.sweeper_requeued ?? 0),
    org_cap_delayed: Number(raw.org_cap_delayed ?? 0),
    workflow_cap_delayed: Number(raw.workflow_cap_delayed ?? 0),
  };
}
