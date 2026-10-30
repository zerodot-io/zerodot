// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from "ioredis";

const WAKE_CHANNEL = "zerodot:run-wake";

/**
 * Tell the API processes that a run has news: it ended, or a Respond to Webhook node saved its
 * answer. A lost message costs nothing, because a waiter still polls at a slow rate.
 */
export async function notifyRun(redis: Redis, runId: string): Promise<void> {
  await redis.publish(WAKE_CHANNEL, runId).catch(() => {});
}

/** One wait for one run. Create it before you read the state, so no wake is lost. */
export type RunWake = {
  /** Resolves on a wake, on an abort, or after `ms`. */
  wait(ms: number): Promise<void>;
  /** Always call this when the wait is over. */
  disarm(): void;
};

export type RunWaiter = {
  arm(runId: string, signal?: AbortSignal): RunWake;
};

/**
 * Holds the waiters of one process. It takes one Valkey subscription for all of them.
 * `subscriber` must be a connection that only the waiter uses.
 */
export function createRunWaiter(subscriber: Redis): RunWaiter {
  const waiting = new Map<string, Set<() => void>>();
  let subscribed = false;

  const subscribe = () => {
    if (subscribed) return;
    subscribed = true;
    subscriber.on("message", (channel: string, runId: string) => {
      if (channel !== WAKE_CHANNEL) return;
      for (const fire of [...(waiting.get(runId) ?? [])]) fire();
    });
    // The client subscribes again after a reconnect. If the first try fails, the next arm retries.
    subscriber.subscribe(WAKE_CHANNEL).catch(() => {
      subscribed = false;
    });
  };

  return {
    arm(runId, signal) {
      subscribe();
      let woken = false;
      let release: (() => void) | undefined;
      const fire = () => {
        woken = true;
        release?.();
      };
      const set = waiting.get(runId) ?? new Set<() => void>();
      set.add(fire);
      waiting.set(runId, set);
      signal?.addEventListener("abort", fire, { once: true });
      return {
        wait(ms) {
          return new Promise<void>((resolve) => {
            if (woken || signal?.aborted) return resolve();
            const timer = setTimeout(done, ms);
            release = done;
            function done() {
              clearTimeout(timer);
              release = undefined;
              resolve();
            }
          });
        },
        disarm() {
          set.delete(fire);
          if (set.size === 0) waiting.delete(runId);
          signal?.removeEventListener("abort", fire);
        },
      };
    },
  };
}
