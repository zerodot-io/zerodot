// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeGraph, type NodeEndEvent } from "./execute";
import type { Graph } from "./graph";
import { createRegistry, defineNode } from "./node";

const trigger = defineNode({
  type: "trigger.test",
  label: "Trigger",
  category: "trigger",
  icon: "Circle",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});

const branch = defineNode({
  type: "logic.branch",
  label: "Branch",
  category: "logic",
  icon: "Circle",
  config: z.object({ condition: z.unknown() }),
  defaultConfig: { condition: true },
  ports: { in: ["in"], out: ["true", "false"] },
  run: ({ config }) => ({ port: config.condition ? "true" : "false", data: {} }),
});

let flakyCalls = 0;
const flaky = defineNode({
  type: "test.flaky",
  label: "Flaky",
  category: "core",
  icon: "Circle",
  config: z.object({ failTimes: z.number() }),
  defaultConfig: { failTimes: 1 },
  ports: { in: ["in"], out: ["out"] },
  run: ({ config }) => {
    flakyCalls++;
    if (flakyCalls <= config.failTimes) throw new Error("boom");
    return { port: "out", data: { calls: flakyCalls } };
  },
});

const logger = defineNode({
  type: "test.logger",
  label: "Logger",
  category: "core",
  icon: "Circle",
  config: z.object({ fail: z.boolean() }),
  defaultConfig: { fail: false },
  ports: { in: ["in"], out: ["out"] },
  run: ({ config, log }) => {
    log?.([{ level: "log", message: "hello" }]);
    if (config.fail) throw new Error("boom");
    return { port: "out", data: {} };
  },
});

const echo = defineNode({
  type: "test.echo",
  label: "Echo",
  category: "core",
  icon: "Circle",
  config: z.object({ value: z.unknown() }),
  defaultConfig: { value: null },
  ports: { in: ["in"], out: ["out"] },
  run: ({ config }) => ({ port: "out", data: config.value }),
});

const waiter = defineNode({
  type: "test.wait",
  label: "Wait",
  category: "flow",
  icon: "Circle",
  config: z.object({ ms: z.number() }),
  defaultConfig: { ms: 10 },
  ports: { in: ["in"], out: ["out"] },
  run: ({ config, input }) => ({ port: "out", data: input, waitUntil: Date.now() + config.ms }),
});

const multi = defineNode({
  type: "test.multi",
  label: "Multi",
  category: "logic",
  icon: "Circle",
  config: z.object({ cases: z.array(z.string()) }),
  defaultConfig: { cases: ["a", "b"] },
  ports: { in: ["in"], out: ["default"] },
  outPorts: (config) => [...((config.cases as string[]) ?? []), "default"],
  run: ({ config }) => ({ port: config.cases[1] ?? "default", data: "picked" }),
});

const keyed = defineNode({
  type: "test.keyed",
  label: "Keyed",
  category: "core",
  icon: "Circle",
  config: z.object({}),
  defaultConfig: {},
  credentialTypes: ["test.token"],
  ports: { in: ["in"], out: ["out"] },
  run: ({ credential }) => {
    if (credential?.data.token === "super-secret-token") {
      throw new Error("The server said no to Bearer super-secret-token");
    }
    return { port: "out", data: credential?.data ?? null };
  },
});

const raw = defineNode({
  type: "test.raw",
  label: "Raw",
  category: "code",
  icon: "Circle",
  config: z.object({ code: z.string(), note: z.string() }),
  defaultConfig: { code: "", note: "" },
  rawConfigKeys: ["code"],
  ports: { in: ["in"], out: ["out"] },
  run: ({ config, scope, sandbox }) => ({
    port: "out",
    data: {
      code: config.code,
      note: config.note,
      scopeKeys: Object.keys(scope).sort(),
      hasSandbox: sandbox !== null,
    },
  }),
});

// Like the branch node, but the data goes on.
const keep = defineNode({
  type: "test.keep",
  label: "Keep",
  category: "logic",
  icon: "Circle",
  config: z.object({ condition: z.unknown() }),
  defaultConfig: { condition: true },
  ports: { in: ["in"], out: ["true", "false"] },
  run: ({ config, input }) => ({ port: config.condition ? "true" : "false", data: input }),
});

const registry = createRegistry([
  trigger,
  branch,
  keep,
  flaky,
  logger,
  echo,
  waiter,
  multi,
  keyed,
  raw,
]);

