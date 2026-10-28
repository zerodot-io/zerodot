// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listenRunKey, planListeners, shuffled } from "./listen-manager";

const wanted = (...pairs: [string, string][]) =>
  pairs.map(([triggerId, versionId]) => ({ triggerId, versionId }));

describe("planListeners", () => {
  it("starts a trigger that is not running", () => {
    const plan = planListeners(new Map(), wanted(["a", "v1"]));
    assert.deepEqual(plan, { stop: [], start: ["a"] });
  });

  it("keeps a trigger that did not change", () => {
    const plan = planListeners(new Map([["a", "v1"]]), wanted(["a", "v1"]));
    assert.deepEqual(plan, { stop: [], start: [] });
  });

  it("stops a trigger that is not active any more", () => {
    const plan = planListeners(new Map([["a", "v1"]]), []);
    assert.deepEqual(plan, { stop: ["a"], start: [] });
  });

  it("restarts a trigger with a new version", () => {
    const plan = planListeners(new Map([["a", "v1"]]), wanted(["a", "v2"]));
    assert.deepEqual(plan, { stop: ["a"], start: ["a"] });
  });
});

describe("listenRunKey", () => {
  it("is the same for one event", () => {
    assert.equal(listenRunKey("t", "k"), "listen:t:k");
  });

  it("shortens a long key", () => {
    assert.ok(listenRunKey("t", "k".repeat(500)).length < 100);
  });
});

describe("shuffled", () => {
  it("keeps all items and does not change the input", () => {
    const input = ["a", "b", "c", "d", "e"];
    const out = shuffled(input);
    assert.deepEqual([...out].sort(), input);
    assert.deepEqual(input, ["a", "b", "c", "d", "e"]);
  });

  it("uses the random source, so workers get different orders", () => {
    const input = ["a", "b", "c", "d"];
    const low = shuffled(input, () => 0);
    const high = shuffled(input, () => 0.99);
    assert.notDeepEqual(low, high);
    assert.deepEqual(
      shuffled(input, () => 0),
      low,
    );
  });

  it("spreads the first pick over many tries", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(shuffled(["a", "b", "c", "d"])[0] as string);
    assert.ok(seen.size > 1);
  });
});
