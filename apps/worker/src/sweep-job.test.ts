// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleSweepJob } from "./sweep-job";

const run = (id: string) => ({ id, organizationId: "o", mode: "production" as const });

describe("handleSweepJob", () => {
  it("queues again only the runs without a job", async () => {
    const queued: string[] = [];
    const count = await handleSweepJob({
      listStuck: async () => [run("a"), run("b"), run("c")],
      findLive: async () => new Set(["b"]),
      requeue: async (r) => {
        queued.push(r.id);
      },
    });
    assert.equal(count, 2);
    assert.deepEqual(queued, ["a", "c"]);
  });

  it("does not look in the queue when no run is stuck", async () => {
    let looked = false;
    const count = await handleSweepJob({
      listStuck: async () => [],
      findLive: async () => {
        looked = true;
        return new Set();
      },
      requeue: async () => {},
    });
    assert.equal(count, 0);
    assert.equal(looked, false);
  });
});
