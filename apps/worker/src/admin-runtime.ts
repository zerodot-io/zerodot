// SPDX-License-Identifier: AGPL-3.0-only
import { hostname } from "node:os";
import {
  bumpCounter,
  type CounterName,
  RUN_CANCEL_CHANNEL,
  removeHeartbeat,
  type WorkerInfo,
  writeHeartbeat,
} from "@zerodot/queue";
import type { Redis } from "ioredis";
import { log } from "./log";

/** Run jobs in flight on this worker. A cancel message aborts the controller of its run. */
export function createActiveRuns() {
  const controllers = new Map<string, AbortController>();
  return {
    /** Start to track a run job. Call `done` when the job ends. */
    track(runId: string): { signal: AbortSignal; done: () => void } {
      const controller = new AbortController();
      controllers.set(runId, controller);
      return {
        signal: controller.signal,
        done: () => {
          // A later job for the same run may own the entry now.
          if (controllers.get(runId) === controller) controllers.delete(runId);
        },
      };
    },
    /** True when this worker has the run and aborted it. */
    cancel(runId: string): boolean {
      const controller = controllers.get(runId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    ids: (): string[] => [...controllers.keys()],
  };
}

export type ActiveRuns = ReturnType<typeof createActiveRuns>;

/** Listen for cancel messages. Use a connection that only subscribes. */
export async function listenForCancel(subscriber: Redis, active: ActiveRuns): Promise<void> {
  subscriber.on("message", (channel: string, runId: string) => {
    if (channel !== RUN_CANCEL_CHANNEL) return;
    if (active.cancel(runId)) log("info", "run.cancel_received", { run: { id: runId } });
  });
  await subscriber.subscribe(RUN_CANCEL_CHANNEL);
}

export function workerInfo(input: {
  id: string;
  version: string;
  concurrency: number;
  startedAt: number;
  activeRuns: string[];
  now?: number;
  host?: string;
}): WorkerInfo {
  return {
    id: input.id,
    host: input.host ?? hostname(),
    version: input.version,
    concurrency: input.concurrency,
    activeRuns: input.activeRuns,
    startedAt: input.startedAt,
    lastSeenAt: input.now ?? Date.now(),
  };
}

/** Write a heartbeat now and then every `intervalMs`. A write error is logged, never thrown. */
export function startHeartbeat(
  redis: Redis,
  build: () => WorkerInfo,
  intervalMs: number,
): { stop: () => Promise<void> } {
  const beat = () =>
    writeHeartbeat(redis, build()).catch((error) =>
      log("warn", "heartbeat.failed", { error: String(error) }),
    );
  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref();
  return {
    stop: async () => {
      clearInterval(timer);
      await removeHeartbeat(redis, build().id).catch(() => {});
    },
  };
}

/** Add to a counter without waiting. A counter error never fails the job. */
export function countSafely(redis: Redis, name: CounterName, by = 1): void {
  if (by <= 0) return;
  bumpCounter(redis, name, by).catch((error) =>
    log("warn", "counter.failed", { counter: name, error: String(error) }),
  );
}

/** Which counter a full slot scope adds to. */
export function capCounterFor(slotKey: string): CounterName {
  return slotKey.startsWith("zerodot:slots:workflow:") ? "workflow_cap_delayed" : "org_cap_delayed";
}
