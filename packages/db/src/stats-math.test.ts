// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errorFingerprint, normalizeMessage } from "./stats-fingerprint";
import {
  addHistograms,
  bucketStartOf,
  bucketStarts,
  emptyHistogram,
  granularityFor,
  HISTOGRAM_BUCKETS,
  histogramIndex,
  histogramOf,
  percentileFromHistogram,
} from "./stats-math";

describe("histogram", () => {
  it("puts durations in log-scale buckets", () => {
    assert.equal(histogramIndex(0), 0);
    assert.equal(histogramIndex(1), 0);
    assert.equal(histogramIndex(2), 1);
    assert.equal(histogramIndex(3), 2);
    assert.equal(histogramIndex(1000), 10);
    assert.equal(histogramIndex(10 ** 12), HISTOGRAM_BUCKETS - 1);
  });

  it("adds histograms", () => {
    const sum = addHistograms(histogramOf(5), histogramOf(5));
    assert.equal(sum[histogramIndex(5)], 2);
    assert.equal(
      sum.reduce((a, b) => a + b, 0),
      2,
    );
  });

  it("has no percentile when empty", () => {
    assert.equal(percentileFromHistogram(emptyHistogram(), 0.95), null);
  });

  it("estimates p95 inside the right bucket", () => {
    let histogram = emptyHistogram();
    for (let i = 0; i < 95; i++) histogram = addHistograms(histogram, histogramOf(100));
    for (let i = 0; i < 5; i++) histogram = addHistograms(histogram, histogramOf(5000));
    const p95 = percentileFromHistogram(histogram, 0.95);
    // 100 ms is in the bucket (64, 128]. The 95th run is the last one in it.
    assert.ok(p95 !== null && p95 > 64 && p95 <= 128, String(p95));
    const p99 = percentileFromHistogram(histogram, 0.99);
    assert.ok(p99 !== null && p99 > 4096 && p99 <= 8192, String(p99));
  });
});

describe("buckets", () => {
  it("chooses a granularity from the range", () => {
    const day = 24 * 3_600_000;
    assert.equal(granularityFor(day), "hour");
    assert.equal(granularityFor(2 * day), "hour");
    assert.equal(granularityFor(7 * day), "day");
    assert.equal(granularityFor(90 * day), "day");
    assert.equal(granularityFor(91 * day), "week");
  });

  it("starts a week on Monday, in UTC", () => {
    // 2026-10-24 is a Saturday.
    assert.equal(
      bucketStartOf(new Date("2026-10-24T13:45:00Z"), "week").toISOString(),
      "2026-10-19T00:00:00.000Z",
    );
    assert.equal(
      bucketStartOf(new Date("2026-10-24T13:45:00Z"), "day").toISOString(),
      "2026-10-24T00:00:00.000Z",
    );
  });

  it("lists every bucket in a range", () => {
    const from = new Date("2026-10-22T10:00:00Z");
    const to = new Date("2026-10-25T10:00:00Z");
    const days = bucketStarts(from, to, "day").map((d) => d.toISOString());
    assert.deepEqual(days, [
      "2026-10-22T00:00:00.000Z",
      "2026-10-23T00:00:00.000Z",
      "2026-10-24T00:00:00.000Z",
      "2026-10-25T00:00:00.000Z",
    ]);
    assert.equal(bucketStarts(from, to, "hour").length, 72);
  });
});

describe("error fingerprint", () => {
  it("removes urls, ids, and numbers", () => {
    assert.equal(
      normalizeMessage("GET https://api.example.com/users/42?x=1 failed with status 503"),
      "GET <url> failed with status <n>",
    );
    assert.equal(
      normalizeMessage("Row 3f2b8c1e-aaaa-4bbb-8ccc-1234567890ab not found"),
      "Row <id> not found",
    );
    assert.equal(normalizeMessage("Timeout after 5000 ms"), "Timeout after <n> ms");
  });

  it("groups messages that differ only in the variable parts", () => {
    assert.equal(
      errorFingerprint("User 12 not found at https://a.test/u/12"),
      errorFingerprint("User 99 not found at https://b.test/u/99"),
    );
    assert.notEqual(errorFingerprint("User not found"), errorFingerprint("Timeout"));
  });
});
