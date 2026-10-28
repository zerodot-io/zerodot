// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { createDb, forOrganization, listWorkflowCronSchedules, purgeRuns, schema } from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;
const DAY = 86_400_000;

describe("run retention", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  const now = new Date("2026-10-25T00:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
    await seedOrganization(handle, "o2");
  });
  after(() => handle.close());

  async function addRun(
    organizationId: string,
    workflowId: string,
    values: { mode: "production" | "test"; status: "succeeded" | "running"; age: number },
  ) {
    const [row] = await db
      .insert(schema.run)
      .values({
        organizationId,
        workflowId,
        mode: values.mode,
        status: values.status,
        triggerType: "manual",
        createdAt: daysAgo(values.age),
      })
      .returning();
    if (!row) throw new Error("no run");
    await db
      .insert(schema.runNodeResult)
      .values({ runId: row.id, nodeId: "n1", attempt: 1, status: "succeeded" });
    return row.id;
  }

  it("deletes old test runs and old finished production runs, with project settings", async () => {
    const one = forOrganization(db, "o1");
    const two = forOrganization(db, "o2");
    const w1 = (await one.workflows.create({ name: "A" })).id;
    const w2 = (await two.workflows.create({ name: "B" })).id;
    await two.settings.set({ runRetentionDays: 5 });

    const oldTest = await addRun("o1", w1, { mode: "test", status: "succeeded", age: 8 });
    const newTest = await addRun("o1", w1, { mode: "test", status: "succeeded", age: 6 });
    const oldProd = await addRun("o1", w1, { mode: "production", status: "succeeded", age: 31 });
    const newProd = await addRun("o1", w1, { mode: "production", status: "succeeded", age: 29 });
    const oldRunning = await addRun("o1", w1, { mode: "production", status: "running", age: 90 });
    const shortProd = await addRun("o2", w2, { mode: "production", status: "succeeded", age: 6 });
    const keptProd = await addRun("o2", w2, { mode: "production", status: "succeeded", age: 4 });

    const result = await purgeRuns(db, { testDays: 7, defaultDays: 30, now });
    assert.equal(result.testRuns, 1);
    assert.equal(result.productionRuns, 2);
    assert.equal(result.complete, true);

    const left = (await db.select({ id: schema.run.id }).from(schema.run)).map((r) => r.id).sort();
    assert.deepEqual(left, [newTest, newProd, oldRunning, keptProd].sort());
    assert.ok(![oldTest, oldProd, shortProd].some((id) => left.includes(id)));
    const results = await db.select().from(schema.runNodeResult);
    assert.equal(results.length, 4);
  });

  it("deletes in batches, with more rows than one batch, and stops at maxBatches", async () => {
    const scope = forOrganization(db, "o1");
    const wf = (await scope.workflows.create({ name: "Batches" })).id;
    await db.delete(schema.run);
    const make = (mode: "production" | "test", status: "succeeded" | "running", age: number) => ({
      organizationId: "o1",
      workflowId: wf,
      mode,
      status,
      triggerType: "manual",
      createdAt: daysAgo(age),
    });
    // 7 old test runs, 5 old production runs, 2 old unfinished runs, 2 new runs.
    await db
      .insert(schema.run)
      .values([
        ...Array.from({ length: 7 }, () => make("test", "succeeded", 10)),
        ...Array.from({ length: 5 }, () => make("production", "succeeded", 40)),
        ...Array.from({ length: 2 }, () => make("production", "running", 40)),
        make("test", "succeeded", 1),
        make("production", "succeeded", 1),
      ]);
    const options = { testDays: 7, defaultDays: 30, now, batchSize: 3, pauseMs: 0 };

    const first = await purgeRuns(db, { ...options, maxBatches: 2 });
    assert.deepEqual(first, { testRuns: 6, productionRuns: 0, batches: 2, complete: false });

    const rest = await purgeRuns(db, options);
    // 1 test run (batch of 1 ends the phase), then 3 + 2 production runs.
    assert.deepEqual(rest, { testRuns: 1, productionRuns: 5, batches: 3, complete: true });

    const left = await db.select({ status: schema.run.status }).from(schema.run);
    assert.equal(left.length, 4);
    assert.equal(left.filter((r) => r.status === "running").length, 2);
    assert.deepEqual(await purgeRuns(db, options), {
      testRuns: 0,
      productionRuns: 0,
      batches: 2,
      complete: true,
    });
  });

  it("reads and writes project settings", async () => {
    const scope = forOrganization(db, "o1");
    const base = { runRetentionDays: null, timezone: null };
    assert.deepEqual(await scope.settings.get(), base);
    assert.deepEqual(await scope.settings.set({ runRetentionDays: 14 }), {
      ...base,
      runRetentionDays: 14,
    });
    assert.deepEqual(
      await scope.settings.set({ runRetentionDays: null, timezone: "Asia/Kolkata" }),
      {
        ...base,
        timezone: "Asia/Kolkata",
      },
    );
    assert.deepEqual(await scope.settings.set({ timezone: null }), base);
  });

  it("resolves the cron time zone: node, then workflow, then project, then UTC", async () => {
    const scope = forOrganization(db, "o2");
    const wf = await scope.workflows.create({ name: "cron tz" });
    const config = (timezone?: string) => ({ nodeId: "n1", expression: "0 9 * * *", timezone });
    await db.insert(schema.trigger).values({
      organizationId: "o2",
      workflowId: wf.id,
      type: "cron",
      config: config(),
    });
    await db
      .update(schema.workflow)
      .set({ active: true, publishedVersionId: wf.id })
      .where(eq(schema.workflow.id, wf.id));
    const zone = async () =>
      (await listWorkflowCronSchedules(db, "o2", wf.id)).map((s) => s.timezone);
    assert.deepEqual(await zone(), ["UTC"]);
    await scope.settings.set({ timezone: "Europe/Paris" });
    assert.deepEqual(await zone(), ["Europe/Paris"]);
    await scope.workflows.setTimezone(wf.id, "Asia/Tokyo");
    assert.deepEqual(await zone(), ["Asia/Tokyo"]);
    await db
      .update(schema.trigger)
      .set({ config: config("America/New_York") })
      .where(eq(schema.trigger.workflowId, wf.id));
    assert.deepEqual(await zone(), ["America/New_York"]);
  });
});
