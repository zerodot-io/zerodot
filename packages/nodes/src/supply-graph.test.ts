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
