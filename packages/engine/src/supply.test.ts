// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeGraph, type NodeEndEvent } from "./execute";
import { type Graph, rootNodes } from "./graph";
import { createRegistry, defineNode, defineSupplyNode } from "./node";

const trigger = defineNode({
  type: "trigger.test",
  label: "Trigger",
  category: "trigger",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});

/** Gives a function that says its name and the `who` of its config. */
const greeter = defineSupplyNode({
  type: "test.greeter",
  label: "Greeter",
  category: "core",
  icon: "CircleIcon",
  config: z.object({ who: z.string() }),
  defaultConfig: { who: "" },
  supplies: "test.greet",
  supply: ({ config, node, log }) => {
    log?.([{ level: "log", message: "built" }]);
    return () => `${node.name}:${config.who}`;
  },
});

const broken = defineSupplyNode({
  type: "test.broken",
  label: "Broken",
  category: "core",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  supplies: "test.greet",
  supply: () => {
    throw new Error("no key");
  },
});

/** Calls each greeter it gets. */
const host = defineNode({
  type: "test.host",
  label: "Host",
  category: "core",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  supplyPorts: [
    { name: "main", kind: "test.greet", label: "Main", required: true },
    { name: "extra", kind: "test.greet", label: "Extra", multiple: true },
  ],
  run: ({ supplies }) => {
    const main = supplies?.main as () => string;
    const extra = supplies?.extra as (() => string)[];
    return { port: "out", data: { main: main(), extra: extra.map((f) => f()) } };
  },
});

const registry = createRegistry([trigger, greeter, broken, host]);

const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({
  id,
  type,
  name: id,
  position: { x, y: 0 },
  config,
  credentialId: null,
  pinned: null,
  onError: "fail" as const,
});

function graphWith(extraNodes: Graph["nodes"], extraEdges: Graph["edges"]): Graph {
  return {
    schema: 1,
    nodes: [node("t", "trigger.test"), node("h", "test.host"), ...extraNodes],
    edges: [{ id: "e1", from: "t", fromPort: "out", to: "h", toPort: "in" }, ...extraEdges],
  };
}

const supplyEdge = (from: string, port: string) => ({
  id: `s-${from}`,
  from,
  fromPort: "supply",
  to: "h",
  toPort: `supply:${port}`,
});

async function run(graph: Graph) {
  const ends: NodeEndEvent[] = [];
  const result = await executeGraph({
    graph,
    registry,
    triggerInput: { name: "Ada" },
    mode: "production",
    signal: new AbortController().signal,
    hooks: [{ afterNode: (event) => void ends.push(event) }],
  });
  return { result, ends };
}

describe("supply nodes", () => {
  it("builds supplies with the scope of the parent and orders a multiple port by x", async () => {
    const { result, ends } = await run(
      graphWith(
        [
          node("m", "test.greeter", { who: "{{ $input.name }}" }),
          node("b", "test.greeter", { who: "b" }, 200),
          node("a", "test.greeter", { who: "a" }, 100),
        ],
        [supplyEdge("m", "main"), supplyEdge("b", "extra"), supplyEdge("a", "extra")],
      ),
    );
    assert.equal(result.status, "succeeded");
    const hostEnd = ends.find((e) => e.node.id === "h");
    assert.deepEqual(hostEnd?.output, { main: "m:Ada", extra: ["a:a", "b:b"] });
    assert.ok(hostEnd?.logs?.some((l) => l.message === "[m] built"));
    // Supply nodes are never steps.
    assert.deepEqual(
      ends.map((e) => e.node.id),
      ["t", "h"],
    );
  });

  it("fails the parent when a required port has no node", async () => {
    const { result } = await run(graphWith([], []));
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /Connect a node to "Main"/);
  });

  it("counts a disabled supply node as not connected", async () => {
    const off = { ...node("m", "test.greeter", { who: "x" }), disabled: true };
    const { result } = await run(graphWith([off], [supplyEdge("m", "main")]));
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /Connect a node/);
  });

  it("names the supply node when supply() throws", async () => {
    const { result } = await run(graphWith([node("k", "test.broken")], [supplyEdge("k", "main")]));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.message, 'Supply "k" (Main): no key');
  });

  it("does not count a supply node as a root", () => {
    const graph = graphWith([node("m", "test.greeter", { who: "x" })], [supplyEdge("m", "main")]);
    assert.deepEqual(
      rootNodes(graph).map((n) => n.id),
      ["t"],
    );
  });
});
