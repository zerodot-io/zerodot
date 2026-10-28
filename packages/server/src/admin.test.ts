// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createDb, forOrganization, listAudit, schema } from "@zerodot/db";
import { resetDatabase, seedOrganization } from "@zerodot/db/testing";
import {
  createConnection,
  createRunQueue,
  createSystemQueue,
  enqueueRun,
  RUN_CANCEL_CHANNEL,
  readStream,
  runStreamKey,
} from "@zerodot/queue";
import {
  adminConfig,
  createAdminOps,
  isInstanceAdmin,
  matchesAdminRule,
  oldestAgeMs,
  summarizeJob,
  truncateReason,
} from "./admin.server";

const alice = { id: "u-alice", email: "Alice@Example.com" };
const bob = { id: "u-bob", email: "bob@example.com" };

describe("instance admin rule", () => {
  it("reads the env", () => {
    assert.deepEqual(adminConfig({}), { enabled: true, emails: [] });
    assert.equal(adminConfig({ ZERODOT_ADMIN_UI: "false" }).enabled, false);
    assert.deepEqual(adminConfig({ ZERODOT_ADMIN_EMAILS: " A@x.com, ,b@x.com " }).emails, [
      "a@x.com",
      "b@x.com",
    ]);
  });

  it("uses the email list when it is set", () => {
    const config = adminConfig({ ZERODOT_ADMIN_EMAILS: "alice@example.com" });
    assert.equal(matchesAdminRule(alice, config, "u-bob"), true);
    assert.equal(matchesAdminRule(bob, config, "u-bob"), false);
  });

  it("uses the first user when the list is empty", () => {
    const config = adminConfig({});
    assert.equal(matchesAdminRule(alice, config, "u-alice"), true);
    assert.equal(matchesAdminRule(bob, config, "u-alice"), false);
    assert.equal(matchesAdminRule(bob, config, null), false);
  });

  it("denies everyone when the page is off", async () => {
    const config = adminConfig({
      ZERODOT_ADMIN_UI: "false",
      ZERODOT_ADMIN_EMAILS: "bob@example.com",
    });
    assert.equal(matchesAdminRule(bob, config, null), false);
    assert.equal(await isInstanceAdmin(bob, { config }), false);
  });

  it("isInstanceAdmin with a list needs no database", async () => {
    const config = adminConfig({ ZERODOT_ADMIN_EMAILS: "bob@example.com" });
    assert.equal(await isInstanceAdmin(bob, { config }), true);
    assert.equal(await isInstanceAdmin(alice, { config }), false);
  });
});

describe("job helpers", () => {
  it("cuts a long reason to 300 characters", () => {
    assert.equal(truncateReason(undefined), null);
    assert.equal(truncateReason("short"), "short");
    assert.equal(truncateReason("x".repeat(1000))?.length, 300);
  });

  it("keeps ids only", () => {
    const summary = summarizeJob({
      id: "j1",
      name: "run",
      data: { runId: "r1", organizationId: "o1", secret: "S", triggerInput: { a: 1 } },
      attemptsMade: 2,
      failedReason: "boom",
      timestamp: 5,
    });
    assert.equal(summary.runId, "r1");
    assert.equal(summary.organizationId, "o1");
    assert.equal(summary.workflowId, null);
    assert.equal(JSON.stringify(summary).includes("secret"), false);
    assert.equal(JSON.stringify(summary).includes("triggerInput"), false);
  });

  it("finds the age of the oldest job", () => {
    assert.equal(oldestAgeMs([], 100), null);
    assert.equal(oldestAgeMs([40, 90], 100), 60);
    assert.equal(oldestAgeMs([200], 100), 0);
  });
});

const dbUrl = process.env.DATABASE_URL;
const valkeyUrl = process.env.VALKEY_URL;

