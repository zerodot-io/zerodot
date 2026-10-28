// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Counts the requests that this process holds open while they wait for a run.
 * A held request uses memory, a timer, and a database poll. The cap keeps a burst from using
 * all of them. The count is for one process. Each API process has its own cap.
 */
export type HeldLimiter = {
  /** Returns a release function, or null when the cap is reached. Release is safe to call twice. */
  acquire(): (() => void) | null;
  /** Number of requests that are held now. */
  readonly active: number;
  readonly max: number;
};

export function createHeldLimiter(max: number): HeldLimiter {
  let active = 0;
  return {
    max,
    get active() {
      return active;
    },
    acquire() {
      if (active >= max) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
      };
    },
  };
}

/** Seconds that a client waits before it tries again when the cap is reached. */
export const HELD_RETRY_AFTER_SECONDS = 5;
