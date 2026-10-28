// SPDX-License-Identifier: AGPL-3.0-only
import { percentileFromHistogram } from "@zerodot/db/stats-math";

export const RANGES = {
  "24h": { label: "24 hours", ms: 24 * 3_600_000 },
  "7d": { label: "7 days", ms: 7 * 24 * 3_600_000 },
  "30d": { label: "30 days", ms: 30 * 24 * 3_600_000 },
  "90d": { label: "90 days", ms: 90 * 24 * 3_600_000 },
} as const;

export type RangeKey = keyof typeof RANGES;

export const METRICS = [
  "runs",
  "failed",
  "failureRate",
  "avgMs",
  "p95Ms",
  "timeSavedMinutes",
] as const;

export type Metric = (typeof METRICS)[number];

/** One range, as the tiles and the chart show it. Null means there is no value. */
export type Kpis = {
  runs: number;
  succeeded: number;
  failed: number;
  failureRate: number | null;
  avgMs: number | null;
  p95Ms: number | null;
  timeSavedMinutes: number | null;
};

type Counts = {
  succeeded: number;
  failed: number;
  cancelled: number;
  durationSumMs: number;
  durationBuckets: number[];
};

export function durationStats(counts: Counts) {
  const runs = counts.succeeded + counts.failed + counts.cancelled;
  return {
    runs,
    avgMs: runs === 0 ? null : counts.durationSumMs / runs,
    p95Ms: percentileFromHistogram(counts.durationBuckets, 0.95),
    failureRate: runs === 0 ? null : counts.failed / runs,
  };
}

export function toKpis(
  counts: Counts & { timeSavedMinutes: number; hasTimeSaved?: boolean },
): Kpis {
  return {
    ...durationStats(counts),
    succeeded: counts.succeeded,
    failed: counts.failed,
    timeSavedMinutes: counts.hasTimeSaved === false ? null : counts.timeSavedMinutes,
  };
}

export type NodeRow = {
  workflowId: string;
  workflowName: string;
  nodeType: string;
  nodeId: string;
  /** The name in the draft graph. Null when the node is gone. */
  nodeName: string | null;
  runs: number;
  failed: number;
  avgMs: number | null;
  p95Ms: number | null;
};

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export function formatPercent(rate: number): string {
  const percent = rate * 100;
  return `${percent < 10 && percent > 0 ? percent.toFixed(1) : Math.round(percent)}%`;
}

export function formatValue(metric: Metric, value: number | null, estimate = false): string {
  if (value === null) return "–";
  switch (metric) {
    case "failureRate":
      return formatPercent(value);
    case "avgMs":
      return formatMs(value);
    case "p95Ms":
      return `${estimate ? "~" : ""}${formatMs(value)}`;
    case "timeSavedMinutes":
      return formatMinutes(value);
    default:
      return Math.round(value).toLocaleString();
  }
}

/** Change against the previous range. Null when the previous value is zero or missing. */
export function formatChange(
  metric: Metric,
  current: number | null,
  previous: number | null,
): string | null {
  if (current === null || previous === null) return null;
  if (metric === "failureRate") {
    const points = (current - previous) * 100;
    if (Math.abs(points) < 0.05) return "0 pp";
    return `${points > 0 ? "+" : "−"}${Math.abs(points).toFixed(1)} pp`;
  }
  if (previous === 0) return current === 0 ? "0%" : null;
  const percent = ((current - previous) / previous) * 100;
  if (Math.abs(percent) < 0.5) return "0%";
  return `${percent > 0 ? "+" : "−"}${Math.abs(Math.round(percent))}%`;
}

export const METRIC_LABEL: Record<Metric, string> = {
  runs: "Production runs",
  failed: "Failed runs",
  failureRate: "Failure rate",
  avgMs: "Average duration",
  p95Ms: "p95 duration",
  timeSavedMinutes: "Time saved",
};
