// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it, mock } from "node:test";
import { createDb, forOrganization } from "@zerodot/db";
import { resetDatabase, seedOrganization } from "@zerodot/db/testing";
import { memoryBlobStore } from "@zerodot/engine";
import { createConnection, projectStreamKey, readStream, runStreamKey } from "@zerodot/queue";
import { handleCronJob } from "./cron-job";
import { processRun } from "./process-run";

const databaseUrl = process.env.DATABASE_URL;
const valkeyUrl = process.env.VALKEY_URL;

const graph = {
  schema: 1,
  nodes: [
    { id: "t", type: "trigger.webhook", name: "Hook", position: { x: 0, y: 0 }, config: {} },
    {
      id: "a",
      type: "http.request",
      name: "Fetch",
      position: { x: 0, y: 0 },
      // The condition below reads the status, so the node returns the full response.
      config: {
        method: "GET",
        url: "https://api.example.com/users/{{ $trigger.body.id }}",
        fullResponse: true,
      },
    },
    {
      id: "i",
      type: "logic.if",
      name: "Is ok",
      position: { x: 0, y: 0 },
      config: { condition: "{{ $input.status == 200 }}" },
    },
    {
      id: "yes",
      type: "http.request",
      name: "Notify",
      position: { x: 0, y: 0 },
      config: {
        method: "POST",
        url: "https://hooks.example.com/ok",
        body: { name: "{{ $node['Fetch'].data.body.name }}" },
      },
    },
    {
      id: "no",
      type: "http.request",
      name: "Alert",
      position: { x: 0, y: 0 },
      config: { method: "POST", url: "https://hooks.example.com/bad" },
    },
  ],
  edges: [
    { id: "e1", from: "t", fromPort: "out", to: "a", toPort: "in" },
    { id: "e2", from: "a", fromPort: "out", to: "i", toPort: "in" },
    { id: "e3", from: "i", fromPort: "true", to: "yes", toPort: "in" },
    { id: "e4", from: "i", fromPort: "false", to: "no", toPort: "in" },
  ],
};

