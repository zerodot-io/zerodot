// SPDX-License-Identifier: AGPL-3.0-only

/** A worker is stale when its last heartbeat is older than this. */
export const STALE_WORKER_MS = 20_000;

/** Short age: "4s", "3m", "2h 5m", "3d". Negative values count as zero. */
export function formatAge(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

export function isStaleWorker(lastSeenAt: number, now: number): boolean {
  return now - lastSeenAt > STALE_WORKER_MS;
}
