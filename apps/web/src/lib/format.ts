// SPDX-License-Identifier: AGPL-3.0-only
export function formatDuration(start: Date | null, end: Date | null): string {
  if (!start) return "–";
  const ms = (end ?? new Date()).getTime() - start.getTime();
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function formatTime(date: Date | null): string {
  return date ? date.toLocaleString() : "–";
}
