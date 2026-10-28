// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import {
  createDb,
  forOrganization,
  percentileFromHistogram,
  purgeStats,
  rebuildStats,
  schema,
} from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;
const HOUR = 3_600_000;

describe("stats rollups", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  // Fixed hour so the tests do not depend on the clock.
  const base = new Date("2026-10-20T10:00:00Z");
  const at = (hours: number, minutes = 0) =>
    new Date(base.getTime() + hours * HOUR + minutes * 60_000);
  const window = (fromHours: number, toHours: number) => ({ from: at(fromHours), to: at(toHours) });

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
    await seedOrganization(handle, "o2");
  });
  after(() => handle.close());

  it("adds counters and histograms in one row for one hour", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Sync" });
    for (const [status, ms] of [
      ["succeeded", 100],
      ["succeeded", 300],
      ["failed", 50],
    ] as const) {
      await scope.stats.recordRunEnd({
        runId: crypto.randomUUID(),
        workflowId: wf.id,
        mode: "production",
        triggerType: "webhook",
        status,
        startedAt: at(0, 5),
        finishedAt: new Date(at(0, 5).getTime() + ms),
        error: status === "failed" ? { message: "Boom 1" } : null,
      });
    }
    const rows = await db.select().from(schema.runStats);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.succeeded, 2);
    assert.equal(rows[0]?.failed, 1);
    assert.equal(rows[0]?.durationSumMs, 450);
    assert.equal(
      rows[0]?.durationBuckets.reduce((a, b) => a + b, 0),
      3,
    );

    const summary = await scope.stats.summary(window(0, 1));
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.durationSumMs, 450);
    assert.equal(summary.hasTimeSaved, false);
    const p95 = percentileFromHistogram(summary.durationBuckets, 0.95);
    assert.ok(p95 !== null && p95 > 0 && p95 <= 512);
  });

  it("separates test runs unless asked", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Tests" });
    await scope.stats.recordRunEnd({
      runId: crypto.randomUUID(),
      workflowId: wf.id,
      mode: "test",
      triggerType: "manual",
      status: "failed",
      startedAt: at(2),
      finishedAt: at(2, 1),
      error: { message: "x" },
    });
    const filter = { ...window(2, 3), workflowIds: [wf.id] };
    assert.equal((await scope.stats.summary(filter)).failed, 0);
    assert.equal((await scope.stats.summary({ ...filter, includeTest: true })).failed, 1);
    assert.equal((await scope.stats.errors(filter)).length, 0);
    assert.equal((await scope.stats.errors({ ...filter, includeTest: true })).length, 1);
  });

  it("fills empty buckets in a time series", async () => {
    const scope = forOrganization(db, "o1");
    const points = await scope.stats.timeseries(window(0, 4), "hour");
    assert.equal(points.length, 4);
    assert.equal(points[0]?.succeeded, 2);
    assert.equal(points[1]?.succeeded, 0);
    assert.deepEqual(
      points.map((p) => p.bucket.toISOString()),
      [0, 1, 2, 3].map((h) => at(h).toISOString()),
    );
    const days = await scope.stats.timeseries({ from: at(-10), to: at(4) }, "day");
    assert.equal(
      days.reduce((n, p) => n + p.succeeded, 0),
      2,
    );
  });

  it("counts time saved from the workflow setting", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Saver" });
    await scope.workflows.setMinutesSaved(wf.id, 15);
    for (let i = 0; i < 3; i++) {
      await scope.stats.recordRunEnd({
        runId: crypto.randomUUID(),
        workflowId: wf.id,
        mode: "production",
        triggerType: "cron",
        status: i === 2 ? "failed" : "succeeded",
        startedAt: at(5),
        finishedAt: at(5, 1),
        error: i === 2 ? { message: "no" } : null,
      });
    }
    const summary = await scope.stats.summary({ ...window(5, 6), workflowIds: [wf.id] });
    assert.equal(summary.timeSavedMinutes, 30);
    assert.equal(summary.hasTimeSaved, true);
    const byTrigger = await scope.stats.summary({ ...window(5, 6), triggerType: "webhook" });
    assert.equal(byTrigger.succeeded, 0);
  });

  it("lists workflows with last run, last failure, and trend", async () => {
    const scope = forOrganization(db, "o1");
    const rows = await scope.stats.workflows(window(0, 6), "hour");
    const sync = rows.find((r) => r.workflowName === "Sync");
    assert.ok(sync);
    assert.equal(sync.succeeded + sync.failed, 3);
    assert.equal(sync.trend.length, 6);
    assert.equal(sync.trend[0], 3);
    assert.ok(sync.lastRunAt && sync.lastRunAt >= at(0, 5));
    assert.ok(sync.lastFailureAt);
    const saver = rows.find((r) => r.workflowName === "Saver");
    assert.equal(saver?.lastFailureAt?.getTime(), at(5, 1).getTime());
  });

  it("groups errors by normalized message and links the latest run", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Errors" });
    const ids: string[] = [];
    for (const [n, hours] of [
      [11, 7],
      [22, 8],
    ] as const) {
      const runId = crypto.randomUUID();
      ids.push(runId);
      await scope.stats.recordRunEnd({
        runId,
        workflowId: wf.id,
        mode: "production",
        triggerType: "webhook",
        status: "failed",
        startedAt: at(hours),
        finishedAt: at(hours, 1),
        error: { message: `HTTP ${n} from https://x.test/${n}` },
      });
    }
    const groups = await scope.stats.errors({ ...window(7, 9), workflowIds: [wf.id] });
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.count, 2);
    assert.equal(groups[0]?.lastRunId, ids[1]);
    assert.equal(groups[0]?.sampleMessage, "HTTP 22 from https://x.test/22");
    assert.equal(groups[0]?.firstSeenAt.getTime(), at(7, 1).getTime());
    assert.equal(groups[0]?.lastSeenAt.getTime(), at(8, 1).getTime());
    assert.equal(groups[0]?.workflowName, "Errors");
  });

  it("records node results", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Nodes" });
    for (const status of ["succeeded", "failed", "succeeded"] as const) {
      await scope.stats.recordNodeEnd({
        workflowId: wf.id,
        nodeType: "http.request",
        nodeId: "n1",
        mode: "production",
        status,
        durationMs: 200,
        finishedAt: at(9),
      });
    }
    const nodes = await scope.stats.nodes({ ...window(9, 10), workflowIds: [wf.id] });
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.succeeded, 2);
    assert.equal(nodes[0]?.failed, 1);
    assert.equal(nodes[0]?.durationSumMs, 600);
  });

  it("keeps organizations apart", async () => {
    const other = forOrganization(db, "o2");
    const summary = await other.stats.summary(window(-100, 100));
    assert.equal(summary.succeeded + summary.failed, 0);
    assert.deepEqual(await other.stats.workflows(window(-100, 100), "day"), []);
    assert.deepEqual(await other.stats.errors(window(-100, 100)), []);
  });

  it("lists publishes of a workflow", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Versions" });
    const graph = { schema: 1, nodes: [], edges: [] };
    await scope.workflows.publish(wf.id, { graph, triggerNodes: [], userId: null });
    const marks = await scope.stats.publishes(wf.id, {
      from: at(-24 * 365),
      to: new Date(Date.now() + HOUR),
    });
    assert.deepEqual(
      marks.map((m) => m.version),
      [1],
    );
    assert.deepEqual(
      await forOrganization(db, "o2").stats.publishes(wf.id, { from: new Date(0), to: new Date() }),
      [],
    );
  });

  it("rebuilds the same rollups from run history", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Rebuild" });
    const graph = {
      schema: 1,
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "a", type: "http.request", name: "Fetch", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [{ id: "e1", from: "t", fromPort: "out", to: "a", toPort: "in" }],
    };
    const version = await scope.workflows.publish(wf.id, { graph, triggerNodes: [], userId: null });
    assert.ok(version);
    const finishedAt = at(12, 30);
    for (const status of ["succeeded", "failed"] as const) {
      const { run } = await scope.runs.create({
        workflowId: wf.id,
        mode: "production",
        versionId: version.id,
        triggerType: "manual",
        triggerInput: {},
      });
      await db
        .update(schema.run)
        .set({
          status,
          startedAt: at(12, 29),
          finishedAt,
          error: status === "failed" ? { message: "Bad 5" } : null,
        })
        .where(sql`${schema.run.id} = ${run.id}`);
      await scope.runs.saveNodeResult(run.id, {
        nodeId: "a",
        attempt: 1,
        status,
        startedAt: at(12, 29),
        finishedAt,
      });
    }
    const filter = { ...window(12, 13), workflowIds: [wf.id] };
    const result = await rebuildStats(db, { organizationId: "o1" });
    assert.ok(result.runs >= 2);
    const summary = await scope.stats.summary(filter);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.durationSumMs, 2 * 60_000);
    const nodes = await scope.stats.nodes(filter);
    assert.equal(nodes[0]?.nodeType, "http.request");
    assert.equal(nodes[0]?.succeeded, 1);
    assert.equal(nodes[0]?.failed, 1);
    const errors = await scope.stats.errors(filter);
    assert.equal(errors[0]?.count, 1);
    assert.equal(errors[0]?.sampleMessage, "Bad 5");
  });

  it("purges old rows only", async () => {
    const scope = forOrganization(db, "o1");
    const wf = await scope.workflows.create({ name: "Purge" });
    for (const hours of [-2000, 20]) {
      await scope.stats.recordRunEnd({
        runId: crypto.randomUUID(),
        workflowId: wf.id,
        mode: "production",
        triggerType: "manual",
        status: "failed",
        startedAt: at(hours),
        finishedAt: at(hours, 1),
        error: { message: "old" },
      });
    }
    const removed = await purgeStats(db, at(-1000));
    // One run row and one error row.
    assert.equal(removed, 2);
    const left = await scope.stats.summary({ from: at(-3000), to: at(100), workflowIds: [wf.id] });
    assert.equal(left.failed, 1);
  });
});
