// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAge, isStaleWorker } from "./admin-format";

describe("formatAge", () => {
  it("formats seconds, minutes, hours and days", () => {
    assert.equal(formatAge(4_500), "4s");
    assert.equal(formatAge(180_000), "3m");
    assert.equal(formatAge(2 * 3_600_000), "2h");
    assert.equal(formatAge(2 * 3_600_000 + 5 * 60_000), "2h 5m");
    assert.equal(formatAge(3 * 86_400_000 + 1000), "3d");
  });

  it("treats negative values as zero", () => {
    assert.equal(formatAge(-5000), "0s");
  });
});

describe("isStaleWorker", () => {
  it("is stale after 20 seconds", () => {
    assert.equal(isStaleWorker(1000, 21_000), false);
    assert.equal(isStaleWorker(1000, 21_001), true);
  });
});
