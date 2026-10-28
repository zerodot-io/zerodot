// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { blobIds, isBlobRef, memoryBlobStore } from "@zerodot/engine";
import { createDb, deleteBlobsForRuns, deleteOrphanBlobs, forOrganization, sql } from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;

const file = (text: string) => ({
  data: Buffer.from(text).toString("base64"),
  mimeType: "text/plain",
  fileName: "a.txt",
});

describe("run blobs", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  const store = memoryBlobStore();
  const blobs = { store, inlineBytes: 200 };

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
  });
  after(() => handle.close());

  const newRun = async (scope: ReturnType<typeof forOrganization>) => {
    const wf = await scope.workflows.create({ name: "w" });
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "production",
      triggerType: "manual",
      triggerInput: {},
      idempotencyKey: crypto.randomUUID(),
    });
    return run;
  };

  it("without a setup, data stays in the row", async () => {
    const scope = forOrganization(db, "o1", { blobs: null });
    const run = await newRun(scope);
    const output = { binary: { doc: file("hi") }, pad: "x".repeat(1000) };
    await scope.runs.saveNodeResult(run.id, {
      nodeId: "a",
      attempt: 1,
      status: "succeeded",
      output,
    });
    const [row] = await scope.runs.results(run.id);
    assert.deepEqual(row?.output, output);
    assert.equal(row?.outputRef, null);
  });

  it("stores files as blobs, reads them back, and keeps references for lazy reads", async () => {
    const scope = forOrganization(db, "o1", { blobs });
    const run = await newRun(scope);
    const output = { binary: { doc: file("hello") }, n: 1 };
    await scope.runs.saveNodeResult(run.id, {
      nodeId: "a",
      attempt: 1,
      status: "succeeded",
      output,
    });

    const raw = await forOrganization(db, "o1", { blobs: null }).runs.results(run.id);
    const stored = raw[0]?.output as { binary: { doc: unknown }; n: number };
    assert.ok(isBlobRef(stored.binary.doc));
    assert.equal(JSON.stringify(stored).includes(file("hello").data), false);
    assert.equal(raw[0]?.outputRef, null);

    const [full] = await scope.runs.results(run.id);
    assert.deepEqual(full?.output, output);
    const [lazy] = await scope.runs.results(run.id, { lazy: true });
    assert.ok(isBlobRef((lazy?.output as typeof stored | undefined)?.binary.doc));
  });

  it("stores a large output as one blob and keeps output_ref", async () => {
    const scope = forOrganization(db, "o1", { blobs });
    const run = await newRun(scope);
    const output = { rows: Array.from({ length: 100 }, (_, i) => ({ i })) };
    await scope.runs.saveNodeResult(run.id, {
      nodeId: "a",
      attempt: 1,
      status: "succeeded",
      input: { small: true },
      output,
    });
    const raw = (await forOrganization(db, "o1", { blobs: null }).runs.results(run.id))[0];
    assert.equal(raw?.output, null);
    assert.ok(isBlobRef(raw?.outputRef));
    assert.deepEqual(raw?.input, { small: true });
    assert.equal(raw?.inputRef, null);

    assert.deepEqual((await scope.runs.results(run.id))[0]?.output, output);
    const lazy = (await scope.runs.results(run.id, { lazy: true }))[0];
    assert.ok(isBlobRef(lazy?.output));
  });

  it("keeps the output of a waiting node in the row", async () => {
    const scope = forOrganization(db, "o1", { blobs });
    const run = await newRun(scope);
    const output = { resumeAt: Date.now() + 60_000, data: { pad: "x".repeat(1000) } };
    await scope.runs.saveNodeResult(run.id, {
      nodeId: "w",
      attempt: 1,
      status: "waiting",
      port: "out",
      output,
    });
    const raw = (await forOrganization(db, "o1", { blobs: null }).runs.results(run.id))[0];
    assert.deepEqual(raw?.output, output);
    assert.equal(raw?.outputRef, null);
    await scope.runs.start(run.id);
    await scope.runs.setWaiting(run.id);
    assert.equal(await scope.runs.answerWait(run.id, "w", { ok: true }), true);
  });

  it("copies the blobs to a retry run, so deleting the old run keeps them", async () => {
    const scope = forOrganization(db, "o1", { blobs });
    const run = await newRun(scope);
    const output = { binary: { doc: file("keep me") } };
    await scope.runs.saveNodeResult(run.id, {
      nodeId: "a",
      attempt: 1,
      status: "succeeded",
      port: "out",
      output,
    });
    await scope.runs.saveNodeResult(run.id, { nodeId: "b", attempt: 1, status: "failed" });
    await scope.runs.finish(run.id, { status: "failed" });

    const retry = await scope.runs.createRetry(run.id);
    assert.ok(retry);
    const raw = (await forOrganization(db, "o1", { blobs: null }).runs.results(retry.id))[0];
    const ids = blobIds(raw?.output);
    assert.equal(ids.length, 1);
    assert.equal(ids[0]?.startsWith(`${retry.id}/`), true);

    await deleteBlobsForRuns([run.id], store);
    assert.deepEqual((await scope.runs.results(retry.id))[0]?.output, output);
  });

  it("deleteBlobsForRuns, clearData and deleteOrphanBlobs remove blobs", async () => {
    const scope = forOrganization(db, "o1", { blobs });
    const a = await newRun(scope);
    const b = await newRun(scope);
    const c = await newRun(scope);
    for (const run of [a, b, c]) {
      await scope.runs.saveNodeResult(run.id, {
        nodeId: "n",
        attempt: 1,
        status: "succeeded",
        output: { binary: { doc: file(run.id) } },
      });
    }
    assert.ok((await store.listRunIds()).includes(a.id));

    await scope.runs.clearData(a.id);
    assert.equal((await store.listRunIds()).includes(a.id), false);

    await deleteBlobsForRuns([b.id], store);
    assert.equal((await store.listRunIds()).includes(b.id), false);

    // A purge removes the run rows and not the blobs. The orphan sweep finds those blobs.
    await db.execute(sql`delete from run where id = ${c.id}`);
    assert.equal((await store.listRunIds()).includes(c.id), true);
    const removed = await deleteOrphanBlobs(db, store);
    assert.ok(removed >= 1);
    assert.equal((await store.listRunIds()).includes(c.id), false);
  });

  it("does nothing without a store", async () => {
    await deleteBlobsForRuns(["x"], undefined);
    assert.equal(await deleteOrphanBlobs(db, undefined), 0);
  });
});
