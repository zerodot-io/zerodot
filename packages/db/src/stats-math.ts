// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Duration histogram. Bucket `i` holds durations up to 2^i ms, so bucket 0 is 0 to 1 ms.
 * The last bucket also holds everything above its bound (about 70 minutes).
 */
export const HISTOGRAM_BUCKETS = 24;

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKETS).fill(0);
}

export function histogramIndex(durationMs: number): number {
  if (!(durationMs > 1)) return 0;
  return Math.min(HISTOGRAM_BUCKETS - 1, Math.ceil(Math.log2(durationMs)));
}

/** A histogram with one count. */
export function histogramOf(durationMs: number): number[] {
  const histogram = emptyHistogram();
  histogram[histogramIndex(durationMs)] = 1;
  return histogram;
}

export function addHistograms(a: number[], b: number[]): number[] {
  return Array.from({ length: HISTOGRAM_BUCKETS }, (_, i) => (a[i] ?? 0) + (b[i] ?? 0));
}

/**
 * Estimate a percentile from a histogram. The estimate moves in a straight line
 * inside the bucket that holds the percentile. Returns null for an empty histogram.
 */
export function percentileFromHistogram(histogram: number[], p: number): number | null {
  const total = histogram.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const target = total * p;
  let seen = 0;
  for (let i = 0; i < histogram.length; i++) {
    const count = histogram[i] ?? 0;
    if (count > 0 && seen + count >= target) {
      const lower = i === 0 ? 0 : 2 ** (i - 1);
      const upper = 2 ** i;
      return lower + ((target - seen) / count) * (upper - lower);
    }
    seen += count;
  }
  return 2 ** (histogram.length - 1);
}

export const HOUR_MS = 3_600_000;

/** Start of the UTC hour that holds `date`. */
export function hourStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

export type Granularity = "hour" | "day" | "week";

/** Hour up to 2 days, day up to 90 days, week above that. */
export function granularityFor(rangeMs: number): Granularity {
  if (rangeMs <= 2 * 24 * HOUR_MS) return "hour";
  if (rangeMs <= 90 * 24 * HOUR_MS) return "day";
  return "week";
}

const DAY_MS = 24 * HOUR_MS;

/** Start of the UTC bucket that holds `date`. A week starts on Monday, as in Postgres. */
export function bucketStartOf(date: Date, granularity: Granularity): Date {
  const hour = hourStart(date).getTime();
  if (granularity === "hour") return new Date(hour);
  const day = Math.floor(hour / DAY_MS) * DAY_MS;
  if (granularity === "day") return new Date(day);
  // 1970-01-01 was a Thursday. Days since the last Monday: (day index + 3) mod 7.
  const sinceMonday = (Math.floor(day / DAY_MS) + 3) % 7;
  return new Date(day - sinceMonday * DAY_MS);
}

/** Every bucket start from the bucket of `from` up to, but not including, `to`. */
export function bucketStarts(from: Date, to: Date, granularity: Granularity): Date[] {
  const out: Date[] = [];
  let at = bucketStartOf(from, granularity);
  while (at.getTime() < to.getTime()) {
    out.push(at);
    const step = granularity === "hour" ? HOUR_MS : granularity === "day" ? DAY_MS : 7 * DAY_MS;
    at = new Date(at.getTime() + step);
  }
  return out;
}
