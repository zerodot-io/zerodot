// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExecutionHooks,
  executeGraph,
  type Graph,
  type NodeEndEvent,
  type StoredNodeResult,
} from "@zerodot/engine";
import { registry } from "./index";
import { waitCallbackData } from "./wait-callback";

const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  config,
  credentialId: null,
  pinned: null,
  onError: "fail" as const,
});
const edge = (from: string, to: string) => ({
  id: `${from}-${to}`,
  from,
  fromPort: "out",
  to,
  toPort: "in",
});

const graph = (waitConfig: Record<string, unknown>): Graph => ({
  schema: 1,
  nodes: [
    node("t", "trigger.manual"),
    node("link", "data.set", { fields: { url: '{{ $resumeUrl["wait"] }}' }, keepInput: false }),
    node("wait", "flow.delay", waitConfig),
    node("done", "data.set", { fields: { got: "{{ $input.body.ok }}" }, keepInput: false }),
  ],
  edges: [edge("t", "link"), edge("link", "wait"), edge("wait", "done")],
});

async function run(
  g: Graph,
  extra: Partial<Parameters<typeof executeGraph>[0]> = {},
): Promise<{ result: Awaited<ReturnType<typeof executeGraph>>; events: NodeEndEvent[] }> {
  const events: NodeEndEvent[] = [];
  const hook: ExecutionHooks = { afterNode: (e) => void events.push(e) };
  const result = await executeGraph({
    graph: g,
    registry,
    triggerInput: {},
    mode: "production",
    signal: new AbortController().signal,
    hooks: [hook],
    resumeUrl: (id) => `https://p.io/resume/r1/${id}?sig=abc`,
    sleep: async () => {},
    ...extra,
  });
  return { result, events };
}

const before = (waitData: unknown, resumeAt: number): StoredNodeResult[] => [
  { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: {} },
  { nodeId: "link", attempt: 1, status: "succeeded", port: "out", output: { url: "u" } },
  {
    nodeId: "wait",
    attempt: 1,
    status: "waiting",
    port: "out",
    output: { resumeAt, data: waitData },
  },
];

describe("Wait for webhook call", () => {
  const webhook = { mode: "webhook", timeoutAmount: 2, timeoutUnit: "hours" };

  it("stops the run and gives the resume URL to the earlier node", async () => {
    const start = Date.now();
    const { result, events } = await run(graph(webhook));
    assert.equal(result.status, "waiting");
    assert.deepEqual(events.find((e) => e.node.id === "link")?.output, {
      url: "https://p.io/resume/r1/wait?sig=abc",
    });
    const waiting = events.find((e) => e.node.id === "wait");
    assert.equal(waiting?.status, "waiting");
    const stored = waiting?.output as { resumeAt: number; data: unknown };
    assert.deepEqual(stored.data, { timedOut: true });
    assert.ok(stored.resumeAt >= start + 7_200_000 && stored.resumeAt <= Date.now() + 7_200_000);
  });

  it("uses the call as the output when the run goes on", async () => {
    const call = { method: "POST", headers: {}, query: {}, body: { ok: "yes" } };
    const { result, events } = await run(graph(webhook), {
      previousResults: before(call, Date.now()),
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(events.find((e) => e.node.id === "wait")?.output, call);
    assert.deepEqual(events.find((e) => e.node.id === "done")?.output, { got: "yes" });
  });

  it("goes on with timedOut when nothing calls", async () => {
    const { events } = await run(graph(webhook), {
      previousResults: before({ timedOut: true }, Date.now() - 1),
    });
    assert.deepEqual(events.find((e) => e.node.id === "wait")?.output, { timedOut: true });
  });

  it("waits 30 days when no timeout is set", async () => {
    const { events } = await run(graph({ mode: "webhook" }));
    const stored = events.find((e) => e.node.id === "wait")?.output as { resumeAt: number };
    assert.ok(stored.resumeAt > Date.now() + 29 * 86_400_000);
  });

  it("fails when the worker has no public address", async () => {
    const { result } = await run(graph(webhook), { resumeUrl: undefined });
    assert.equal(result.status, "failed");
  });

  it("has no resume URL for a node in time mode", async () => {
    const { result } = await run(graph({ mode: "time", amount: 1, unit: "minutes" }));
    assert.equal(result.status, "failed");
  });

  it("limits the timeout to 30 days", () => {
    const config = registry.get("flow.delay")?.config;
    const tooLong = { mode: "webhook", timeoutAmount: 31, timeoutUnit: "days" };
    assert.equal(config?.safeParse(tooLong).success, false);
    assert.equal(config?.safeParse({ mode: "webhook" }).success, true);
    // A config from before the mode existed still works.
    assert.equal(config?.safeParse({ amount: 1, unit: "minutes" }).success, true);
  });
});

describe("waitCallbackData", () => {
  it("keeps the method, headers, query, and body, and drops the signature", () => {
    const data = waitCallbackData({
      method: "PUT",
      headers: new Headers({ "x-a": "1" }),
      url: new URL("https://p.io/resume/r/n?sig=secret&a=b"),
      body: { k: 1 },
    });
    assert.deepEqual(data, {
      method: "PUT",
      headers: { "x-a": "1" },
      query: { a: "b" },
      body: { k: 1 },
    });
  });
});