describe("processRun", { skip: !(databaseUrl && valkeyUrl) }, () => {
  const handle = createDb(databaseUrl ?? "postgres://unused");
  const redis = createConnection(valkeyUrl ?? "redis://unused");
  const secretKey = randomBytes(32);
  const resumes: { runId: string; delayMs: number }[] = [];
  const queued: string[] = [];
  const deps = {
    db: handle.db,
    redis,
    runTimeoutMs: 10_000,
    maxOutputBytes: 1_000_000,
    envAllowlist: [],
    secretKey,
    scheduleResume: async (input: { runId: string; delayMs: number }) => {
      resumes.push(input);
    },
    enqueueRun: async (input: { runId: string }) => {
      queued.push(input.runId);
    },
  };

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
  });
  after(async () => {
    await handle.close();
    redis.disconnect();
  });

  it("runs webhook -> http -> if -> http, saves results, publishes events", async () => {
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "Ann" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "slice" });
    const version = await scope.workflows.publish(wf.id, {
      graph,
      triggerNodes: [{ id: "t", type: "trigger.webhook", config: {} }],
      userId: null,
    });
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "production",
      versionId: version?.id,
      triggerType: "webhook",
      triggerNodeId: "t",
      triggerInput: { body: { id: 42 } },
    });

    await processRun(deps, { runId: run.id, organizationId: "o1" });

    assert.deepEqual(urls, ["https://api.example.com/users/42", "https://hooks.example.com/ok"]);
    const done = await scope.runs.get(run.id);
    assert.equal(done?.status, "succeeded");
    assert.ok(done?.startedAt && done.finishedAt);

    const results = Object.fromEntries(
      (await scope.runs.results(run.id)).map((r) => [r.nodeId, r]),
    );
    assert.equal(results.t?.status, "succeeded");
    assert.equal(results.i?.port, "true");
    assert.equal(results.yes?.status, "succeeded");
    assert.equal(results.no?.status, "skipped");

    const events = await readStream(redis, runStreamKey(run.id), "0", 10);
    const types = events.map((e) => e.event.type);
    assert.equal(types[0], "run.started");
    assert.equal(types.at(-1), "run.finished");
    assert.ok(types.includes("node.skipped"));
    const project = await readStream(redis, projectStreamKey("o1"), "0", 10);
    assert.ok(project.some((e) => e.event.type === "run.finished"));

    const range = {
      from: new Date(Date.now() - 2 * 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    };
    const summary = await scope.stats.summary({ ...range, workflowIds: [wf.id] });
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    const nodes = await scope.stats.nodes({ ...range, workflowIds: [wf.id] });
    const byId = Object.fromEntries(nodes.map((n) => [n.nodeId, n]));
    assert.equal(byId.a?.nodeType, "http.request");
    assert.equal(byId.a?.succeeded, 1);
    // A skipped node is not a run of that node.
    assert.equal(byId.no, undefined);
  });

  it("test run: stops at a node, and runs one node with a given input", async () => {
    const urls: string[] = [];
    mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "Ann" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "targets" });
    const toNode = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: graph,
      triggerType: "webhook",
      triggerNodeId: "t",
      triggerInput: { body: { id: 7 } },
      testTarget: { kind: "to", nodeId: "a" },
    });
    await processRun(deps, { runId: toNode.run.id, organizationId: "o1" });
    assert.deepEqual(urls, ["https://api.example.com/users/7"]);
    const stopped = await scope.runs.results(toNode.run.id);
    assert.deepEqual(stopped.map((r) => r.nodeId).sort(), ["a", "t"]);
    assert.equal((await scope.runs.get(toNode.run.id))?.status, "succeeded");

    urls.length = 0;
    const step = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: graph,
      triggerType: "manual",
      triggerNodeId: "yes",
      triggerInput: {},
      testTarget: {
        kind: "only",
        nodeId: "yes",
        input: { status: 200 },
        outputs: { a: { port: "out", data: { body: { name: "Bo" } } } },
      },
    });
    await processRun(deps, { runId: step.run.id, organizationId: "o1" });
    assert.deepEqual(urls, ["https://hooks.example.com/ok"]);
    const only = await scope.runs.results(step.run.id);
    assert.deepEqual(
      only.map((r) => [r.nodeId, r.status]),
      [["yes", "succeeded"]],
    );
    assert.equal((await scope.runs.get(step.run.id))?.status, "succeeded");
  });

  it("retries a failed run from the failed node and does not run the earlier nodes again", async () => {
    const urls: string[] = [];
    let failFetch = true;
    mock.method(globalThis, "fetch", async (url: string) => {
      urls.push(String(url));
      if (failFetch && String(url).includes("hooks.example.com/ok")) {
        throw new Error("network down");
      }
      return new Response(JSON.stringify({ name: "Ann" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "retry" });
    const version = await scope.workflows.publish(wf.id, {
      graph,
      triggerNodes: [{ id: "t", type: "trigger.webhook", config: {} }],
      userId: null,
    });
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "production",
      versionId: version?.id,
      triggerType: "webhook",
      triggerNodeId: "t",
      triggerInput: { body: { id: 5 } },
    });
    await processRun(deps, { runId: run.id, organizationId: "o1" });
    const failed = await scope.runs.get(run.id);
    assert.equal(failed?.status, "failed");
    assert.equal((failed?.error as { nodeId?: string } | null)?.nodeId, "yes");
    assert.deepEqual(urls, ["https://api.example.com/users/5", "https://hooks.example.com/ok"]);

    // The service fixes the cause, then retries.
    failFetch = false;
    urls.length = 0;
    const retry = await scope.runs.createRetry(run.id);
    assert.ok(retry);
    await processRun(deps, { runId: retry.id, organizationId: "o1" });
    assert.deepEqual(urls, ["https://hooks.example.com/ok"], "only the failed node runs again");
    assert.equal((await scope.runs.get(retry.id))?.status, "succeeded");
    const byId = Object.fromEntries((await scope.runs.results(retry.id)).map((r) => [r.nodeId, r]));
    assert.equal(byId.t?.status, "succeeded");
    assert.equal(byId.a?.status, "succeeded");
    assert.equal(byId.yes?.status, "succeeded");
    assert.equal(byId.no?.status, "skipped");
    // The old run keeps its failure.
    assert.equal((await scope.runs.get(run.id))?.status, "failed");
  });

  it("fails the run on a bad expression and names the path", async () => {
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "bad" });
    const bad = {
      schema: 1,
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "a",
          type: "http.request",
          name: "Call",
          position: { x: 0, y: 0 },
          config: { method: "GET", url: "https://x.example/{{ $trigger.nope.deep }}" },
        },
      ],
      edges: [{ id: "e", from: "t", fromPort: "out", to: "a", toPort: "in" }],
    };
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: bad,
      triggerType: "manual",
      triggerInput: {},
    });
    await processRun(deps, { runId: run.id, organizationId: "o1" });
    const done = await scope.runs.get(run.id);
    assert.equal(done?.status, "failed");
    assert.match(JSON.stringify(done?.error), /Cannot read/);
    const [result] = (await scope.runs.results(run.id)).filter((r) => r.nodeId === "a");
    assert.equal(result?.status, "failed");
    assert.equal((result?.error as { path?: string } | null)?.path, "config.url");

    // A test run is not in the default insights. It is when the filter asks for test runs.
    const range = {
      from: new Date(Date.now() - 2 * 3_600_000),
      to: new Date(Date.now() + 3_600_000),
    };
    const filter = { ...range, workflowIds: [wf.id] };
    assert.equal((await scope.stats.summary(filter)).failed, 0);
    assert.equal((await scope.stats.summary({ ...filter, includeTest: true })).failed, 1);
    const [group] = await scope.stats.errors({ ...filter, includeTest: true });
    assert.match(group?.sampleMessage ?? "", /Cannot read/);
    assert.equal(group?.lastRunId, run.id);
  });

  it("starts the error workflow when a live run fails, once, and not for its own failure", async () => {
    const scope = forOrganization(handle.db, "o1");
    const n = (id: string, type: string, name: string, config: Record<string, unknown>) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
    });
    const handler = await scope.workflows.create({ name: "on error" });
    const handlerGraph = {
      schema: 1,
      nodes: [n("e", "trigger.error", "On error", {})],
      edges: [],
    };
    const handlerVersion = await scope.workflows.publish(handler.id, {
      graph: handlerGraph,
      triggerNodes: [],
      userId: null,
    });
    const wf = await scope.workflows.create({ name: "breaks" });
    await scope.workflows.updateSettings(wf.id, { errorWorkflowId: handler.id });
    const failing = {
      schema: 1,
      nodes: [
        n("t", "trigger.manual", "Start", {}),
        n("a", "http.request", "Call", {
          method: "GET",
          url: "https://x.example/{{ $trigger.nope.deep }}",
        }),
      ],
      edges: [{ id: "e1", from: "t", fromPort: "out", to: "a", toPort: "in" }],
    };
    const version = await scope.workflows.publish(wf.id, {
      graph: failing,
      triggerNodes: [{ id: "t", type: "trigger.manual", config: {} }],
      userId: null,
    });
    const make = (mode: "production" | "test") =>
      scope.runs.create({
        workflowId: wf.id,
        mode,
        versionId: mode === "production" ? version?.id : undefined,
        graphSnapshot: mode === "test" ? failing : undefined,
        triggerType: "manual",
        triggerInput: {},
      });

    // A test run that fails starts nothing.
    const testRun = (await make("test")).run;
    queued.length = 0;
    await processRun(deps, { runId: testRun.id, organizationId: "o1" });
    assert.equal(queued.length, 0);

    // A live run that fails queues one run of the error workflow.
    const live = (await make("production")).run;
    await processRun(deps, { runId: live.id, organizationId: "o1" });
    assert.equal((await scope.runs.get(live.id))?.status, "failed");
    assert.equal(queued.length, 1);
    const errorRun = await scope.runs.get(queued[0] ?? "");
    assert.equal(errorRun?.workflowId, handler.id);
    assert.equal(errorRun?.triggerType, "error");
    assert.equal(errorRun?.versionId, handlerVersion?.id);
    const input = errorRun?.triggerInput as {
      runId: string;
      workflowId: string;
      failedNodeId: string;
    };
    assert.equal(input.runId, live.id);
    assert.equal(input.workflowId, wf.id);
    assert.equal(input.failedNodeId, "a");

    // The error run succeeds and starts nothing more.
    await processRun(deps, { runId: errorRun?.id ?? "", organizationId: "o1" });
    assert.equal((await scope.runs.get(errorRun?.id ?? ""))?.status, "succeeded");
    assert.equal(queued.length, 1);
  });

  it("retries a failed live run on its own, up to the limit, then starts the error workflow", async () => {
    const scope = forOrganization(handle.db, "o1");
    const n = (id: string, type: string, name: string, config: Record<string, unknown>) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
    });
    const handler = await scope.workflows.create({ name: "on error 2" });
    await scope.workflows.publish(handler.id, {
      graph: { schema: 1, nodes: [n("e", "trigger.error", "On error", {})], edges: [] },
      triggerNodes: [],
      userId: null,
    });
    const wf = await scope.workflows.create({ name: "flaky" });
    await scope.workflows.updateSettings(wf.id, {
      errorWorkflowId: handler.id,
      autoRetryMax: 2,
      autoRetryBackoffMs: 5000,
    });
    const failing = {
      schema: 1,
      nodes: [
        n("t", "trigger.manual", "Start", {}),
        n("a", "http.request", "Call", {
          method: "GET",
          url: "https://x.example/{{ $trigger.nope.deep }}",
        }),
      ],
      edges: [{ id: "e1", from: "t", fromPort: "out", to: "a", toPort: "in" }],
    };
    const version = await scope.workflows.publish(wf.id, {
      graph: failing,
      triggerNodes: [{ id: "t", type: "trigger.manual", config: {} }],
      userId: null,
    });
    const first = (
      await scope.runs.create({
        workflowId: wf.id,
        mode: "production",
        versionId: version?.id,
        triggerType: "manual",
        triggerInput: {},
      })
    ).run;
    queued.length = 0;
    resumes.length = 0;

    // First failure: a retry is queued after the backoff, and the error workflow waits.
    await processRun(deps, { runId: first.id, organizationId: "o1" });
    assert.equal((await scope.runs.get(first.id))?.status, "failed");
    assert.equal(queued.length, 0);
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.delayMs, 5000);
    const second = await scope.runs.get(resumes[0]?.runId ?? "");
    assert.equal(second?.autoRetryAttempt, 1);
    assert.equal(second?.versionId, version?.id);

    // Second failure: the last retry.
    await processRun(deps, { runId: second?.id ?? "", organizationId: "o1" });
    assert.equal(queued.length, 0);
    assert.equal(resumes.length, 2);
    const third = await scope.runs.get(resumes[1]?.runId ?? "");
    assert.equal(third?.autoRetryAttempt, 2);

    // Third failure: the retries are used up, so the error workflow starts once.
    await processRun(deps, { runId: third?.id ?? "", organizationId: "o1" });
    assert.equal(resumes.length, 2);
    assert.equal(queued.length, 1);
    const errorRun = await scope.runs.get(queued[0] ?? "");
    assert.equal(errorRun?.workflowId, handler.id);
    const errorInput = errorRun?.triggerInput as { runId: string };
    assert.equal(errorInput.runId, third?.id);

    // A test run is never retried.
    resumes.length = 0;
    const test = (
      await scope.runs.create({
        workflowId: wf.id,
        mode: "test",
        graphSnapshot: failing,
        triggerType: "manual",
        triggerInput: {},
      })
    ).run;
    await processRun(deps, { runId: test.id, organizationId: "o1" });
    assert.equal(resumes.length, 0);
  });

  it("stops at a delay node, then resumes and finishes", async () => {
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "delay" });
    const n = (id: string, type: string, name: string, config: Record<string, unknown>) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
    });
    const delayGraph = {
      schema: 1,
      nodes: [
        n("t", "trigger.manual", "Start", {}),
        // 0.05 seconds
        n("d", "flow.delay", "Pause", { amount: 0.05, unit: "seconds" }),
        n("s", "data.set", "Set", { fields: { done: true, who: "{{ $input.who }}" } }),
      ],
      edges: [
        { id: "e1", from: "t", fromPort: "out", to: "d", toPort: "in" },
        { id: "e2", from: "d", fromPort: "out", to: "s", toPort: "in" },
      ],
    };
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: delayGraph,
      triggerType: "manual",
      triggerInput: { who: "Ann" },
    });
    resumes.length = 0;

    await processRun(deps, { runId: run.id, organizationId: "o1" });
    assert.equal((await scope.runs.get(run.id))?.status, "waiting");
    assert.equal(resumes.length, 1);
    assert.equal(resumes[0]?.runId, run.id);
    const waiting = (await scope.runs.results(run.id)).find((r) => r.nodeId === "d");
    assert.equal(waiting?.status, "waiting");
    assert.equal(
      (await scope.runs.results(run.id)).some((r) => r.nodeId === "s"),
      false,
    );

    await new Promise((resolve) => setTimeout(resolve, 80));
    await processRun(deps, { runId: run.id, organizationId: "o1" });
    const done = await scope.runs.get(run.id);
    assert.equal(done?.status, "succeeded");
    const results = Object.fromEntries(
      (await scope.runs.results(run.id)).map((r) => [r.nodeId, r]),
    );
    assert.equal(results.d?.status, "succeeded");
    assert.equal(results.d?.attempt, 1);
    assert.deepEqual(results.s?.output, { who: "Ann", done: true });

    const types = (await readStream(redis, runStreamKey(run.id), "0", 50)).map((e) => e.event.type);
    assert.ok(types.includes("node.waiting"));
    assert.ok(types.includes("run.waiting"));
    assert.equal(types.at(-1), "run.finished");
  });

  it("a cancel ends the run as cancelled; a shutdown leaves it running; a finished run stays", async () => {
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "cancel" });
    const slowGraph = {
      schema: 1,
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "h",
          type: "http.request",
          name: "Slow",
          position: { x: 0, y: 0 },
          config: { method: "GET", url: "https://slow.example.com/" },
        },
      ],
      edges: [{ id: "e1", from: "t", fromPort: "out", to: "h", toPort: "in" }],
    };
    // The request hangs until the signal aborts.
    mock.method(globalThis, "fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const newRun = async () =>
      (
        await scope.runs.create({
          workflowId: wf.id,
          mode: "test",
          graphSnapshot: slowGraph,
          triggerType: "manual",
          triggerInput: {},
        })
      ).run;
    const waitForStart = async (runId: string) => {
      for (let i = 0; i < 100; i++) {
        if ((await scope.runs.get(runId))?.status === "running") return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("run did not start");
    };

    // Cancel: ends as cancelled, resolves without throwing, publishes run.finished.
    const cancelled = await newRun();
    const cancel = new AbortController();
    const shutdown = new AbortController();
    const running = processRun(
      deps,
      { runId: cancelled.id, organizationId: "o1" },
      shutdown.signal,
      cancel.signal,
    );
    await waitForStart(cancelled.id);
    cancel.abort();
    await running;
    const row = await scope.runs.get(cancelled.id);
    assert.equal(row?.status, "cancelled");
    assert.ok(row?.finishedAt);
    const events = await readStream(redis, runStreamKey(cancelled.id), "0", 50);
    const last = events.at(-1)?.event;
    assert.equal(last?.type, "run.finished");
    assert.equal(last?.type === "run.finished" ? last.status : undefined, "cancelled");

    // Shutdown: the run stays running so another worker resumes it.
    const interrupted = await newRun();
    const stop = new AbortController();
    const other = processRun(deps, { runId: interrupted.id, organizationId: "o1" }, stop.signal);
    await waitForStart(interrupted.id);
    stop.abort();
    await other;
    assert.equal((await scope.runs.get(interrupted.id))?.status, "running");

    // A run that ended before the cancel stays as it is.
    const done = await newRun();
    await scope.runs.start(done.id);
    await scope.runs.finish(done.id, { status: "succeeded" });
    const late = new AbortController();
    late.abort();
    await processRun(deps, { runId: done.id, organizationId: "o1" }, undefined, late.signal);
    assert.equal((await scope.runs.get(done.id))?.status, "succeeded");
  });

  it("switch sends the run down the matching case", async () => {
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "switch" });
    const n = (id: string, type: string, name: string, config: Record<string, unknown>) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
    });
    const g = {
      schema: 1,
      nodes: [
        n("t", "trigger.manual", "Start", {}),
        n("sw", "logic.switch", "Route", { value: "{{ $input.kind }}", cases: ["a", "b"] }),
        n("a", "data.set", "Is A", { fields: { picked: "a" } }),
        n("b", "data.set", "Is B", { fields: { picked: "b" } }),
        n("d", "data.set", "Other", { fields: { picked: "other" } }),
      ],
      edges: [
        { id: "e1", from: "t", fromPort: "out", to: "sw", toPort: "in" },
        { id: "e2", from: "sw", fromPort: "a", to: "a", toPort: "in" },
        { id: "e3", from: "sw", fromPort: "b", to: "b", toPort: "in" },
        { id: "e4", from: "sw", fromPort: "default", to: "d", toPort: "in" },
      ],
    };
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: { kind: "b" },
    });
    await processRun(deps, { runId: run.id, organizationId: "o1" });
    const status = Object.fromEntries(
      (await scope.runs.results(run.id)).map((r) => [r.nodeId, r.status]),
    );
    assert.deepEqual(status, {
      t: "succeeded",
      sw: "succeeded",
      a: "skipped",
      b: "succeeded",
      d: "skipped",
    });
  });

  it("a cron job makes one production run, and a repeated job makes none", async () => {
    const scope = forOrganization(handle.db, "o1");
    const wf = await scope.workflows.create({ name: "cron" });
    const g = {
      schema: 1,
      nodes: [
        {
          id: "c",
          type: "trigger.cron",
          name: "Every minute",
          position: { x: 0, y: 0 },
          config: { expression: "* * * * *", timezone: "UTC" },
        },
      ],
      edges: [],
    };
    await scope.workflows.publish(wf.id, {
      graph: g,
      triggerNodes: [{ id: "c", type: "trigger.cron", config: g.nodes[0]?.config ?? {} }],
      userId: null,
    });
    const [triggerRow] = await scope.workflows.triggers([wf.id]);
    assert.ok(triggerRow);
    const queued: string[] = [];
    const cronDeps = {
      db: handle.db,
      enqueueRun: async ({ runId }: { runId: string }) => {
        queued.push(runId);
      },
    };
    const data = {
      triggerId: triggerRow.id,
      workflowId: wf.id,
      organizationId: "o1",
      nodeId: "c",
      timezone: "UTC",
    };
    const job = {
      id: "repeat:abc:1000",
      timestamp: 1_700_000_000_000 - 30_000,
      opts: { delay: 30_000 },
    };

    await handleCronJob(cronDeps, data, job); // workflow is not active yet
    assert.equal(queued.length, 0);

    await scope.workflows.setActive(wf.id, true);
    await handleCronJob(cronDeps, data, job);
    await handleCronJob(cronDeps, data, job); // same job again
    assert.equal(queued.length, 1);
    const run = await scope.runs.get(queued[0] ?? "");
    assert.equal(run?.triggerType, "cron");
    assert.deepEqual(run?.triggerInput, {
      scheduledAt: "2023-11-14T22:13:20.000Z",
      timezone: "UTC",
    });
  });

  it("uses a credential and variables, and keeps the secret out of stored errors", async () => {
    const scope = forOrganization(handle.db, "o1", { secretKey });
    await scope.variables.create(
      { key: "baseUrl", type: "string", value: "https://api.example.com", description: "" },
      null,
    );
    const credential = await scope.credentials.create({
      name: "Prod token",
      type: "http.bearer",
      data: { token: "tok-very-secret-123" },
    });
    const wf = await scope.workflows.create({ name: "cred" });
    const n = (
      id: string,
      type: string,
      name: string,
      config: Record<string, unknown>,
      credentialId?: string,
    ) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
      credentialId: credentialId ?? null,
    });
    const g = {
      schema: 1,
      nodes: [
        n("t", "trigger.manual", "Start", {}),
        n(
          "h",
          "http.request",
          "Call",
          { method: "GET", url: "{{ $vars.baseUrl }}/me" },
          credential.id,
        ),
      ],
      edges: [{ id: "e", from: "t", fromPort: "out", to: "h", toPort: "in" }],
    };

    const calls: { url: string; auth: string | null }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), auth: (init.headers as Headers).get("authorization") });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    });
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: {},
    });
    await processRun(deps, { runId: run.id, organizationId: "o1" });
    assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
    assert.deepEqual(calls, [
      { url: "https://api.example.com/me", auth: "Bearer tok-very-secret-123" },
    ]);

    // A failure that repeats the token is stored without it.
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => {
      throw new Error("connect failed for Bearer tok-very-secret-123");
    });
    const failed = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: {},
    });
    await processRun(deps, { runId: failed.run.id, organizationId: "o1" });
    const stored = JSON.stringify([
      await scope.runs.get(failed.run.id),
      await scope.runs.results(failed.run.id),
    ]);
    assert.equal(stored.includes("tok-very-secret-123"), false);
    assert.ok(stored.includes("Bearer ***"));

    // A variable that does not exist fails the node with a clear message.
    await scope.variables.remove("baseUrl");
    mock.restoreAll();
    const missing = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: {},
    });
    await processRun(deps, { runId: missing.run.id, organizationId: "o1" });
    assert.match(
      JSON.stringify((await scope.runs.get(missing.run.id))?.error),
      /Variable \\"baseUrl\\" does not exist/,
    );
  });

  it("runs a code node through the sandbox with a plain scope", async () => {
    const scope = forOrganization(handle.db, "o1", { secretKey });
    await scope.variables.create({ key: "limit", type: "number", value: 3, description: "" }, null);
    const wf = await scope.workflows.create({ name: "code" });
    const g = {
      schema: 1,
      nodes: [
        { id: "t", type: "trigger.manual", name: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "c",
          type: "code.js",
          name: "Compute",
          position: { x: 0, y: 0 },
          // {{ }} stays as text in code.
          config: {
            code: "return { v: $vars.limit + 1 }; // {{ not an expression }}",
            timeoutMs: 1000,
          },
        },
      ],
      edges: [{ id: "e", from: "t", fromPort: "out", to: "c", toPort: "in" }],
    };
    const requests: { code: string; scope: Record<string, unknown> }[] = [];
    const sandbox = {
      run: async (request: { code: string; scope: Record<string, unknown> }) => {
        requests.push(request);
        return { v: 4 };
      },
    };
    const { run } = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: { who: "Ann" },
    });
    await processRun({ ...deps, sandbox }, { runId: run.id, organizationId: "o1" });
    assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.code, "return { v: $vars.limit + 1 }; // {{ not an expression }}");
    assert.deepEqual(Object.keys(requests[0]?.scope ?? {}).sort(), [
      "$input",
      "$node",
      "$resumeUrl",
      "$run",
      "$trigger",
      "$vars",
    ]);
    assert.deepEqual(requests[0]?.scope.$vars, { limit: 3 });
    const result = (await scope.runs.results(run.id)).find((r) => r.nodeId === "c");
    assert.deepEqual(result?.output, { v: 4 });

    // Without a sandbox the node fails with a clear message.
    const second = await scope.runs.create({
      workflowId: wf.id,
      mode: "test",
      graphSnapshot: g,
      triggerType: "manual",
      triggerInput: {},
    });
    await processRun(deps, { runId: second.run.id, organizationId: "o1" });
    assert.match(JSON.stringify((await scope.runs.get(second.run.id))?.error), /no SANDBOX_URL/);
  });
  it("lets table nodes read and write data tables, and marks the rows with the run", async () => {
    const scope = forOrganization(handle.db, "o1");
    const table = await scope.tables.create({
      name: "visits",
      columns: [
        { key: "path", type: "string", unique: true },
        { key: "hits", type: "number", default: 0 },
      ],
    });
    const wf = await scope.workflows.create({ name: "tables" });
    const node = (id: string, type: string, name: string, config: Record<string, unknown>) => ({
      id,
      type,
      name,
      position: { x: 0, y: 0 },
      config,
    });
    const g = {
      schema: 1,
      nodes: [
        node("t", "trigger.manual", "Start", {}),
        node("u", "table.upsert", "Count", {
          table: table.id,
          column: "path",
          row: { path: "{{ $trigger.path }}" },
          increment: { hits: 1 },
        }),
        node("q", "table.query", "List", {
          table: table.name,
          filter: { field: "path", op: "eq", value: "{{ $trigger.path }}" },
        }),
      ],
      edges: [
        { id: "e1", from: "t", fromPort: "out", to: "u", toPort: "in" },
        { id: "e2", from: "u", fromPort: "out", to: "q", toPort: "in" },
      ],
    };
    const runOnce = async () => {
      const { run } = await scope.runs.create({
        workflowId: wf.id,
        mode: "test",
        graphSnapshot: g,
        triggerType: "manual",
        triggerInput: { path: "/home" },
      });
      await processRun(deps, { runId: run.id, organizationId: "o1" });
      return run.id;
    };
    const first = await runOnce();
    const second = await runOnce();
    const rows = (await scope.tables.queryRows(table.id, {})).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.hits, 2);
    const done = await scope.runs.get(second);
    assert.equal(done?.status, "succeeded");
    const results = await scope.runs.results(second);
    const listed = results.find((r) => r.nodeId === "q")?.output as { count: number };
    assert.equal(listed.count, 1);
    const created = results.find((r) => r.nodeId === "u")?.output as { created: boolean };
    assert.equal(created.created, false);
    assert.equal((await scope.runs.get(first))?.status, "succeeded");
  });

  it("runs a sub-workflow and returns its last node output; fails on an unpublished child", async () => {
    const scope = forOrganization(handle.db, "o1");
    const node = (id: string, type: string, config: Record<string, unknown>) => ({
      id,
      type,
      name: id,
      position: { x: 0, y: 0 },
      config,
    });
    const child = await scope.workflows.create({ name: "child" });
    const childVersion = await scope.workflows.publish(child.id, {
      graph: {
        schema: 1,
        nodes: [
          node("t", "trigger.manual", {}),
          node("s", "data.set", { fields: { doubled: "{{ $input.n * 2 }}" } }),
        ],
        edges: [{ id: "e", from: "t", fromPort: "out", to: "s", toPort: "in" }],
      },
      triggerNodes: [{ id: "t", type: "trigger.manual", config: {} }],
      userId: null,
    });
    assert.ok(childVersion);
    const draft = await scope.workflows.create({ name: "draft" });

    const start = async (workflowId: string, nodes: ReturnType<typeof node>[]) => {
      const parent = await scope.workflows.create({ name: "parent" });
      const v = await scope.workflows.publish(parent.id, {
        graph: {
          schema: 1,
          nodes: [node("t", "trigger.manual", {}), ...nodes],
          edges: [{ id: "e", from: "t", fromPort: "out", to: nodes[0]?.id ?? "", toPort: "in" }],
        },
        triggerNodes: [{ id: "t", type: "trigger.manual", config: {} }],
        userId: null,
      });
      const { run } = await scope.runs.create({
        workflowId: parent.id,
        mode: "production",
        versionId: v?.id,
        triggerType: "manual",
        triggerNodeId: "t",
        triggerInput: { n: 21 },
      });
      await processRun(deps, { runId: run.id, organizationId: "o1" });
      return { run: await scope.runs.get(run.id), parentId: parent.id, workflowId };
    };

    const ok = await start(child.id, [
      node("x", "flow.execute_workflow", { workflowId: child.id }),
    ]);
    assert.equal(ok.run?.status, "succeeded");
    const results = await scope.runs.results(ok.run?.id ?? "");
    const out = results.find((r) => r.nodeId === "x")?.output as { doubled?: number };
    assert.equal(out.doubled, 42);

    const inline = await start(child.id, [
      node("x", "flow.execute_workflow", {
        source: "parameter",
        workflowJson: JSON.stringify({
          schema: 1,
          nodes: [
            node("t", "trigger.manual", {}),
            node("s", "data.set", { fields: { tripled: "{{ $input.n * 3 }}" } }),
          ],
          edges: [{ id: "e", from: "t", fromPort: "out", to: "s", toPort: "in" }],
        }),
      }),
    ]);
    const tripled = (await scope.runs.results(inline.run?.id ?? "")).find((r) => r.nodeId === "x");
    assert.equal((tripled?.output as { tripled?: number } | undefined)?.tripled, 63);

    const each = await start(child.id, [
      node("x", "flow.execute_workflow", { workflowId: child.id, mode: "each" }),
    ]);
    assert.equal(each.run?.status, "succeeded");

    const noWait = await start(child.id, [
      node("x", "flow.execute_workflow", { workflowId: child.id, waitForCompletion: false }),
    ]);
    const started = (await scope.runs.results(noWait.run?.id ?? "")).find((r) => r.nodeId === "x");
    assert.ok((started?.output as { runId?: string } | undefined)?.runId);

    const missing = await start(draft.id, [
      node("x", "flow.execute_workflow", { workflowId: draft.id }),
    ]);
    assert.equal(missing.run?.status, "failed");
    assert.match(JSON.stringify(missing.run?.error), /not published/);
  });
  describe("node data storage", () => {
    const publishSlice = async (scope: ReturnType<typeof forOrganization>, name: string) => {
      const wf = await scope.workflows.create({ name });
      const version = await scope.workflows.publish(wf.id, {
        graph,
        triggerNodes: [{ id: "t", type: "trigger.webhook", config: {} }],
        userId: null,
      });
      const { run } = await scope.runs.create({
        workflowId: wf.id,
        mode: "production",
        versionId: version?.id,
        triggerType: "webhook",
        triggerNodeId: "t",
        triggerInput: { body: { id: 7 } },
      });
      return run;
    };
    const reply = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

    it("writes no running row, only the result when a node ends", async () => {
      const scope = forOrganization(handle.db, "o1");
      const run = await publishSlice(scope, "no running row");
      const seen: string[][] = [];
      mock.method(globalThis, "fetch", async () => {
        seen.push((await scope.runs.results(run.id)).map((r) => `${r.nodeId}:${r.status}`));
        return reply(200, { name: "Ann" });
      });
      await processRun(deps, { runId: run.id, organizationId: "o1" });
      mock.restoreAll();
      // While the node "a" ran, the trigger had its result and "a" had no row yet.
      assert.deepEqual(seen[0], ["t:succeeded"]);
      assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
    });

    it("keeps no data of succeeded nodes when asked, except the last result", async () => {
      const scope = forOrganization(handle.db, "o1");
      const run = await publishSlice(scope, "skip success data");
      mock.method(globalThis, "fetch", async () => reply(200, { name: "Ann" }));
      await processRun(
        { ...deps, saveSuccessNodeData: false },
        { runId: run.id, organizationId: "o1" },
      );
      mock.restoreAll();
      const results = Object.fromEntries(
        (await scope.runs.results(run.id)).map((r) => [r.nodeId, r]),
      );
      assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
      for (const id of ["t", "a", "i"]) {
        assert.equal(results[id]?.status, "succeeded");
        assert.equal(results[id]?.input, null);
        assert.deepEqual(results[id]?.output, { $omitted: true });
        assert.ok(results[id]?.finishedAt);
      }
      assert.equal(results.i?.port, "true");
      // The last node keeps its output: it is the answer of the run.
      assert.equal(results.yes?.status, "succeeded");
      assert.equal((results.yes?.output as { name?: string } | null)?.name, "Ann");
      assert.notDeepEqual(results.yes?.output, { $omitted: true });
      assert.equal(results.no?.status, "skipped");
    });

    it("keeps the data of succeeded nodes when the run fails, so a retry can go on", async () => {
      const scope = forOrganization(handle.db, "o1");
      const run = await publishSlice(scope, "skip success data, failed");
      let calls = 0;
      mock.method(globalThis, "fetch", async () => {
        calls += 1;
        return calls === 1 ? reply(200, { name: "Ann" }) : reply(500, { error: "down" });
      });
      await processRun(
        { ...deps, saveSuccessNodeData: false },
        { runId: run.id, organizationId: "o1" },
      );
      mock.restoreAll();
      assert.equal((await scope.runs.get(run.id))?.status, "failed");
      const results = Object.fromEntries(
        (await scope.runs.results(run.id)).map((r) => [r.nodeId, r]),
      );
      assert.equal(results.t?.status, "succeeded");
      assert.notDeepEqual(results.t?.output, { $omitted: true });
      assert.equal((results.a?.output as { status?: number } | null)?.status, 200);
      assert.deepEqual(results.t?.input, { body: { id: 7 } });
    });

    it("runs a node again on resume when its data was not saved", async () => {
      const scope = forOrganization(handle.db, "o1");
      const run = await publishSlice(scope, "omitted resume");
      // A crashed pass: the trigger and the fetch node ended, their data was not saved.
      for (const nodeId of ["t", "a"]) {
        await scope.runs.saveNodeResult(run.id, {
          nodeId,
          attempt: 1,
          status: "succeeded",
          port: "out",
          output: { $omitted: true },
        });
      }
      const urls: string[] = [];
      mock.method(globalThis, "fetch", async (url: string) => {
        urls.push(String(url));
        return reply(200, { name: "Ann" });
      });
      await processRun(deps, { runId: run.id, organizationId: "o1" });
      mock.restoreAll();
      assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
      assert.equal(urls[0], "https://api.example.com/users/7");
    });

    it("stores large output as a blob, and reads it back", async () => {
      const blobs = { store: memoryBlobStore(), inlineBytes: 200 };
      const scope = forOrganization(handle.db, "o1", { blobs });
      const run = await publishSlice(scope, "blob output");
      const pad = "x".repeat(2000);
      mock.method(globalThis, "fetch", async () => reply(200, { name: "Ann", pad }));
      await processRun({ ...deps, blobs }, { runId: run.id, organizationId: "o1" });
      mock.restoreAll();
      assert.equal((await scope.runs.get(run.id))?.status, "succeeded");

      const raw = await forOrganization(handle.db, "o1", { blobs: null }).runs.results(run.id);
      const fetched = raw.find((r) => r.nodeId === "a");
      assert.equal(fetched?.output, null);
      assert.ok(fetched?.outputRef);
      const read = (await scope.runs.results(run.id)).find((r) => r.nodeId === "a");
      assert.equal((read?.output as { body?: { pad?: string } } | null)?.body?.pad, pad);

      // Purge: the blobs go with the run.
      await scope.runs.clearData(run.id);
      assert.deepEqual(await blobs.store.listRunIds(), []);
    });

    it("resumes a run with binary data from the blob store", async () => {
      const blobs = { store: memoryBlobStore(), inlineBytes: 100_000 };
      const scope = forOrganization(handle.db, "o1", { blobs });
      const wf = await scope.workflows.create({ name: "blob resume" });
      const flow = {
        schema: 1,
        nodes: [
          { id: "t", type: "trigger.manual", name: "T", position: { x: 0, y: 0 }, config: {} },
          {
            id: "s",
            type: "data.set",
            name: "S",
            position: { x: 0, y: 0 },
            config: { fields: { copy: "{{ $input.binary.doc.data }}" } },
          },
        ],
        edges: [{ id: "e", from: "t", fromPort: "out", to: "s", toPort: "in" }],
      };
      const version = await scope.workflows.publish(wf.id, {
        graph: flow,
        triggerNodes: [{ id: "t", type: "trigger.manual", config: {} }],
        userId: null,
      });
      const { run } = await scope.runs.create({
        workflowId: wf.id,
        mode: "production",
        versionId: version?.id,
        triggerType: "manual",
        triggerNodeId: "t",
        triggerInput: {},
      });
      // The trigger ended before the crash. Its output has a file, stored as a blob.
      const data = Buffer.from("file bytes").toString("base64");
      await scope.runs.saveNodeResult(run.id, {
        nodeId: "t",
        attempt: 1,
        status: "succeeded",
        port: "out",
        output: { binary: { doc: { data, mimeType: "text/plain" } } },
      });
      const raw = await forOrganization(handle.db, "o1", { blobs: null }).runs.results(run.id);
      assert.equal(JSON.stringify(raw[0]?.output).includes(data), false);

      await processRun({ ...deps, blobs }, { runId: run.id, organizationId: "o1" });
      assert.equal((await scope.runs.get(run.id))?.status, "succeeded");
      const set = (await scope.runs.results(run.id)).find((r) => r.nodeId === "s");
      assert.equal((set?.output as { copy?: string } | null)?.copy, data);
    });
  });
});
