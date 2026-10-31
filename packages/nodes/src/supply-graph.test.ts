// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRegistry, defineNode, defineSupplyNode, type Graph } from "@zerodot/engine";
import { z } from "zod";
import { checkGraphNodes } from "./validate-graph";

const base = {
  category: "core" as const,
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
};
const model = defineSupplyNode({
  ...base,
  type: "test.model",
  label: "Model",
  supplies: "ai.model",
  supply: () => ({}),
});
const tool = defineSupplyNode({
  ...base,
  type: "test.tool",
  label: "Tool",
  supplies: "ai.tool",
  supply: () => ({}),
});
const agent = defineNode({
  ...base,
  type: "test.agent",
  label: "Agent",
  ports: { in: ["in"], out: ["out"] },
  supplyPorts: [
    { name: "model", kind: "ai.model", label: "Chat Model", required: true },
    { name: "tools", kind: "ai.tool", label: "Tool", multiple: true },
  ],
  run: () => ({ port: "out", data: {} }),
});
const registry = createRegistry([model, tool, agent]);

const node = (id: string, type: string) => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  config: {},
  credentialId: null,
  pinned: null,
  onError: "fail" as const,
});
const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  id: `${from}-${to}-${toPort}`,
  from,
  fromPort,
  to,
  toPort,
});
const graph = (edges: Graph["edges"]): Graph => ({
  schema: 1,
  nodes: [
    node("a", "test.agent"),
    node("m", "test.model"),
    node("m2", "test.model"),
    node("t", "test.tool"),
  ],
  edges,
});

describe("supply graph check", () => {
  it("accepts supply edges of the right kind, and a missing required port", () => {
    assert.deepEqual(
      checkGraphNodes(graph([edge("m", "supply", "a", "supply:model")]), registry),
      [],
    );
    assert.deepEqual(checkGraphNodes(graph([]), registry), []);
  });

  it("rejects a kind that does not match", () => {
    const problems = checkGraphNodes(graph([edge("t", "supply", "a", "supply:model")]), registry);
    assert.match(problems[0] ?? "", /takes "ai.model", not "ai.tool"/);
  });

  it("rejects two nodes on a single port", () => {
    const problems = checkGraphNodes(
      graph([edge("m", "supply", "a", "supply:model"), edge("m2", "supply", "a", "supply:model")]),
      registry,
    );
    assert.deepEqual(problems, ['"Chat Model" of "a" takes one node']);
  });

  it("rejects an unknown supply port and a data edge from a supply node", () => {
    assert.match(
      checkGraphNodes(graph([edge("m", "supply", "a", "supply:nope")]), registry)[0] ?? "",
      /no supply port "nope"/,
    );
    const problems = checkGraphNodes(graph([edge("m", "out", "a", "in")]), registry);
    assert.ok(problems.some((p) => p.includes("Connect it to a supply port only")));
  });
});

describe("nested supply graph check", () => {
  const embedding = defineSupplyNode({
    ...base,
    type: "test.embedding",
    label: "Embedding",
    supplies: "ai.embedding",
    supply: () => ({}),
  });
  /** A tool supply with its own embedding port. */
  const storeTool = defineSupplyNode({
    ...base,
    type: "test.store-tool",
    label: "Store tool",
    supplies: "ai.tool",
    supplyPorts: [{ name: "embedding", kind: "ai.embedding", label: "Embedding" }],
    supply: () => ({}),
  });
  /** A supply that takes its own kind, so two of them can make a loop. */
  const chain = defineSupplyNode({
    ...base,
    type: "test.chain",
    label: "Chain",
    supplies: "ai.embedding",
    supplyPorts: [{ name: "embedding", kind: "ai.embedding", label: "Embedding" }],
    supply: () => ({}),
  });
  const reg = createRegistry([agent, embedding, storeTool, chain]);

  it("accepts a supply node with supply ports", () => {
    const g: Graph = {
      schema: 1,
      nodes: [node("a", "test.agent"), node("v", "test.store-tool"), node("e", "test.embedding")],
      edges: [
        edge("v", "supply", "a", "supply:tools"),
        edge("e", "supply", "v", "supply:embedding"),
      ],
    };
    assert.deepEqual(checkGraphNodes(g, reg), []);
  });

  it("rejects supply nodes that make a loop", () => {
    const g: Graph = {
      schema: 1,
      nodes: [node("c1", "test.chain"), node("c2", "test.chain")],
      edges: [
        edge("c1", "supply", "c2", "supply:embedding"),
        edge("c2", "supply", "c1", "supply:embedding"),
      ],
    };
    assert.ok(checkGraphNodes(g, reg).some((p) => p.includes("the supply nodes make a loop")));
  });
});

describe("node tool graph check", () => {
  const slack = defineNode({
    ...base,
    type: "test.slack",
    label: "Slack",
    category: "integration",
    config: z.object({ text: z.string() }),
    defaultConfig: { text: "" },
    ports: { in: ["in"], out: ["out"] },
    run: () => ({ port: "out", data: {} }),
  });
  const set = defineNode({
    ...base,
    type: "test.set",
    label: "Set",
    ports: { in: ["in"], out: ["out"] },
    run: () => ({ port: "out", data: {} }),
  });
  const reg = createRegistry([agent, slack, set]);
  const g = (text: string, extra: Graph["edges"] = [], type = "test.slack"): Graph => ({
    schema: 1,
    nodes: [node("a", "test.agent"), { ...node("s", type), config: { text } }],
    edges: [edge("s", "supply", "a", "supply:tools"), ...extra],
  });

  it("accepts an integration node on the tool port with $fromAI", () => {
    assert.deepEqual(checkGraphNodes(g('{{ $fromAI("text") }}'), reg), []);
  });

  it("rejects a node that cannot be a tool, and data edges on a tool", () => {
    assert.match(checkGraphNodes(g("", [], "test.set"), reg)[0] ?? "", /cannot be a tool/);
    const problems = checkGraphNodes(g("", [edge("s", "out", "a", "in")]), reg);
    assert.ok(problems.some((p) => p.includes("gives a supply")));
  });

  it("rejects $fromAI outside a tool and a key that is not text", () => {
    const loose: Graph = {
      schema: 1,
      nodes: [{ ...node("s", "test.slack"), config: { text: '{{ $fromAI("x") }}' } }],
      edges: [],
    };
    assert.match(checkGraphNodes(loose, reg)[0] ?? "", /only in a node connected as a tool/);
    assert.match(checkGraphNodes(g("{{ $fromAI($input.a) }}"), reg)[0] ?? "", /config.text/);
  });
});
