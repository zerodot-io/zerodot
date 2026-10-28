// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import {
  ConflictError,
  createDb,
  findWebhookTrigger,
  forOrganization,
  rotateSecretKey,
  runMigrations,
  schema,
} from "./index";

const url = process.env.DATABASE_URL;

function tokenOf(row: { config: unknown } | undefined): string {
  const token = (row?.config as { token?: string } | undefined)?.token;
  if (!token) throw new Error("trigger has no token");
  return token;
}

describe("forOrganization", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;

  before(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await db.execute(sql`create schema public`);
    await runMigrations(handle);
    const now = new Date();
    await db.insert(schema.organization).values([
      { id: "o1", name: "A", slug: "a", createdAt: now },
      { id: "o2", name: "B", slug: "b", createdAt: now },
    ]);
  });
  after(() => handle.close());

  it("rejects empty organizationId", () => {
    assert.throws(() => forOrganization(db, ""));
  });

  it("isolates organizations", async () => {
    const a = forOrganization(db, "o1");
    const b = forOrganization(db, "o2");
    const wf = await a.workflows.create({ name: "one" });
    assert.equal(await b.workflows.get(wf.id), null);
    assert.equal(await b.workflows.rename(wf.id, "x"), null);
    assert.equal(await b.workflows.remove(wf.id), false);
    assert.equal((await b.workflows.list()).items.length, 0);
    assert.equal((await a.workflows.get(wf.id))?.name, "one");
  });

  it("pages with cursor", async () => {
    const a = forOrganization(db, "o1");
    for (const n of ["p1", "p2", "p3"]) await a.workflows.create({ name: n });
    const first = await a.workflows.list({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await a.workflows.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    const ids = new Set([...first.items, ...second.items].map((r) => r.id));
    assert.equal(ids.size, first.items.length + second.items.length);
  });

  it("publishes versions, keeps webhook tokens, and syncs triggers", async () => {
    const a = forOrganization(db, "o1");
    const wf = await a.workflows.create({ name: "pub" });
    const trig = { id: "t1", type: "trigger.webhook", config: { responseMode: "immediate" } };
    const v1 = await a.workflows.publish(wf.id, {
      graph: { v: 1 },
      triggerNodes: [trig],
      userId: null,
    });
    const [first] = await a.workflows.triggers([wf.id]);
    const v2 = await a.workflows.publish(wf.id, {
      graph: { v: 2 },
      triggerNodes: [trig],
      userId: null,
    });
    const [second] = await a.workflows.triggers([wf.id]);
    assert.equal(v1?.version, 1);
    assert.equal(v2?.version, 2);
    assert.ok(tokenOf(first));
    assert.equal(tokenOf(second), tokenOf(first));
    const token = tokenOf(first);
    assert.equal((await findWebhookTrigger(db, token))?.nodeId, "t1");
    await a.workflows.publish(wf.id, { graph: { v: 3 }, triggerNodes: [], userId: null });
    assert.equal(await findWebhookTrigger(db, token), null);
    assert.equal(await forOrganization(db, "o2").workflows.getVersion(v1?.id ?? ""), null);
  });

  it("runs: idempotency, results, org guard", async () => {
    const a = forOrganization(db, "o1");
    const b = forOrganization(db, "o2");
    const wf = await a.workflows.create({ name: "r" });
    const input = {
      workflowId: wf.id,
      mode: "production" as const,
      triggerType: "webhook",
      triggerInput: { x: 1 },
      idempotencyKey: "k1",
    };
    const first = await a.runs.create(input);
    const again = await a.runs.create(input);
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.run.id, first.run.id);

    await a.runs.saveNodeResult(first.run.id, { nodeId: "n", attempt: 1, status: "running" });
    await a.runs.saveNodeResult(first.run.id, {
      nodeId: "n",
      attempt: 1,
      status: "succeeded",
      port: "out",
      output: { ok: true },
    });
    await b.runs.saveNodeResult(first.run.id, { nodeId: "evil", attempt: 1, status: "succeeded" });
    const results = await a.runs.results(first.run.id);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.status, "succeeded");
    assert.deepEqual(results[0]?.output, { ok: true });
    assert.deepEqual(await b.runs.results(first.run.id), []);
    assert.equal(await b.runs.get(first.run.id), null);

    assert.equal((await a.runs.start(first.run.id))?.status, "running");
    assert.equal((await a.runs.finish(first.run.id, { status: "succeeded" }))?.status, "succeeded");
    assert.equal(
      (await a.runs.list()).items.some((r) => r.id === first.run.id),
      true,
    );
    assert.equal((await b.runs.list()).items.length, 0);
  });

  it("runs: a retry copies the succeeded results only", async () => {
    const a = forOrganization(db, "o1");
    const b = forOrganization(db, "o2");
    const wf = await a.workflows.create({ name: "retry" });
    const { run: failed } = await a.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: { schema: 1, nodes: [], edges: [] },
      triggerType: "manual",
      triggerNodeId: "t",
      triggerInput: { x: 1 },
    });
    const done = { status: "succeeded" as const, port: "out", output: { ok: 1 } };
    await a.runs.saveNodeResult(failed.id, { nodeId: "t", attempt: 1, ...done });
    await a.runs.saveNodeResult(failed.id, { nodeId: "n", attempt: 1, ...done });
    await a.runs.saveNodeResult(failed.id, {
      nodeId: "x",
      attempt: 1,
      status: "failed",
      error: { message: "boom" },
    });
    await a.runs.saveNodeResult(failed.id, { nodeId: "s", attempt: 1, status: "skipped" });
    await a.runs.finish(failed.id, { status: "failed", error: { message: "boom", nodeId: "x" } });

    assert.equal(await b.runs.createRetry(failed.id), null, "another project cannot retry it");
    const retry = await a.runs.createRetry(failed.id);
    assert.ok(retry);
    assert.notEqual(retry.id, failed.id);
    assert.equal(retry.status, "queued");
    assert.equal(retry.mode, "test");
    assert.equal(retry.triggerNodeId, "t");
    assert.deepEqual(retry.triggerInput, { x: 1 });
    assert.deepEqual(retry.graphSnapshot, { schema: 1, nodes: [], edges: [] });
    assert.match(retry.idempotencyKey ?? "", new RegExp(`^retry:${failed.id}:`));
    const copied = await a.runs.results(retry.id);
    assert.deepEqual(copied.map((r) => r.nodeId).sort(), ["n", "t"]);
    assert.deepEqual(copied[0]?.output, { ok: 1 });
    // The old run is not changed, and a second retry makes a second run.
    assert.equal((await a.runs.results(failed.id)).length, 4);
    assert.notEqual((await a.runs.createRetry(failed.id))?.id, retry.id);
  });

  it("credentials: sealed at rest, merged on update, scoped, rotated", async () => {
    const key = randomBytes(32);
    const a = forOrganization(db, "o1", { secretKey: key });
    const b = forOrganization(db, "o2", { secretKey: key });
    const created = await a.credentials.create({
      name: "API",
      type: "http.basic",
      data: { username: "ann", password: "hunter2-secret" },
    });
    await assert.rejects(
      a.credentials.create({ name: "API", type: "http.bearer", data: { token: "x" } }),
      ConflictError,
    );

    // The row holds no readable secret.
    const raw = await db.select().from(schema.credential);
    assert.equal(
      raw.some((r) => r.dataEncrypted.includes("hunter2-secret")),
      false,
    );

    // The summary has no data, and another organization sees nothing.
    assert.deepEqual(Object.keys((await a.credentials.list())[0] ?? {}).sort(), [
      "connected",
      "createdAt",
      "id",
      "name",
      "status",
      "type",
      "updatedAt",
    ]);
    assert.equal((await b.credentials.list()).length, 0);
    assert.equal(await b.credentials.open(created.id), null);
    assert.equal(await b.credentials.remove(created.id), false);

    // An empty field keeps the saved value.
    await a.credentials.update(created.id, { patch: { username: "bob", password: "" } });
    assert.deepEqual((await a.credentials.open(created.id))?.data, {
      username: "bob",
      password: "hunter2-secret",
    });

    // A graph that uses the credential is found.
    const wf = await a.workflows.create({ name: "uses cred" });
    await a.workflows.saveDraft(wf.id, {
      schema: 1,
      nodes: [{ id: "n", credentialId: created.id }],
      edges: [],
    });
    assert.deepEqual(
      (await a.credentials.usedBy(created.id)).map((w) => w.name),
      ["uses cred"],
    );

    // Rotation: the new key opens it, the old key does not.
    const newKey = randomBytes(32);
    assert.equal(await rotateSecretKey(db, key, newKey), 1);
    assert.deepEqual(
      (await forOrganization(db, "o1", { secretKey: newKey }).credentials.open(created.id))?.data,
      {
        username: "bob",
        password: "hunter2-secret",
      },
    );
    await assert.rejects(a.credentials.open(created.id), /Could not decrypt/);
  });

  it("variables: scoped, unique, and found in graphs", async () => {
    const a = forOrganization(db, "o1");
    const b = forOrganization(db, "o2");
    await a.variables.create(
      { key: "baseUrl", type: "string", value: "https://x", description: "" },
      null,
    );
    await a.variables.create({ key: "limit", type: "number", value: 5, description: "max" }, null);
    await assert.rejects(
      a.variables.create({ key: "baseUrl", type: "string", value: "y", description: "" }, null),
      ConflictError,
    );
    assert.deepEqual(await a.variables.asRecord(), { baseUrl: "https://x", limit: 5 });
    assert.deepEqual(await b.variables.asRecord(), {});
    assert.equal(await a.variables.count(), 2);
    assert.equal(await b.variables.remove("baseUrl"), false);

    const wf = await a.workflows.create({ name: "uses var" });
    await a.workflows.saveDraft(wf.id, {
      schema: 1,
      nodes: [{ id: "n", config: { url: "{{ $vars.baseUrl }}/x", other: '{{ $vars["limit"] }}' } }],
      edges: [],
    });
    assert.deepEqual(
      (await a.variables.usedBy("baseUrl")).map((w) => w.name),
      ["uses var"],
    );
    assert.deepEqual(
      (await a.variables.usedBy("limit")).map((w) => w.name),
      ["uses var"],
    );
    assert.deepEqual(await a.variables.usedBy("nope"), []);
  });
});
