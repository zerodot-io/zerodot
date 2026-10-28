// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createDb, forOrganization } from "@zerodot/db";
import { resetDatabase as reset, seedOrganization } from "@zerodot/db/testing";
import type { ApiServices } from "./context.server";
import { handleApi } from "./handler.server";
import { handleMcp } from "./mcp.server";

const url = process.env.DATABASE_URL;
const BASE = "http://zerodot.test";

type Json = Record<string, unknown>;

describe("public API", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const secretKey = randomBytes(32);
  const queued: { runId: string; mode: string }[] = [];
  const hits = new Map<string, number>();
  let rateLimit = 1000;

  const services: ApiServices = {
    db: handle.db,
    secretKey,
    tableMaxRows: 1000,
    baseUrl: BASE,
    syncTimeoutMs: 400,
    get rateLimitPerMinute() {
      return rateLimit;
    },
    async enqueue(input) {
      queued.push({ runId: input.runId, mode: input.mode });
    },
    async hit(key) {
      const next = (hits.get(key) ?? 0) + 1;
      hits.set(key, next);
      return next;
    },
    session: async () => null,
    syncSchedules: async () => {},
    draftChanged: async () => {},
    reader: () => {
      throw new Error("no reader in tests");
    },
  };

  let adminKey = "";
  let memberKey = "";
  let otherKey = "";

  async function call(
    method: string,
    path: string,
    options: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const response = await handleApi(
      services,
      new Request(`${BASE}/api/v1${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      json: (text ? JSON.parse(text) : null) as Json,
    };
  }

  const graph = (url = "https://example.com") => ({
    schema: 1,
    nodes: [
      {
        id: "t",
        type: "trigger.manual",
        name: "Start",
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: "h",
        type: "http.request",
        name: "Call",
        position: { x: 200, y: 0 },
        config: { method: "GET", url },
      },
    ],
    edges: [{ id: "e", from: "t", fromPort: "out", to: "h", toPort: "in" }],
  });

  before(async () => {
    await reset(handle);
    await seedOrganization(handle, "o1");
    await seedOrganization(handle, "o2");
    const one = forOrganization(handle.db, "o1");
    adminKey = (
      await one.apiKeys.create({ name: "a", role: "admin", expiresAt: null, userId: null })
    ).key;
    memberKey = (
      await one.apiKeys.create({ name: "m", role: "member", expiresAt: null, userId: null })
    ).key;
    otherKey = (
      await forOrganization(handle.db, "o2").apiKeys.create({
        name: "o",
        role: "admin",
        expiresAt: null,
        userId: null,
      })
    ).key;
  });
  after(() => handle.close());

  it("rejects missing, wrong, and expired keys with one error shape", async () => {
    const none = await call("GET", "/workflows");
    assert.equal(none.status, 401);
    assert.equal((none.json.error as Json).code, "unauthorized");
    assert.equal((await call("GET", "/workflows", { key: "zerodot_nope" })).status, 401);
    const expired = await forOrganization(handle.db, "o1").apiKeys.create({
      name: "old",
      role: "admin",
      expiresAt: new Date(Date.now() - 1000),
      userId: null,
    });
    const result = await call("GET", "/workflows", { key: expired.key });
    assert.equal(result.status, 401);
    assert.match(String((result.json.error as Json).message), /expired/);
  });

  it("keeps projects apart", async () => {
    const created = await call("POST", "/workflows", { key: adminKey, body: { name: "Mine" } });
    assert.equal(created.status, 201);
    const id = String(created.json.id);
    assert.equal((await call("GET", `/workflows/${id}`, { key: otherKey })).status, 404);
    const list = await call("GET", "/workflows", { key: otherKey });
    assert.deepEqual(list.json.items, []);
  });

  it("returns 404 for unknown routes and 405 for a wrong method", async () => {
    assert.equal((await call("GET", "/nope", { key: adminKey })).status, 404);
    const wrong = await call("DELETE", "/workflows", { key: adminKey });
    assert.equal(wrong.status, 405);
  });

  it("limits calls for each key", async () => {
    hits.clear();
    rateLimit = 2;
    try {
      assert.equal((await call("GET", "/workflows", { key: memberKey })).status, 200);
      assert.equal((await call("GET", "/workflows", { key: memberKey })).status, 200);
      const blocked = await call("GET", "/workflows", { key: memberKey });
      assert.equal(blocked.status, 429);
      assert.equal(blocked.headers.get("retry-after"), "60");
    } finally {
      rateLimit = 1000;
    }
  });

  it("paginates with a cursor", async () => {
    for (const name of ["p1", "p2", "p3"]) {
      await call("POST", "/workflows", { key: adminKey, body: { name } });
    }
    const first = await call("GET", "/workflows?limit=2", { key: adminKey });
    assert.equal((first.json.items as unknown[]).length, 2);
    assert.ok(first.json.nextCursor);
    const second = await call("GET", `/workflows?limit=2&cursor=${first.json.nextCursor}`, {
      key: adminKey,
    });
    const ids = [...(first.json.items as Json[]), ...(second.json.items as Json[])].map(
      (w) => w.id,
    );
    assert.equal(new Set(ids).size, ids.length);
  });

  it("checks the graph against the node types", async () => {
    const before = (
      (await call("GET", "/workflows?limit=100", { key: adminKey })).json.items as unknown[]
    ).length;
    const bad = graph();
    const call2 = bad.nodes[1];
    if (call2) call2.config = { method: "FETCH", url: "x" } as never;
    const result = await call("POST", "/workflows", {
      key: adminKey,
      body: { name: "Bad", graph: bad },
    });
    assert.equal(result.status, 400);
    assert.match(String((result.json.error as Json).message), /config\.method/);
    const after = (
      (await call("GET", "/workflows?limit=100", { key: adminKey })).json.items as unknown[]
    ).length;
    assert.equal(after, before, "a bad graph must not leave a workflow behind");
  });

  it("runs the workflow lifecycle: draft, publish, activate, run, idempotency", async () => {
    const created = await call("POST", "/workflows", {
      key: memberKey,
      body: { name: "Flow", graph: graph() },
    });
    assert.equal(created.status, 201);
    const id = String(created.json.id);

    // Cannot run before publish.
    const early = await call("POST", `/workflows/${id}/run`, { key: memberKey, body: {} });
    assert.equal(early.status, 409);

    const published = await call("POST", `/workflows/${id}/publish`, { key: memberKey, body: {} });
    assert.equal(published.status, 200);
    assert.equal(published.json.version, 1);

    const versions = await call("GET", `/workflows/${id}/versions`, { key: memberKey });
    assert.equal((versions.json.items as unknown[]).length, 1);
    const one = await call("GET", `/workflows/${id}/versions/1`, { key: memberKey });
    assert.equal(one.status, 200);
    assert.ok(one.json.graph);

    assert.equal(
      (await call("POST", `/workflows/${id}/activate`, { key: memberKey, body: { active: true } }))
        .status,
      200,
    );

    const before = queued.length;
    const headers = { "idempotency-key": "k1" };
    const first = await call("POST", `/workflows/${id}/run`, {
      key: memberKey,
      body: { input: { a: 1 } },
      headers,
    });
    assert.equal(first.status, 202);
    const again = await call("POST", `/workflows/${id}/run`, { key: memberKey, body: {}, headers });
    assert.equal(again.json.runId, first.json.runId);
    assert.equal(queued.length, before + 1, "a repeated key queues nothing");

    const run = await call("GET", `/runs/${first.json.runId}`, { key: memberKey });
    assert.equal(run.json.mode, "production");
    assert.deepEqual(run.json.triggerInput, { a: 1 });
    assert.equal((await call("GET", `/runs?workflowId=${id}`, { key: memberKey })).status, 200);
  });

  it("restores a version into the draft and keeps the published version", async () => {
    const created = await call("POST", "/workflows", {
      key: memberKey,
      body: { name: "History", graph: graph("https://one.test") },
    });
    const id = String(created.json.id);
    await call("POST", `/workflows/${id}/publish`, { key: memberKey, body: {} });
    await call("PATCH", `/workflows/${id}`, {
      key: memberKey,
      body: { graph: graph("https://two.test") },
    });
    const second = await call("POST", `/workflows/${id}/publish`, { key: memberKey, body: {} });
    assert.equal(second.json.version, 2);
    await call("PATCH", `/workflows/${id}`, {
      key: memberKey,
      body: { graph: graph("https://draft.test") },
    });

    const urlOf = (json: Json) =>
      ((json.draftGraph as { nodes: { id: string; config: { url?: string } }[] }).nodes.find(
        (n) => n.id === "h",
      )?.config.url ?? "") as string;

    const restored = await call("POST", `/workflows/${id}/versions/1/restore`, { key: memberKey });
    assert.equal(restored.status, 200);
    assert.equal(urlOf(restored.json), "https://one.test");
    const detail = await call("GET", `/workflows/${id}`, { key: memberKey });
    assert.equal(urlOf(detail.json), "https://one.test");
    const versions = await call("GET", `/workflows/${id}/versions`, { key: memberKey });
    assert.equal((versions.json.items as unknown[]).length, 2, "a restore adds no version");
    const org = forOrganization(handle.db, "o1");
    assert.equal(
      (await org.workflows.get(id))?.publishedVersionId,
      (await org.workflows.versionByNumber(id, 2))?.id,
      "the published version stays version 2",
    );

    assert.equal(
      (await call("POST", `/workflows/${id}/versions/9/restore`, { key: memberKey })).status,
      404,
    );
    assert.equal(
      (await call("POST", `/workflows/${id}/versions/1/restore`, { key: otherKey })).status,
      404,
    );
  });

  it("retries a failed run from the failed node", async () => {
    const created = await call("POST", "/workflows", {
      key: memberKey,
      body: { name: "Retry", graph: graph() },
    });
    const id = String(created.json.id);
    await call("POST", `/workflows/${id}/publish`, { key: memberKey, body: {} });
    const started = await call("POST", `/workflows/${id}/run`, {
      key: memberKey,
      body: { input: { a: 1 } },
    });
    const runId = String(started.json.runId);
    const org = forOrganization(handle.db, "o1");

    // A run that has not ended cannot be retried.
    assert.equal((await call("POST", `/runs/${runId}/retry`, { key: memberKey })).status, 409);

    const now = new Date();
    await org.runs.saveNodeResult(runId, {
      nodeId: "t",
      attempt: 1,
      status: "succeeded",
      port: "out",
      output: { a: 1 },
      startedAt: now,
      finishedAt: now,
    });
    await org.runs.saveNodeResult(runId, {
      nodeId: "h",
      attempt: 1,
      status: "failed",
      error: { message: "boom" },
      startedAt: now,
      finishedAt: now,
    });
    await org.runs.finish(runId, { status: "failed", error: { message: "boom", nodeId: "h" } });

    const before = queued.length;
    const retry = await call("POST", `/runs/${runId}/retry`, { key: memberKey });
    assert.equal(retry.status, 202);
    assert.notEqual(retry.json.runId, runId);
    assert.equal(queued.length, before + 1);
    assert.equal(queued.at(-1)?.runId, retry.json.runId);

    const detail = await call("GET", `/runs/${retry.json.runId}`, { key: memberKey });
    assert.equal(detail.json.mode, "production");
    assert.deepEqual(detail.json.triggerInput, { a: 1 });
    const results = detail.json.results as Json[];
    assert.deepEqual(
      results.map((r) => [r.nodeId, r.status]),
      [["t", "succeeded"]],
      "only the succeeded node is copied",
    );
    // The old run did not change.
    const old = await call("GET", `/runs/${runId}`, { key: memberKey });
    assert.equal(old.json.status, "failed");
    assert.equal((old.json.results as unknown[]).length, 2);

    // Another project cannot see the run.
    assert.equal((await call("POST", `/runs/${runId}/retry`, { key: otherKey })).status, 404);
  });

  it("exports a workflow and imports it as a draft", async () => {
    const created = await call("POST", "/workflows", {
      key: memberKey,
      body: { name: "Portable", graph: graph() },
    });
    const id = String(created.json.id);
    const exported = await call("GET", `/workflows/${id}/export`, { key: memberKey });
    assert.equal(exported.status, 200);
    assert.equal(exported.json.name, "Portable");
    assert.deepEqual(exported.json.variables, []);

    const imported = await call("POST", "/workflows/import", {
      key: memberKey,
      body: { file: { ...exported.json, variables: ["missing_key"] } },
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.json.name, "Portable");
    assert.deepEqual(imported.json.missingVariables, ["missing_key"]);
    const detail = await call("GET", `/workflows/${imported.json.id}`, { key: memberKey });
    assert.equal(detail.json.published, false);
    assert.ok(detail.json.draftGraph);

    const bad = await call("POST", "/workflows/import", {
      key: memberKey,
      body: { file: { hello: 1 } },
    });
    assert.equal(bad.status, 400);
  });

  it("queues a test run that stops at a node", async () => {
    const created = await call("POST", "/workflows", {
      key: memberKey,
      body: { name: "Stops", graph: graph() },
    });
    const id = String(created.json.id);
    const ok = await call("POST", `/workflows/${id}/test`, {
      key: memberKey,
      body: { toNodeId: "t" },
    });
    assert.equal(ok.status, 202);
    const run = await forOrganization(handle.db, "o1").runs.get(String(ok.json.runId));
    assert.deepEqual(run?.testTarget, { kind: "to", nodeId: "t" });
    const missing = await call("POST", `/workflows/${id}/test`, {
      key: memberKey,
      body: { toNodeId: "nope" },
    });
    assert.equal(missing.status, 400);
  });

  it("holds a request with wait=true until the run ends, and answers 202 after the timeout", async () => {
    const created = await call("POST", "/workflows", {
      key: adminKey,
      body: { name: "Wait", graph: graph() },
    });
    const id = String(created.json.id);

    // Timeout: nothing finishes the run.
    const slow = await call("POST", `/workflows/${id}/test?wait=true`, { key: adminKey, body: {} });
    assert.equal(slow.status, 202);
    assert.equal(slow.json.status, "queued");

    // A worker finishes the run while the request waits.
    const scope = forOrganization(handle.db, "o1");
    const finisher = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      const runId = queued.at(-1)?.runId ?? "";
      const now = new Date();
      await scope.runs.saveNodeResult(runId, {
        nodeId: "h",
        attempt: 1,
        status: "succeeded",
        port: "out",
        output: { status: 200 },
        startedAt: now,
        finishedAt: now,
      });
      await scope.runs.finish(runId, { status: "succeeded" });
    })();
    const fast = await call("POST", `/workflows/${id}/test?wait=true`, { key: adminKey, body: {} });
    await finisher;
    assert.equal(fast.status, 200);
    assert.equal(fast.json.status, "succeeded");
    assert.deepEqual(fast.json.output, { status: 200 });
    const detail = await call("GET", `/runs/${fast.json.runId}`, { key: adminKey });
    const results = detail.json.results as Json[];
    assert.equal(results[0]?.nodeName, "Call");
  });

  it("needs the admin role for variable writes", async () => {
    const body = { key: "baseUrl", type: "string", value: "https://x.test", description: "" };
    assert.equal((await call("POST", "/variables", { key: memberKey, body })).status, 403);
    assert.equal((await call("POST", "/variables", { key: adminKey, body })).status, 201);
    assert.equal((await call("POST", "/variables", { key: adminKey, body })).status, 409);
    const bad = await call("POST", "/variables", {
      key: adminKey,
      body: { key: "n", type: "number", value: "x" },
    });
    assert.equal(bad.status, 400);
    const list = await call("GET", "/variables", { key: memberKey });
    assert.equal((list.json.items as unknown[]).length, 1);
    assert.equal(
      (
        await call("PATCH", "/variables/baseUrl", {
          key: adminKey,
          body: { type: "string", value: "https://y.test" },
        })
      ).status,
      200,
    );
    assert.equal((await call("DELETE", "/variables/baseUrl", { key: adminKey })).status, 200);
  });

  it("manages data tables and rows", async () => {
    const columns = [
      { key: "email", type: "string", required: true, unique: true },
      { key: "n", type: "number" },
    ];
    assert.equal(
      (await call("POST", "/tables", { key: memberKey, body: { name: "people", columns } })).status,
      403,
    );
    const table = await call("POST", "/tables", {
      key: adminKey,
      body: { name: "people", columns },
    });
    assert.equal(table.status, 201);
    const id = String(table.json.id);

    const inserted = await call("POST", `/tables/${id}/rows`, {
      key: memberKey,
      body: {
        rows: [
          { email: "a@x.test", n: 1 },
          { email: "b@x.test", n: 2 },
        ],
      },
    });
    assert.equal(inserted.status, 201);
    assert.equal(inserted.json.count, 2);

    const wrong = await call("POST", `/tables/${id}/rows`, {
      key: memberKey,
      body: { rows: [{ email: "c@x.test", n: "many" }] },
    });
    assert.equal(wrong.status, 400);

    const found = await call("POST", `/tables/${id}/rows/query`, {
      key: memberKey,
      body: { filter: { field: "n", op: "gt", value: 1 } },
    });
    assert.equal((found.json.rows as unknown[]).length, 1);

    const list = await call("GET", "/tables/people/rows", { key: memberKey });
    assert.equal((list.json.rows as unknown[]).length, 2);

    const rowId = String((list.json.rows as Json[])[0]?.id);
    const patched = await call("PATCH", `/tables/${id}/rows/${rowId}`, {
      key: memberKey,
      body: { set: { n: 9 } },
    });
    assert.equal(patched.json.n, 9);

    const bulk = await call("PATCH", `/tables/${id}/rows`, {
      key: memberKey,
      body: { all: true, increment: { n: 1 } },
    });
    assert.equal(bulk.json.count, 2);
    const guard = await call("PATCH", `/tables/${id}/rows`, {
      key: memberKey,
      body: { set: { n: 0 } },
    });
    assert.equal(guard.status, 400);

    assert.equal(
      (await call("DELETE", `/tables/${id}/rows/${rowId}`, { key: memberKey })).json.deleted,
      true,
    );
    assert.equal((await call("DELETE", `/tables/${id}`, { key: memberKey })).status, 403);
    assert.equal((await call("DELETE", `/tables/${id}`, { key: adminKey })).json.deleted, true);
  });

  it("never returns credential values", async () => {
    const secret = "s3cr3t-token-value";
    const created = await call("POST", "/credentials", {
      key: adminKey,
      body: { name: "api", type: "http.bearer", fields: { token: secret } },
    });
    assert.equal(created.status, 201);
    const list = await call("GET", "/credentials", { key: memberKey });
    assert.equal(list.status, 200);
    assert.ok(!JSON.stringify([created.json, list.json]).includes(secret));
    assert.equal(
      (
        await call("POST", "/credentials", {
          key: memberKey,
          body: { name: "x", type: "http.bearer", fields: { token: "t" } },
        })
      ).status,
      403,
    );
    const bad = await call("POST", "/credentials", {
      key: adminKey,
      body: { name: "y", type: "http.bearer", fields: {} },
    });
    assert.equal(bad.status, 400);
    assert.equal(
      (await call("DELETE", `/credentials/${created.json.id}`, { key: adminKey })).json.deleted,
      true,
    );
  });

  it("lists node types with the JSON Schema of the config", async () => {
    const list = await call("GET", "/node-types", { key: memberKey });
    assert.ok((list.json.items as Json[]).some((n) => n.type === "http.request"));
    const one = await call("GET", "/node-types/http.request", { key: memberKey });
    assert.ok(one.json.configSchema);
    assert.equal((await call("GET", "/node-types/nope", { key: memberKey })).status, 404);
  });

  it("serves insights", async () => {
    for (const view of ["summary", "timeseries", "workflows", "nodes", "errors"]) {
      const result = await call("GET", `/insights/${view}?range=24h`, { key: memberKey });
      assert.equal(result.status, 200, view);
    }
    assert.equal((await call("GET", "/insights/summary?range=1y", { key: memberKey })).status, 400);
  });

  it("serves an OpenAPI 3.1 document where every reference resolves", async () => {
    const result = await call("GET", "/openapi.json");
    assert.equal(result.status, 200);
    assert.equal(result.json.openapi, "3.1.0");
    const paths = result.json.paths as Record<string, Json>;
    assert.ok(paths["/workflows/{id}/run"]);
    assert.ok(paths["/tables/{id}/rows/{rowId}"]);
    const text = JSON.stringify(result.json);
    const schemas = (result.json.components as { schemas: Json }).schemas;
    for (const [, name] of text.matchAll(/#\/components\/schemas\/([\w-]+)/g)) {
      assert.ok(name && name in schemas, `unresolved reference ${name}`);
    }
    assert.ok(!text.includes("#/$defs"), "no reference may point into $defs");
  });

  describe("MCP", () => {
    let id = 0;
    async function rpc(key: string | null, method: string, params: Json = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (key) headers.authorization = `Bearer ${key}`;
      const response = await handleMcp(
        services,
        new Request(`${BASE}/mcp`, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        }),
      );
      const text = await response.text();
      return { status: response.status, json: text ? (JSON.parse(text) as Json) : null };
    }
    const resultOf = <T>(reply: { json: Json | null }): T => (reply.json?.result ?? {}) as T;
    const toolResult = (reply: { json: Json | null }) => {
      const result = reply.json?.result as { isError?: boolean; content: { text: string }[] };
      return {
        isError: Boolean(result.isError),
        data: JSON.parse(result.content[0]?.text ?? "null") as Json,
      };
    };

    it("needs an API key", async () => {
      const reply = await rpc(null, "tools/list");
      assert.equal(reply.status, 401);
    });

    it("lists tools by role", async () => {
      const names = async (key: string) =>
        resultOf<{ tools: { name: string }[] }>(await rpc(key, "tools/list")).tools.map(
          (t) => t.name,
        );
      const admin = await names(adminKey);
      const member = await names(memberKey);
      for (const name of [
        "list_workflows",
        "create_workflow",
        "test_workflow",
        "get_run",
        "get_node_type",
        "query_rows",
      ]) {
        assert.ok(member.includes(name), name);
      }
      assert.ok(admin.includes("set_variable"));
      assert.ok(!member.includes("set_variable"));
      assert.ok(!admin.some((n) => n.startsWith("delete_")), "destructive tools are off");
    });

    it("builds, tests, and publishes a workflow like an agent", async () => {
      const created = toolResult(
        await rpc(memberKey, "tools/call", {
          name: "create_workflow",
          arguments: { name: "Agent flow", graph: graph() },
        }),
      );
      assert.equal(created.isError, false);
      const workflowId = String(created.data.id);

      const test = toolResult(
        await rpc(memberKey, "tools/call", {
          name: "test_workflow",
          arguments: { id: workflowId },
        }),
      );
      assert.equal(test.isError, false);
      const run = toolResult(
        await rpc(memberKey, "tools/call", {
          name: "get_run",
          arguments: { id: String(test.data.runId) },
        }),
      );
      assert.equal(run.data.mode, "test");

      const publish = toolResult(
        await rpc(memberKey, "tools/call", {
          name: "publish_workflow",
          arguments: { id: workflowId },
        }),
      );
      assert.equal(publish.data.version, 1);
    });

    it("reports a problem as a tool error, not a crash", async () => {
      const bad = graph();
      const second = bad.nodes[1];
      if (second) second.type = "nope.nope";
      const result = toolResult(
        await rpc(memberKey, "tools/call", {
          name: "create_workflow",
          arguments: { name: "Bad agent flow", graph: bad },
        }),
      );
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result.data), /unknown node type/);
    });

    it("sets a variable with an admin key", async () => {
      const result = toolResult(
        await rpc(adminKey, "tools/call", {
          name: "set_variable",
          arguments: { key: "mcpVar", type: "number", value: 5 },
        }),
      );
      assert.equal(result.isError, false);
      const again = toolResult(
        await rpc(adminKey, "tools/call", {
          name: "set_variable",
          arguments: { key: "mcpVar", type: "number", value: 6 },
        }),
      );
      assert.equal(again.data.value, 6);
    });

    it("reads workflow graphs as resources", async () => {
      const list = await rpc(memberKey, "resources/templates/list");
      const { resourceTemplates: templates } = resultOf<{
        resourceTemplates: { uriTemplate: string }[];
      }>(list);
      assert.ok(templates.some((t) => t.uriTemplate === "zerodot://workflows/{id}/graph"));
    });
  });
});
