// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { sql } from "drizzle-orm";
import {
  ConflictError,
  createDb,
  findWebhookTrigger,
  findWorkflowShare,
  forOrganization,
  rotateSecretKey,
  runMigrations,
  schema,
  useWorkflowShare,
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

  it("saves a draft only when the row did not change since ifUpdatedAt", async () => {
    const a = forOrganization(db, "o1");
    // A new row has microseconds (defaultNow). A JS date has milliseconds.
    const wf = await a.workflows.create({ name: "draft check" });
    const first = await a.workflows.saveDraft(wf.id, { v: 1 }, { ifUpdatedAt: wf.updatedAt });
    assert.ok(first);
    // The other tab still holds the first time.
    assert.equal(await a.workflows.saveDraft(wf.id, { v: 2 }, { ifUpdatedAt: wf.updatedAt }), null);
    assert.deepEqual((await a.workflows.get(wf.id))?.draftGraph, { v: 1 });
    assert.ok(await a.workflows.saveDraft(wf.id, { v: 3 }, { ifUpdatedAt: first.updatedAt }));
  });

  it("finds names with a number after them", async () => {
    const a = forOrganization(db, "o1");
    for (const n of ["Sync", "Sync 2", "Syncer", "Other"]) await a.workflows.create({ name: n });
    assert.deepEqual((await a.workflows.namesLike("Sync")).sort(), ["Sync", "Sync 2"]);
    assert.deepEqual(await forOrganization(db, "o2").workflows.namesLike("Sync"), []);
  });

  it("shares a workflow at many links", async () => {
    const a = forOrganization(db, "o1");
    const b = forOrganization(db, "o2");
    const wf = await a.workflows.create({ name: "shared" });
    assert.deepEqual(await a.workflows.listShares(wf.id), []);
    const one = await a.workflows.createShare({
      workflowId: wf.id,
      file: { v: 1 },
      createdBy: null,
    });
    const two = await a.workflows.createShare({
      workflowId: wf.id,
      file: { v: 1 },
      createdBy: null,
      label: "Buyer",
      singleUse: true,
    });
    assert.notEqual(one.id, two.id);
    assert.equal((await a.workflows.listShares(wf.id)).length, 2);
    assert.deepEqual(await b.workflows.listShares(wf.id), []);
    assert.equal(await b.workflows.getShare(one.id), null);
    assert.equal(await b.workflows.updateShare(one.id, { passwordHash: "x" }), null);
    assert.equal(await b.workflows.removeShare(one.id), false);

    await a.workflows.updateShare(one.id, { file: { v: 2 }, passwordHash: "salt:hash" });
    assert.deepEqual((await findWorkflowShare(db, one.id))?.file, { v: 2 });
    assert.equal((await findWorkflowShare(db, one.id))?.passwordHash, "salt:hash");

    assert.deepEqual((await useWorkflowShare(db, two.id))?.file, { v: 1 });
    assert.equal(await useWorkflowShare(db, two.id), null);
    assert.ok((await findWorkflowShare(db, two.id))?.usedAt);

    assert.equal(await a.workflows.removeShare(one.id), true);
    assert.equal(await findWorkflowShare(db, one.id), null);
    assert.ok(await findWorkflowShare(db, two.id));
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

  it("gives a token to any trigger that has a webhook lifecycle", async () => {
    const a = forOrganization(db, "o1");
    const wf = await a.workflows.create({ name: "app-trigger" });
    const trig = { id: "t9", type: "trigger.app", config: {}, webhook: true };
    await a.workflows.publish(wf.id, { graph: { v: 1 }, triggerNodes: [trig], userId: null });
    const [row] = await a.workflows.triggers([wf.id]);
    const found = await findWebhookTrigger(db, tokenOf(row));
    assert.equal(found?.nodeId, "t9");
    assert.equal(found?.nodeType, "trigger.app");
    const other = await a.workflows.create({ name: "no-webhook" });
    await a.workflows.publish(other.id, {
      graph: { v: 1 },
      triggerNodes: [{ id: "t8", type: "trigger.app", config: {} }],
      userId: null,
    });
    assert.deepEqual(await a.workflows.triggers([other.id]), []);
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
      "fields",
      "id",
      "name",
      "status",
      "type",
      "updatedAt",
    ]);
    // Field names only. No value.
    assert.deepEqual((await a.credentials.list())[0]?.fields, ["password", "username"]);
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

    // A config that reads a field by name is found too.
    const byName = await a.workflows.create({ name: "reads field" });
    await a.workflows.saveDraft(byName.id, {
      schema: 1,
      nodes: [{ id: "n", config: { url: 'x/{{ $credentials["API"].password }}' } }],
      edges: [],
    });
    assert.deepEqual(
      (await a.credentials.usedBy(created.id)).map((w) => w.name),
      ["reads field", "uses cred"],
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