describe("admin operations", { skip: !dbUrl || !valkeyUrl }, () => {
  const handle = createDb(dbUrl ?? "postgres://unused");
  const redis = createConnection(valkeyUrl ?? "redis://unused");
  const runsConnection = createConnection(valkeyUrl ?? "redis://unused", { blocking: true });
  const systemConnection = createConnection(valkeyUrl ?? "redis://unused", { blocking: true });
  const runs = createRunQueue(runsConnection);
  const system = createSystemQueue(systemConnection);
  const ops = createAdminOps({ db: handle.db, redis, queues: { runs, system } });
  const actor = { id: "u1", email: "admin@example.com" };
  let workflowId = "";

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
    workflowId = (await forOrganization(handle.db, "o1").workflows.create({ name: "W" })).id;
  });
  beforeEach(async () => {
    await runs.resume();
    await system.resume();
    await runs.obliterate({ force: true });
    await system.obliterate({ force: true });
  });
  after(async () => {
    await runs.obliterate({ force: true });
    await runs.close();
    await system.close();
    runsConnection.disconnect();
    systemConnection.disconnect();
    redis.disconnect();
    await handle.close();
  });

  async function addRun(status: "queued" | "running" | "succeeded") {
    const [row] = await handle.db
      .insert(schema.run)
      .values({
        organizationId: "o1",
        workflowId,
        mode: "production",
        triggerType: "manual",
        status,
      })
      .returning();
    if (!row) throw new Error("no run");
    return row.id;
  }

  it("cancels a queued run, removes its job, tells workers, and is idempotent", async () => {
    const runId = await addRun("queued");
    await enqueueRun(runs, { runId, organizationId: "o1", mode: "production" });
    const subscriber = createConnection(valkeyUrl ?? "");
    const messages: string[] = [];
    await subscriber.subscribe(RUN_CANCEL_CHANNEL);
    subscriber.on("message", (_channel, message) => messages.push(message));

    const first = await ops.cancelRun(actor, runId);
    assert.equal(first.alreadyFinished, false);
    assert.equal(first.status, "cancelled");
    assert.equal(first.removedJobs, 1);
    assert.equal(await runs.getJob(runId), undefined);
    const row = await forOrganization(handle.db, "o1").runs.get(runId);
    assert.equal(row?.status, "cancelled");
    assert.ok(row?.finishedAt);
    const events = await readStream(redis, runStreamKey(runId), "0-0", 50);
    assert.ok(events.some((e) => e.event.type === "run.finished"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(messages, [runId]);
    subscriber.disconnect();

    const second = await ops.cancelRun(actor, runId);
    assert.equal(second.alreadyFinished, true);
    const audit = (await listAudit(handle.db, 50)).filter((a) => a.targetId === runId);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.action, "run.cancel");
    assert.equal(audit[0]?.actorEmail, "admin@example.com");
  });

  it("leaves a finished run alone and rejects unknown runs", async () => {
    const runId = await addRun("succeeded");
    const result = await ops.cancelRun(actor, runId);
    assert.equal(result.alreadyFinished, true);
    assert.equal(result.status, "succeeded");
    await assert.rejects(ops.cancelRun(actor, "00000000-0000-4000-8000-000000000000"), /not found/);
    await assert.rejects(ops.cancelRun(actor, "nope"), /not found/);
  });

  it("pauses, resumes and reports counts and the oldest waiting job", async () => {
    await ops.pauseQueue(actor, { queue: "runs" });
    await runs.add(
      "run",
      { runId: "r1", organizationId: "o1", appVersion: "dev" },
      { jobId: "r1" },
    );
    const paused = await ops.overview();
    const q = paused.queues.find((x) => x.name === "runs");
    assert.equal(q?.paused, true);
    assert.equal(q?.counts.waiting, 1);
    assert.ok((q?.oldestWaitingMs ?? -1) >= 0);
    assert.equal(paused.queues.find((x) => x.name === "system")?.paused, false);
    assert.equal(paused.queues.find((x) => x.name === "system")?.oldestWaitingMs, null);
    await ops.resumeQueue(actor, { queue: "runs" });
    assert.equal((await ops.overview()).queues[0]?.paused, false);
    const actions = (await ops.overview()).audit.map((a) => a.action);
    assert.ok(actions.includes("queue.pause") && actions.includes("queue.resume"));
  });

  it("lists, promotes and removes jobs without job data", async () => {
    await runs.add(
      "run",
      { runId: "r2", organizationId: "o1", appVersion: "dev" },
      { jobId: "d1", delay: 60_000 },
    );
    const delayed = await ops.listJobs({ queue: "runs", state: "delayed" });
    assert.equal(delayed.length, 1);
    assert.equal(delayed[0]?.runId, "r2");
    assert.equal(Object.keys(delayed[0] ?? {}).includes("data"), false);
    await assert.rejects(ops.retryJob(actor, { queue: "runs", jobId: "d1" }), /cannot be retried/);
    await ops.promoteDelayedJob(actor, { queue: "runs", jobId: "d1" });
    assert.equal((await ops.listJobs({ queue: "runs", state: "waiting" })).length, 1);
    await assert.rejects(ops.promoteDelayedJob(actor, { queue: "runs", jobId: "d1" }), /delayed/);
    await ops.removeJob(actor, { queue: "runs", jobId: "d1" });
    assert.equal(await runs.getJob("d1"), undefined);
    await assert.rejects(ops.removeJob(actor, { queue: "runs", jobId: "d1" }), /not found/);
  });

  it("cleans old jobs of one state and audits the count", async () => {
    for (const id of ["c1", "c2"]) {
      await runs.add(
        "run",
        { runId: id, organizationId: "o1", appVersion: "dev" },
        { jobId: id, delay: 60_000 },
      );
    }
    const result = await ops.cleanQueue(actor, { queue: "runs", state: "delayed", olderThanMs: 0 });
    assert.equal(result.removed, 2);
    assert.equal((await ops.listJobs({ queue: "runs", state: "delayed" })).length, 0);
    const entry = (await listAudit(handle.db, 50)).find((a) => a.action === "queue.clean");
    assert.equal(entry?.details?.removed, 2);
    assert.equal(entry?.targetId, "runs");
  });
});
