// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A small cache in the process for the webhook lookup by token. Each webhook call needs the
 * trigger row. The row changes only when someone publishes, activates, or deactivates a workflow.
 *
 * An entry ends by time only. There is no other invalidation. So a workflow that someone
 * deactivates can still get calls for up to `ttlMs` (default 5 seconds) in each API process.
 * A token that is unknown is kept for a shorter time (`missTtlMs`, default 2 seconds), so a new
 * webhook starts to work fast. The cache holds at most `maxEntries` tokens. The oldest go first.
 * Callers that guess many tokens cannot fill the memory.
 */
export type TriggerCache<T> = {
  get(token: string, load: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
  readonly size: number;
};

export function createTriggerCache<T>(options: {
  ttlMs: number;
  missTtlMs: number;
  maxEntries: number;
  now?: () => number;
}): TriggerCache<T> {
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: Promise<T | null>; expires: number }>();
  return {
    get(token, load) {
      const t = now();
      const hit = entries.get(token);
      if (hit && hit.expires > t) return hit.value;
      entries.delete(token);
      if (options.ttlMs <= 0) return load();
      // Same lookup for calls that come at the same time. A failure is not kept.
      const entry = { value: load(), expires: t + options.ttlMs };
      entries.set(token, entry);
      entry.value.then(
        (row) => {
          if (row === null) entry.expires = Math.min(entry.expires, now() + options.missTtlMs);
        },
        () => {
          if (entries.get(token) === entry) entries.delete(token);
        },
      );
      while (entries.size > options.maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return entry.value;
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
