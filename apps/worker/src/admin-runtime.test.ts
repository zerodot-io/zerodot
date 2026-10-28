// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capCounterFor, createActiveRuns, workerInfo } from "./admin-runtime";

describe("createActiveRuns", () => {
  it("aborts only the run that gets the cancel", () => {
    const active = createActiveRuns();
    const a = active.track("a");
    const b = active.track("b");
    assert.deepEqual(active.ids().sort(), ["a", "b"]);
    assert.equal(active.cancel("a"), true);
    assert.equal(a.signal.aborted, true);
    assert.equal(b.signal.aborted, false);
  });

  it("ignores a cancel for a run this worker does not have", () => {
    const active = createActiveRuns();
    assert.equal(active.cancel("none"), false);
  });

  it("forgets a run when its job ends, and keeps a newer job of the same run", () => {
    const active = createActiveRuns();
    const first = active.track("a");
    const second = active.track("a");
    first.done();
    assert.deepEqual(active.ids(), ["a"]);
    second.done();
    assert.deepEqual(active.ids(), []);
    assert.equal(active.cancel("a"), false);
  });
});

describe("capCounterFor", () => {
  it("maps slot keys to counters", () => {
    assert.equal(capCounterFor("zerodot:slots:org:o1"), "org_cap_delayed");
    assert.equal(capCounterFor("zerodot:slots:workflow:w1"), "workflow_cap_delayed");
  });
});

describe("workerInfo", () => {
  it("builds the heartbeat payload", () => {
    const info = workerInfo({
      id: "w",
      version: "1",
      concurrency: 5,
      startedAt: 10,
      activeRuns: ["r"],
      now: 20,
      host: "h",
    });
    assert.deepEqual(info, {
      id: "w",
      host: "h",
      version: "1",
      concurrency: 5,
      activeRuns: ["r"],
      startedAt: 10,
      lastSeenAt: 20,
    });
  });
});
