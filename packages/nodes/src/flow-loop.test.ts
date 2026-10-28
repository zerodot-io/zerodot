// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type ExecutionHooks,
  executeGraph,
  type Graph,
  type StoredNodeResult,
} from "@zerodot/engine";
import { registry } from "./index";

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
const edge = (from: string, fromPort: string, to: string, toPort = "in") => ({
  id: `${from}-${fromPort}-${to}-${toPort}`,
  from,
  fromPort,
  to,
  toPort,
});

type Event = { id: string; attempt: number; status: string; input: unknown; output: unknown };

async function run(graph: Graph, triggerInput: unknown, previousResults?: StoredNodeResult[]) {
  const events: Event[] = [];
  const hooks: ExecutionHooks = {
    afterNode: (e) => {
      events.push({
        id: e.node.id,
        attempt: e.attempt,
        status: e.status,
        input: e.input,
        output: e.output,
      });
    },
  };
  const result = await executeGraph({
    graph,
    registry,
    triggerInput,
    mode: "production",
    signal: new AbortController().signal,
    hooks: [hooks],
    previousResults,
  });
  return { result, events };
}

/** trigger -> loop; loop.loop -> greet -> loop.next; loop.done -> finish. */
const loopGraph = (loopConfig: Record<string, unknown>, extra: Graph["nodes"] = []): Graph => ({
  schema: 1,
  nodes: [
    node("t", "trigger.manual"),
    node("loop", "flow.loop", loopConfig),
    node("greet", "data.set", {
      fields: { greeting: "hi {{ $input.item.name }}" },
      keepInput: false,
    }),
    node("finish", "data.set", { fields: { count: "{{ $input.length }}" }, keepInput: true }),
    ...extra,
  ],
  edges: [
    edge("t", "out", "loop"),
    edge("loop", "loop", "greet"),
    edge("greet", "out", "loop"),
    edge("loop", "done", "finish"),
  ],
});

const users = [{ name: "ann" }, { name: "bob" }, { name: "cy" }];