function node(id: string, type: string, config: Record<string, unknown> = {}) {
  return {
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    config,
    credentialId: null,
    pinned: null,
    onError: "fail" as const,
  };
}
function edge(from: string, to: string, fromPort = "out") {
  return { id: `${from}-${to}`, from, fromPort, to, toPort: "in" };
}

function run(graph: Graph, extra: Partial<Parameters<typeof executeGraph>[0]> = {}) {
  const events: NodeEndEvent[] = [];
  const result = executeGraph({
    graph,
    registry,
    triggerInput: { n: 5 },
    mode: "production",
    signal: new AbortController().signal,
    hooks: [{ afterNode: (e) => void events.push(e) }],
    sleep: async () => {},
    ...extra,
  });
  return { result, events };
}

describe("executeGraph", () => {
  it("starts a workflow with no trigger at a named root node", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("a", "test.echo", { value: "x" }), node("b", "test.echo", { value: "y" })],
      edges: [edge("a", "b")],
    };
    assert.equal((await run(graph).result).status, "failed");
    assert.equal((await run(graph, { startNodeId: "b" }).result).status, "failed");
    const { result, events } = run(graph, { startNodeId: "a" });
    assert.equal((await result).status, "succeeded");
    assert.equal(events.find((e) => e.node.id === "b")?.status, "succeeded");
  });

  it("follows the selected port and skips the other branch", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("b", "logic.branch", { condition: "{{ $trigger.n > 3 }}" }),
        node("yes", "test.echo", { value: "{{ $node['t'].data.n }}" }),
        node("no", "test.echo", { value: "no" }),
      ],
      edges: [edge("t", "b"), edge("b", "yes", "true"), edge("b", "no", "false")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    const byId = Object.fromEntries(events.map((e) => [e.node.id, e]));
    assert.equal(byId.yes?.status, "succeeded");
    assert.equal(byId.yes?.output, 5);
    assert.equal(byId.no?.status, "skipped");
  });

  it("retries a node", async () => {
    flakyCalls = 0;
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("f", "test.flaky", { failTimes: 1 }), retry: { max: 2, backoffMs: 0 } },
      ],
      edges: [edge("t", "f")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.filter((e) => e.node.id === "f").map((e) => [e.attempt, e.status]),
      [
        [1, "failed"],
        [2, "succeeded"],
      ],
    );
  });

  it("fails the run on a node error and reports the node", async () => {
    flakyCalls = 0;
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), node("f", "test.flaky", { failTimes: 9 })],
      edges: [edge("t", "f")],
    };
    const { result } = run(graph);
    assert.deepEqual(await result, { status: "failed", error: { message: "boom", nodeId: "f" } });
  });

  it("continues when onError is continue", async () => {
    flakyCalls = 0;
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("f", "test.flaky", { failTimes: 9 }), onError: "continue" },
        node("e", "test.echo", { value: "{{ $input.error.message }}" }),
      ],
      edges: [edge("t", "f"), edge("f", "e")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    assert.equal(events.find((e) => e.node.id === "e")?.output, "boom");
  });

  it("uses pinned data in test mode only", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("e", "test.echo", { value: "real" }), pinned: { port: "out", data: "pinned" } },
      ],
      edges: [edge("t", "e")],
    };
    const test = run(graph, { mode: "test" });
    await test.result;
    assert.equal(test.events.find((e) => e.node.id === "e")?.output, "pinned");
    const prod = run(graph);
    await prod.result;
    assert.equal(prod.events.find((e) => e.node.id === "e")?.output, "real");
  });

  it("runs to a node and stops after it", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("a", "test.echo", { value: "a" }),
        node("b", "test.echo", { value: "b" }),
        node("c", "test.echo", { value: "c" }),
      ],
      edges: [edge("t", "a"), edge("a", "b"), edge("b", "c")],
    };
    const { result, events } = run(graph, {
      mode: "test",
      target: { kind: "to", nodeId: "b" },
    });
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.map((e) => e.node.id),
      ["t", "a", "b"],
    );
  });

  it("run to node does not touch other branches", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("i", "logic.branch", { condition: true }),
        node("yes", "test.echo", { value: "yes" }),
        node("no", "test.echo", { value: "no" }),
      ],
      edges: [edge("t", "i"), edge("i", "yes", "true"), edge("i", "no", "false")],
    };
    const { result, events } = run(graph, {
      mode: "test",
      target: { kind: "to", nodeId: "yes" },
    });
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.map((e) => e.node.id),
      ["t", "i", "yes"],
    );
  });

  it("runs one node with the given input and ignores its pin", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("a", "test.echo", { value: "{{ $input.x }}-{{ $node['t'].data.y }}" }),
        {
          ...node("b", "test.echo", { value: "{{ $input.x }}" }),
          pinned: { port: "out", data: 1 },
        },
      ],
      edges: [edge("t", "a"), edge("a", "b")],
    };
    const { result, events } = run(graph, {
      mode: "test",
      target: {
        kind: "only",
        nodeId: "a",
        input: { x: 7 },
        outputs: { t: { port: "out", data: { y: 9 } } },
      },
    });
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.map((e) => [e.node.id, e.output]),
      [["a", "7-9"]],
    );
    const pinned = run(graph, {
      mode: "test",
      target: { kind: "only", nodeId: "b", input: { x: 5 }, outputs: {} },
    });
    await pinned.result;
    assert.deepEqual(
      pinned.events.map((e) => [e.node.id, e.output, e.pinned]),
      [["b", 5, false]],
    );
  });

  it("resumes: skips succeeded nodes", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), node("e", "test.echo", { value: "x" })],
      edges: [edge("t", "e")],
    };
    const { result, events } = run(graph, {
      previousResults: [
        { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: { n: 5 } },
      ],
    });
    await result;
    assert.deepEqual(
      events.map((e) => e.node.id),
      ["e"],
    );
  });

  it("retries from the failed node: the saved results of earlier nodes are reused", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("e", "test.echo", { value: "{{ $input.n }}" }),
        node("f", "test.flaky", { failTimes: 1 }),
        node("after", "test.echo", { value: "done" }),
      ],
      edges: [edge("t", "e"), edge("e", "f"), edge("f", "after")],
    };
    flakyCalls = 0;
    const first = run(graph);
    const failed = await first.result;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.nodeId, "f");
    // The retry run copies the succeeded results only. The failed result is not copied.
    const copied = first.events
      .filter((e) => e.status === "succeeded")
      .map((e) => ({
        nodeId: e.node.id,
        attempt: e.attempt,
        status: "succeeded" as const,
        port: e.port,
        output: e.output,
      }));
    assert.deepEqual(
      copied.map((c) => c.nodeId),
      ["t", "e"],
    );
    const callsBefore = flakyCalls;
    const retry = run(graph, { previousResults: copied });
    assert.equal((await retry.result).status, "succeeded");
    assert.deepEqual(
      retry.events.map((e) => [e.node.id, e.status, e.attempt]),
      [
        ["f", "succeeded", 1],
        ["after", "succeeded", 1],
      ],
    );
    assert.equal(flakyCalls, callsBefore + 1, "only the failed node runs again");
  });

  it("cancels on abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const graph: Graph = { schema: 1, nodes: [node("t", "trigger.test")], edges: [] };
    const { result } = run(graph, { signal: controller.signal });
    assert.equal((await result).status, "cancelled");
  });

  // t -> inc -> chk -true-> inc (a loop), chk -false-> done
  const loopGraph = (limit: string): Graph => ({
    schema: 1,
    nodes: [
      node("t", "trigger.test"),
      node("inc", "test.echo", { value: { n: "{{ $input.n + 1 }}" } }),
      node("chk", "test.keep", { condition: limit }),
      node("done", "test.echo", { value: "{{ $input.n }}" }),
    ],
    edges: [
      edge("t", "inc"),
      edge("inc", "chk"),
      edge("chk", "inc", "true"),
      edge("chk", "done", "false"),
    ],
  });

  it("runs a loop until the condition is false", async () => {
    const { result, events } = run(loopGraph("{{ $input.n < 3 }}"), { triggerInput: { n: 0 } });
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.filter((e) => e.node.id === "inc").map((e) => [e.attempt, e.output]),
      [
        [1, { n: 1 }],
        [2, { n: 2 }],
        [3, { n: 3 }],
      ],
    );
    // The false branch is skipped while the loop goes on. Then it runs once.
    const doneEvents = events.filter((e) => e.node.id === "done");
    assert.deepEqual(
      doneEvents.map((e) => [e.attempt, e.status]),
      [
        [1, "skipped"],
        [2, "succeeded"],
      ],
    );
    assert.equal(doneEvents.at(-1)?.output, 3);
  });

  it("stops a loop that does not end", async () => {
    const { result } = run(loopGraph("{{ true }}"), { triggerInput: { n: 0 }, maxNodeRuns: 20 });
    const outcome = await result;
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error?.message ?? "", /stopped after 20 node runs/);
  });

  it("runs a node that has two parents once for each", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("a", "test.echo", { value: "A" }),
        node("b", "test.echo", { value: "B" }),
        node("j", "test.echo", { value: "{{ $input }}" }),
      ],
      edges: [edge("t", "a"), edge("t", "b"), edge("a", "j"), edge("b", "j")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(
      events.filter((e) => e.node.id === "j").map((e) => [e.attempt, e.output]),
      [
        [1, "A"],
        [2, "B"],
      ],
    );
  });

  it("does not run a trigger from an edge", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), node("a", "test.echo")],
      edges: [edge("t", "a"), edge("a", "t")],
    };
    await assert.rejects(run(graph).result, /cannot have an incoming edge/);
  });

  it("replays the saved results of a loop when the run resumes", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("inc", "test.echo", { value: { n: "{{ $input.n + 1 }}" } }),
        node("w", "test.wait", { ms: 60_000 }),
        node("chk", "test.keep", { condition: "{{ $input.n < 2 }}" }),
        node("done", "test.echo", { value: "{{ $input.n }}" }),
      ],
      edges: [
        edge("t", "inc"),
        edge("inc", "w"),
        edge("w", "chk"),
        edge("chk", "inc", "true"),
        edge("chk", "done", "false"),
      ],
    };
    // The saved results of a first turn: the trigger and one pass through inc, then a finished wait.
    const resumed = run(graph, {
      triggerInput: { n: 0 },
      previousResults: [
        { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: { n: 0 } },
        { nodeId: "inc", attempt: 1, status: "succeeded", port: "out", output: { n: 1 } },
        {
          nodeId: "w",
          attempt: 1,
          status: "waiting",
          port: "out",
          output: { resumeAt: Date.now() - 1, data: { n: 1 } },
        },
      ],
    });
    // The loop goes round once more. The second wait is new, so the run waits again.
    assert.equal((await resumed.result).status, "waiting");
    assert.deepEqual(
      resumed.events.map((e) => [e.node.id, e.status, e.attempt]),
      [
        ["w", "succeeded", 1],
        ["chk", "succeeded", 1],
        ["done", "skipped", 1],
        ["inc", "succeeded", 2],
        ["w", "waiting", 2],
      ],
    );
  });

  it("stops at a wait and finishes the node when it resumes", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("w", "test.wait", { ms: 60_000 }),
        node("e", "test.echo", { value: "{{ $input.n }}" }),
      ],
      edges: [edge("t", "w"), edge("w", "e")],
    };
    const first = run(graph);
    const result = await first.result;
    assert.equal(result.status, "waiting");
    const waitEvent = first.events.find((e) => e.node.id === "w");
    assert.equal(waitEvent?.status, "waiting");
    assert.equal(
      first.events.some((e) => e.node.id === "e"),
      false,
    );

    // Resume after the time has passed: the wait node is done and the run goes on.
    const stored = waitEvent?.output as { resumeAt: number; data: unknown };
    const resumed = run(graph, {
      previousResults: [
        { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: { n: 5 } },
        {
          nodeId: "w",
          attempt: 1,
          status: "waiting",
          port: "out",
          output: { resumeAt: Date.now() - 1, data: stored.data },
        },
      ],
    });
    assert.equal((await resumed.result).status, "succeeded");
    assert.deepEqual(
      resumed.events.map((e) => [e.node.id, e.status, e.attempt]),
      [
        ["w", "succeeded", 1],
        ["e", "succeeded", 1],
      ],
    );
    assert.equal(resumed.events.find((e) => e.node.id === "e")?.output, 5);

    // Resume too early: wait again.
    const early = run(graph, {
      previousResults: [
        { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: { n: 5 } },
        {
          nodeId: "w",
          attempt: 1,
          status: "waiting",
          port: "out",
          output: { resumeAt: Date.now() + 60_000, data: {} },
        },
      ],
    });
    assert.equal((await early.result).status, "waiting");
  });

  it("uses output ports that depend on the config", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("m", "test.multi", { cases: ["a", "b"] }),
        node("ea", "test.echo", { value: "A" }),
        node("eb", "test.echo", { value: "B" }),
      ],
      edges: [edge("t", "m"), edge("m", "ea", "a"), edge("m", "eb", "b")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    const byId = Object.fromEntries(events.map((e) => [e.node.id, e.status]));
    assert.equal(byId.eb, "succeeded");
    assert.equal(byId.ea, "skipped");
  });

  it("gives the node its credential, and checks the type", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), { ...node("k", "test.keyed"), credentialId: "c1" }],
      edges: [edge("t", "k")],
    };
    const ok = run(graph, {
      credentials: async () => ({ type: "test.token", data: { token: "other" } }),
    });
    assert.equal((await ok.result).status, "succeeded");
    assert.deepEqual(ok.events.find((e) => e.node.id === "k")?.output, { token: "other" });

    const wrong = run(graph, {
      credentials: async () => ({ type: "http.basic", data: { username: "a" } }),
    });
    assert.match(
      String((await wrong.result).error?.message),
      /does not accept a credential of type/,
    );

    const missing = run(graph, { credentials: async () => null });
    assert.match(String((await missing.result).error?.message), /does not exist/);
  });

  it("picks the credential with an expression, by id or by name", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("k", "test.keyed"), credentialExpression: "{{ $trigger.account }}" },
      ],
      edges: [edge("t", "k")],
    };
    const asked: [string, string | undefined][] = [];
    const ok = run(graph, {
      triggerInput: { account: " Acme " },
      credentials: async (ref, by) => {
        asked.push([ref, by]);
        return { type: "test.token", data: { token: "acme-token" } };
      },
    });
    assert.equal((await ok.result).status, "succeeded");
    assert.deepEqual(asked, [["Acme", "idOrName"]]);
    assert.deepEqual(ok.events.find((e) => e.node.id === "k")?.output, { token: "acme-token" });

    const wrong = run(graph, {
      triggerInput: { account: "x" },
      credentials: async () => ({ type: "http.basic", data: { username: "a" } }),
    });
    assert.match(
      String((await wrong.result).error?.message),
      /does not accept a credential of type/,
    );

    const missing = run(graph, {
      triggerInput: { account: "nope" },
      credentials: async () => null,
    });
    assert.match(String((await missing.result).error?.message), /"nope" does not exist/);

    const empty = run(graph, { triggerInput: { account: "" }, credentials: async () => null });
    assert.match(String((await empty.result).error?.message), /must give the id or the name/);
  });

  it("removes secrets of a credential picked by expression from errors", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("k", "test.keyed"), credentialExpression: "{{ $trigger.account }}" },
      ],
      edges: [edge("t", "k")],
    };
    const { result } = run(graph, {
      triggerInput: { account: "a" },
      credentials: async () => ({ type: "test.token", data: { token: "super-secret-token" } }),
    });
    assert.equal((await result).error?.message, "The server said no to Bearer ***");
  });

  it("removes credential values from stored errors", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), { ...node("k", "test.keyed"), credentialId: "c1" }],
      edges: [edge("t", "k")],
    };
    const { result, events } = run(graph, {
      credentials: async () => ({ type: "test.token", data: { token: "super-secret-token" } }),
    });
    const outcome = await result;
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.message, "The server said no to Bearer ***");
    const failed = events.find((e) => e.node.id === "k");
    assert.equal(failed?.error?.message, "The server said no to Bearer ***");
  });

  describe("$credentials", () => {
    const opened = async (ref: string) =>
      ref === "Bot" ? { type: "test.token", data: { token: "123:abc-secret", user: "me" } } : null;
    const graphOf = (value: string): Graph => ({
      schema: 1,
      nodes: [node("t", "trigger.test"), node("e", "test.echo", { value })],
      edges: [edge("t", "e")],
    });

    it("puts a credential field in the config, and hides it in the output", async () => {
      const { result, events } = run(
        graphOf('https://x.test/bot{{ $credentials["Bot"].token }}/go'),
        {
          credentials: opened,
        },
      );
      assert.equal((await result).status, "succeeded");
      assert.equal(events.find((e) => e.node.id === "e")?.output, "https://x.test/bot***/go");
    });

    it("hides the percent-encoded secret", async () => {
      const { result, events } = run(graphOf('{{ $credentials["Bot"].token }}'), {
        credentials: async () => ({ type: "test.token", data: { token: "a b&c-secret" } }),
      });
      await result;
      assert.equal(events.find((e) => e.node.id === "e")?.output, "***");
    });

    it("fails for a credential or a field that does not exist", async () => {
      const missing = await run(graphOf('{{ $credentials["Nope"].token }}'), {
        credentials: opened,
      }).result;
      assert.match(String(missing.error?.message), /The credential "Nope" does not exist/);
      const field = await run(graphOf('{{ $credentials["Bot"].tokn }}'), { credentials: opened })
        .result;
      assert.match(String(field.error?.message), /does not exist/);
    });

    it("does not accept a name from an expression, or a bare $credentials", async () => {
      for (const value of ["{{ $credentials[$input.name].token }}", "{{ $credentials }}"]) {
        const outcome = await run(graphOf(value), { credentials: opened }).result;
        assert.match(String(outcome.error?.message), /Write a credential field as/);
      }
    });

    it("names the fields when a credential has no field", async () => {
      const outcome = await run(graphOf('{{ $credentials["Bot"] }}'), { credentials: opened })
        .result;
      assert.equal(
        outcome.error?.message,
        'Add a field to $credentials["Bot"]. Fields: token, user',
      );
    });

    it("does not give it to raw config or to the run scope", async () => {
      const graph: Graph = {
        schema: 1,
        nodes: [
          node("t", "trigger.test"),
          node("r", "test.raw", { code: '$credentials["Bot"].token', note: "" }),
        ],
        edges: [edge("t", "r")],
      };
      const { result, events } = run(graph, { credentials: opened });
      await result;
      const out = events.find((e) => e.node.id === "r")?.output as { scopeKeys: string[] };
      assert.ok(!out.scopeKeys.includes("$credentials"));
    });

    it("hides the secret in logs and in an error", async () => {
      const graph: Graph = {
        schema: 1,
        nodes: [
          node("t", "trigger.test"),
          node("k", "test.echo", { value: '{{ $credentials["Bot"].token }}{{ $input.nope.x }}' }),
        ],
        edges: [edge("t", "k")],
      };
      const outcome = await run(graph, { credentials: opened }).result;
      assert.ok(!String(outcome.error?.message).includes("123:abc-secret"));
    });
  });

  it("reads variables, and fails on a missing one", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.test"), node("e", "test.echo", { value: "{{ $vars.limit }}" })],
      edges: [edge("t", "e")],
    };
    const ok = run(graph, { variables: { limit: 5 } });
    await ok.result;
    assert.equal(ok.events.find((e) => e.node.id === "e")?.output, 5);
    const bad = run(graph, { variables: { limt: 5 } });
    const outcome = await bad.result;
    assert.match(
      String(outcome.error?.message),
      /Variable "limit" does not exist\. Did you mean: limt\?/,
    );
    assert.equal(bad.events.find((e) => e.node.id === "e")?.error?.path, "config.value");
  });

  it("leaves raw config keys alone and gives the node a plain scope and the sandbox", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("r", "test.raw", { code: "return {{ $input.n }};", note: "n={{ $input.n }}" }),
      ],
      edges: [edge("t", "r")],
    };
    const sandbox = { run: async () => null };
    const { result, events } = run(graph, { sandbox, variables: { v: 1 } });
    assert.equal((await result).status, "succeeded");
    assert.deepEqual(events.find((e) => e.node.id === "r")?.output, {
      code: "return {{ $input.n }};",
      note: "n=5",
      scopeKeys: ["$input", "$node", "$resumeUrl", "$run", "$trigger", "$vars"],
      hasSandbox: true,
    });
  });

  it("gives the logs of a node that succeeded and of a node that failed", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("ok", "test.logger", { fail: false }),
        { ...node("bad", "test.logger", { fail: true }), onError: "continue" as const },
      ],
      edges: [edge("t", "ok"), edge("ok", "bad")],
    };
    const { result, events } = run(graph);
    assert.equal((await result).status, "succeeded");
    const logs = [{ level: "log", message: "hello" }];
    assert.deepEqual(events.find((e) => e.node.id === "ok")?.logs, logs);
    const failed = events.find((e) => e.node.id === "bad");
    assert.equal(failed?.status, "failed");
    assert.deepEqual(failed?.logs, logs);
  });
});
