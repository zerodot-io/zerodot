// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDb, findRunOrganization, forOrganization, schema } from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;

describe("answer of a waiting node", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
    await seedOrganization(handle, "o2");
  });
  after(() => handle.close());

  async function waitingRun(resumeAt: number) {
    const workflow = await forOrganization(db, "o1").workflows.create({ name: "W" });
    const [row] = await db
      .insert(schema.run)
      .values({
        organizationId: "o1",
        workflowId: workflow.id,
        mode: "production",
        status: "waiting",
        triggerType: "manual",
      })
      .returning();
    if (!row) throw new Error("no run");
    await db.insert(schema.runNodeResult).values({
      runId: row.id,
      nodeId: "n1",
      attempt: 1,
      status: "waiting",
      port: "out",
      output: { resumeAt, data: { data: { timedOut: true } } },
    });
    return row.id;
  }

  it("ends the wait with the answer, once", async () => {
    const runId = await waitingRun(Date.now() + 60_000);
    const scope = forOrganization(db, "o1");
    assert.equal(await scope.runs.answerWait(runId, "n1", { data: { approved: true } }), true);
    const [result] = await scope.runs.results(runId);
    const output = result?.output as { resumeAt: number; data: unknown };
    assert.ok(output.resumeAt <= Date.now());
    assert.deepEqual(output.data, { data: { approved: true } });
    assert.equal(await scope.runs.answerWait(runId, "n1", { data: { approved: false } }), false);
  });

  it("does not answer a wait that is over", async () => {
    const runId = await waitingRun(Date.now() - 1);
    assert.equal(await forOrganization(db, "o1").runs.answerWait(runId, "n1", {}), false);
  });

  it("does not answer a run of another project", async () => {
    const runId = await waitingRun(Date.now() + 60_000);
    assert.equal(await forOrganization(db, "o2").runs.answerWait(runId, "n1", {}), false);
    assert.equal(await forOrganization(db, "o2").runs.waitingNode(runId, "n1"), null);
    assert.equal(await findRunOrganization(db, runId), "o1");
  });
});
