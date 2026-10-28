// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  acquireSlots,
  connectionPlan,
  createConnection,
  createRunQueue,
  createSystemQueue,
  enqueueResume,
  queuePrefix,
  removeLegacySchedulers,
  runSlotScopes,
  slotRetryDelayMs,
  syncSchedulers,
  workflowSchedulerPrefix,
} from "./index";

const url = process.env.VALKEY_URL;

describe("queue", { skip: !url }, () => {
  const connection = createConnection(url ?? "redis://unused", { blocking: true });
  const queue = createRunQueue(connection);
  const schedule = (triggerId: string, workflowId: string, expression = "* * * * *") => ({
    triggerId,
    workflowId,
    organizationId: "o1",
    nodeId: "t",
    timezone: "UTC",
    expression,
  });

  after(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    connection.disconnect();
  });

  it("syncs schedulers: add, change, remove", async () => {
    await syncSchedulers(queue, [schedule("t1", "w1"), schedule("t2", "w2")]);
    const keys = async () => (await queue.getJobSchedulers(0, -1)).map((s) => s.key).sort();
    assert.deepEqual(await keys(), ["cron:w1:t1", "cron:w2:t2"]);

    // Sync one workflow: only that workflow changes.
    await syncSchedulers(queue, [], workflowSchedulerPrefix("w1"));
    assert.deepEqual(await keys(), ["cron:w2:t2"]);

    await syncSchedulers(
      queue,
      [schedule("t2", "w2", "*/5 * * * *")],
      workflowSchedulerPrefix("w2"),
    );
    const [only] = await queue.getJobSchedulers(0, -1);
    assert.equal(only?.pattern, "*/5 * * * *");

    // Full sync with nothing wanted removes all.
    await syncSchedulers(queue, []);
    assert.deepEqual(await keys(), []);
  });

  it("removes legacy schedulers from the run queue only", async () => {
    const systemConnection = createConnection(url ?? "redis://unused", { blocking: true });
    const system = createSystemQueue(systemConnection);
    await syncSchedulers(queue, [schedule("t9", "w9")]);
    await syncSchedulers(system, [schedule("t9", "w9")]);
    const removed = await removeLegacySchedulers(queue);
    assert.deepEqual(removed, ["cron:w9:t9"]);
    assert.equal((await queue.getJobSchedulers(0, -1)).length, 0);
    assert.equal((await system.getJobSchedulers(0, -1)).length, 1);
    await system.obliterate({ force: true });
    await system.close();
    systemConnection.disconnect();
  });

  it("queues a resume as a delayed job with a new id each time", async () => {
    await enqueueResume(queue, { runId: "r1", organizationId: "o1", delayMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await enqueueResume(queue, { runId: "r1", organizationId: "o1", delayMs: 60_000 });
    const delayed = await queue.getDelayed();
    assert.equal(delayed.length, 2);
    assert.notEqual(delayed[0]?.id, delayed[1]?.id);
  });
});

describe("connectionPlan", () => {
  it("uses the url by default", () => {
    assert.deepEqual(connectionPlan("redis://v:6379", {}), { mode: "url", url: "redis://v:6379" });
    assert.equal(queuePrefix({}), undefined);
  });

  it("reads sentinels", () => {
    const plan = connectionPlan("redis://x", {
      VALKEY_SENTINELS: "a:26379, b:26380",
      VALKEY_SENTINEL_NAME: "zerodot",
      VALKEY_PASSWORD: "pw",
    });
    assert.deepEqual(plan, {
      mode: "sentinel",
      sentinels: [
        { host: "a", port: 26379 },
        { host: "b", port: 26380 },
      ],
      name: "zerodot",
      password: "pw",
    });
  });

  it("reads cluster mode and sets the hash tag", () => {
    assert.equal(connectionPlan("redis://n:7000", { VALKEY_CLUSTER: "true" }).mode, "cluster");
    assert.equal(queuePrefix({ VALKEY_CLUSTER: "true" }), "{zerodot}");
  });

  it("rejects a bad sentinel entry", () => {
    assert.throws(() => connectionPlan("redis://x", { VALKEY_SENTINELS: "a:nope" }));
  });
});

describe("slots", { skip: !url }, () => {
  const redis = createConnection(url ?? "redis://unused");
  const key = `zerodot:slots:test:${Date.now()}`;

  after(async () => {
    await redis.del(key);
    redis.disconnect();
  });

  it("caps holders and frees a slot on release", async () => {
    const scopes = [{ key, limit: 2 }];
    const a = await acquireSlots(redis, scopes, "a");
    const b = await acquireSlots(redis, scopes, "b");
    assert.ok(a && b);
    assert.equal(await acquireSlots(redis, scopes, "c"), null);
    await a.release();
    await a.release();
    const c = await acquireSlots(redis, scopes, "c");
    assert.ok(c);
    await b.release();
    await c.release();
  });

  it("frees slots that expire", async () => {
    const scopes = [{ key, limit: 1 }];
    const first = await acquireSlots(redis, scopes, "x", { ttlMs: 200 });
    assert.ok(first);
    assert.equal(await acquireSlots(redis, scopes, "y"), null);
    await first.release();
    // A crashed worker never releases: simulate with a short TTL and no release.
    const crashed = await acquireSlots(redis, scopes, "z", { ttlMs: 1_000_000 });
    assert.ok(crashed);
    await crashed.release();
    const lost = await redis.eval('redis.call("ZADD", KEYS[1], 1, "ghost") return 1', 1, key);
    assert.equal(lost, 1);
    const next = await acquireSlots(redis, scopes, "n");
    assert.ok(next, "an expired holder must not block");
    await next.release();
  });

  it("gives back the first slot when the second scope is full", async () => {
    const other = `${key}:wf`;
    const full = await acquireSlots(redis, [{ key: other, limit: 1 }], "w1");
    assert.ok(full);
    const denied = await acquireSlots(
      redis,
      [
        { key, limit: 5 },
        { key: other, limit: 1 },
      ],
      "w2",
    );
    assert.equal(denied, null);
    assert.equal(await redis.zcard(key), 0);
    await full.release();
    await redis.del(other);
  });

  it("skips scopes with no cap", async () => {
    const lease = await acquireSlots(redis, [{ key, limit: 0 }], "u");
    assert.ok(lease);
    assert.equal(await redis.zcard(key), 0);
    await lease.release();
  });
});

describe("slot helpers", () => {
  it("jitters the retry delay", () => {
    assert.equal(
      slotRetryDelayMs(() => 0),
      1000,
    );
    assert.ok(slotRetryDelayMs(() => 0.999) < 3000);
  });
  it("adds a workflow scope only with a workflow id", () => {
    assert.equal(runSlotScopes({ organizationId: "o", orgMax: 1, workflowMax: 1 }).length, 1);
    assert.equal(
      runSlotScopes({ organizationId: "o", workflowId: "w", orgMax: 1, workflowMax: 1 }).length,
      2,
    );
  });
});
