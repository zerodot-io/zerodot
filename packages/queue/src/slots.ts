// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from "ioredis";

/** A slot that is not renewed in this time is free again. A crashed worker frees its slots so. */
export const SLOT_TTL_MS = 30_000;

// KEYS[1] sorted set of holders, score = expiry time in ms. ARGV: holder, limit, ttl ms.
// The script uses the Valkey clock, so workers with a wrong clock cannot steal slots.
// A holder that is in the set already keeps its slot, so a repeated call is safe.
const ACQUIRE = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now)
if redis.call("ZSCORE", KEYS[1], ARGV[1]) == false and redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[3]))
return 1
`;

// Renew only a slot that still exists. A slot that expired may belong to another holder now.
const RENEW = `
local t = redis.call("TIME")
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if redis.call("ZSCORE", KEYS[1], ARGV[1]) == false then return 0 end
redis.call("ZADD", KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
return 1
`;

export const orgSlotKey = (organizationId: string) => `zerodot:slots:org:${organizationId}`;
export const workflowSlotKey = (workflowId: string) => `zerodot:slots:workflow:${workflowId}`;

export type SlotScope = { key: string; limit: number };

export type SlotLease = {
  /** Gives all slots back and stops the renewal. Safe to call twice. */
  release(): Promise<void>;
};

/**
 * Take one slot in each scope, or none. A scope with `limit` 0 or less has no cap and is skipped.
 * Returns null when a scope is full. While the lease is held, the slots are renewed.
 * Each scope uses one key, so this also works in Cluster mode.
 */
export async function acquireSlots(
  redis: Redis,
  scopes: SlotScope[],
  holder: string,
  options: {
    ttlMs?: number;
    onLost?: (key: string) => void;
    /** Called with the key of the scope that was full, before this returns null. */
    onFull?: (key: string) => void;
  } = {},
): Promise<SlotLease | null> {
  const ttlMs = options.ttlMs ?? SLOT_TTL_MS;
  const taken: string[] = [];
  const give = async (keys: string[]) => {
    for (const key of keys) await redis.zrem(key, holder).catch(() => {});
  };
  for (const scope of scopes) {
    if (scope.limit <= 0) continue;
    const ok = await redis.eval(ACQUIRE, 1, scope.key, holder, String(scope.limit), String(ttlMs));
    if (ok !== 1) {
      options.onFull?.(scope.key);
      await give(taken);
      return null;
    }
    taken.push(scope.key);
  }
  if (taken.length === 0) return { release: async () => {} };

  let released = false;
  const timer = setInterval(
    () => {
      for (const key of taken) {
        redis
          .eval(RENEW, 1, key, holder, String(ttlMs))
          .then((ok) => {
            if (ok !== 1) options.onLost?.(key);
          })
          .catch(() => {});
      }
    },
    Math.max(1000, Math.floor(ttlMs / 3)),
  );
  timer.unref();
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await give(taken);
    },
  };
}

/** How long a job waits before it asks for a slot again. Jitter stops all jobs from coming at once. */
export function slotRetryDelayMs(random: () => number = Math.random): number {
  return 1000 + Math.floor(random() * 2000);
}

/** The slot scopes of one run. Without a workflow id, only the project cap applies. */
export function runSlotScopes(input: {
  organizationId: string;
  workflowId?: string;
  orgMax: number;
  workflowMax: number;
}): SlotScope[] {
  const scopes: SlotScope[] = [{ key: orgSlotKey(input.organizationId), limit: input.orgMax }];
  if (input.workflowId) {
    scopes.push({ key: workflowSlotKey(input.workflowId), limit: input.workflowMax });
  }
  return scopes;
}