describe("flow.loop", () => {
  it("runs the loop once for each item, then sends all results on done", async () => {
    const { result, events } = await run(loopGraph({ list: "{{ $input.users }}", batchSize: 1 }), {
      users,
    });
    assert.equal(result.status, "succeeded");
    const greets = events.filter((e) => e.id === "greet" && e.status === "succeeded");
    assert.deepEqual(
      greets.map((e) => e.output),
      [{ greeting: "hi ann" }, { greeting: "hi bob" }, { greeting: "hi cy" }],
    );
    const finish = events.find((e) => e.id === "finish" && e.status === "succeeded");
    assert.deepEqual(finish?.input, [
      { greeting: "hi ann" },
      { greeting: "hi bob" },
      { greeting: "hi cy" },
    ]);
    // The loop node ran 4 times: three passes and the end.
    const loops = events.filter((e) => e.id === "loop");
    assert.deepEqual(
      loops.map((e) => e.attempt),
      [1, 2, 3, 4],
    );
    assert.deepEqual(loops[0]?.output, {
      items: [{ name: "ann" }],
      item: { name: "ann" },
      index: 0,
      total: 3,
    });
  });

  it("makes batches", async () => {
    const { events } = await run(loopGraph({ list: "{{ $input.users }}", batchSize: 2 }, []), {
      users: [...users, { name: "dee" }, { name: "eve" }],
    });
    const passes = events
      .filter((e) => e.id === "loop" && (e.output as { items?: unknown[] }).items)
      .map((e) => e.output as { items: unknown[]; index: number });
    assert.deepEqual(
      passes.map((p) => [p.index, p.items.length]),
      [
        [0, 2],
        [2, 2],
        [4, 1],
      ],
    );
  });

  it("goes to done at once for an empty list, and skips the loop nodes", async () => {
    const { result, events } = await run(loopGraph({ list: "{{ $input.users }}" }), { users: [] });
    assert.equal(result.status, "succeeded");
    assert.equal(events.find((e) => e.id === "greet")?.status, "skipped");
    assert.deepEqual(events.find((e) => e.id === "finish" && e.status === "succeeded")?.input, []);
  });

  it("starts each run with a fresh state", async () => {
    // Two runs of one graph: each starts with its own state.
    const graph = loopGraph({ list: "{{ $input.users }}" });
    const first = await run(graph, { users });
    const second = await run(graph, { users: [{ name: "zed" }] });
    assert.equal(
      first.events.filter((e) => e.id === "greet" && e.status === "succeeded").length,
      3,
    );
    assert.equal(
      second.events.filter((e) => e.id === "greet" && e.status === "succeeded").length,
      1,
    );
  });

  it("tells an edge that comes back from a first entry by the graph alone", async () => {
    const { events } = await run(loopGraph({ list: "{{ $input.users }}" }), { users });
    const inputs = events.filter((e) => e.id === "loop").map((e) => e.input);
    // The first input is the trigger data and starts the loop. The others come back from the body.
    assert.deepEqual(inputs[0], { users });
    assert.deepEqual(inputs[1], { greeting: "hi ann" });
    assert.deepEqual(inputs[3], { greeting: "hi cy" });
  });

  it("lets the loop output connect to the loop node itself", async () => {
    const graph: Graph = {
      schema: 1,
      nodes: [node("t", "trigger.manual"), node("loop", "flow.loop", { list: "{{ $input }}" })],
      edges: [edge("t", "out", "loop"), edge("loop", "loop", "loop")],
    };
    const { result, events } = await run(graph, ["a", "b"]);
    assert.equal(result.status, "succeeded");
    const passes = events.filter((e) => e.id === "loop").map((e) => e.output);
    // Each pass sends its batch back. The end has the batches that came back.
    assert.equal(passes.length, 3);
    assert.equal((passes[0] as { item: string }).item, "a");
    assert.equal((passes[1] as { item: string }).item, "b");
    assert.equal((passes[2] as unknown[]).length, 2);
  });

  it("stops stale loops at the node run limit", async () => {
    const events: Event[] = [];
    const result = await executeGraph({
      graph: loopGraph({ list: "{{ $input.users }}" }),
      registry,
      triggerInput: { users },
      mode: "production",
      signal: new AbortController().signal,
      maxNodeRuns: 5,
      hooks: [{ afterNode: (e) => void events.push({ id: e.node.id } as Event) }],
    });
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /5 node runs/);
  });

  it("builds the state again when a run goes on after a wait inside the loop", async () => {
    // A one minute wait in the loop body stops the run at the first pass.
    const graph: Graph = {
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("loop", "flow.loop", { list: "{{ $input.users }}" }),
        node("wait", "flow.delay", { amount: 1, unit: "minutes" }),
        node("greet", "data.set", {
          fields: { greeting: "hi {{ $input.item.name }}" },
          keepInput: false,
        }),
        node("finish", "data.set", { fields: {}, keepInput: true }),
      ],
      edges: [
        edge("t", "out", "loop"),
        edge("loop", "loop", "wait"),
        edge("wait", "out", "greet"),
        edge("greet", "out", "loop"),
        edge("loop", "done", "finish"),
      ],
    };
    const first = await run(graph, { users });
    assert.equal(first.result.status, "waiting");

    // What the worker saved: the results of the first run, and the wait in the past.
    const saved: StoredNodeResult[] = [];
    for (const e of first.events) {
      if (e.status === "succeeded") {
        const port = e.id === "loop" ? "loop" : "out";
        saved.push({
          nodeId: e.id,
          attempt: e.attempt,
          status: "succeeded",
          port,
          output: e.output,
        });
      } else if (e.status === "waiting") {
        const stored = e.output as { resumeAt: number; data: unknown };
        saved.push({
          nodeId: e.id,
          attempt: e.attempt,
          status: "waiting",
          port: "out",
          output: { resumeAt: Date.now() - 1, data: stored.data },
        });
      }
    }
    const resumed = await run(graph, { users }, saved);
    // The first pass finishes (greet runs for ann). The loop starts pass two with bob, which
    // proves that the loop state was built again from the saved results.
    const greet = resumed.events.find((e) => e.id === "greet" && e.status === "succeeded");
    assert.deepEqual(greet?.output, { greeting: "hi ann" });
    const secondPass = resumed.events.find((e) => e.id === "loop" && e.attempt === 2);
    assert.deepEqual(secondPass?.output, {
      items: [{ name: "bob" }],
      item: { name: "bob" },
      index: 1,
      total: 3,
    });
    assert.equal(resumed.result.status, "waiting");
  });
});
