// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fanInProblems, type Graph, GraphError, validateGraph } from "./graph";

const node = (id: string, type: string): Graph["nodes"][number] => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  config: {},
  credentialId: null,
  onError: "fail",
  pinned: null,
});

const graphOf = (...types: string[]): Graph => ({
  schema: 1,
  nodes: types.map((type, i) => node(`n${i}`, type)),
  edges: [],
});

describe("validateGraph", () => {
  it("accepts one trigger", () => {
    validateGraph(graphOf("trigger.webhook", "logic.branch"));
  });

  it("accepts no trigger", () => {
    validateGraph(graphOf("logic.branch"));
  });

  it("accepts two triggers", () => {
    validateGraph(graphOf("trigger.webhook", "trigger.telegram"));
  });

  it("rejects an edge into a trigger and a duplicate name", () => {
    const graph = graphOf("trigger.manual", "x");
    graph.edges = [{ id: "1", from: "n1", fromPort: "out", to: "n0", toPort: "in" }];
    assert.throws(() => validateGraph(graph), /incoming edge/);
    const dup = graphOf("x", "x");
    dup.nodes[1] = { ...dup.nodes[1], name: "n0" } as Graph["nodes"][number];
    assert.throws(() => validateGraph(dup), /Duplicate node name/);
  });

  it("accepts a merge node with several incoming edges", () => {
    const graph = graphOf("trigger.manual", "x", "data.merge");
    graph.edges = [
      { id: "1", from: "n0", fromPort: "out", to: "n1", toPort: "in" },
      { id: "2", from: "n1", fromPort: "out", to: "n2", toPort: "input1" },
      { id: "3", from: "n0", fromPort: "out", to: "n2", toPort: "input2" },
    ];
    validateGraph(graph);
  });
});

describe("fanInProblems", () => {
  const e = (id: string, from: string, to: string, toPort = "in") => ({
    id,
    from,
    fromPort: "out",
    to,
    toPort,
  });
  const isJoin = (n: Graph["nodes"][number]) => n.type === "data.merge";
  const withEdges = (types: string[], edges: Graph["edges"]): Graph => ({
    ...graphOf(...types),
    edges,
  });

  it("allows fan-out from one port", () => {
    const graph = withEdges(["trigger.manual", "x", "x"], [e("1", "n0", "n1"), e("2", "n0", "n2")]);
    assert.deepEqual(fanInProblems(graph, isJoin), []);
  });

  it("allows several edges into a merge node on different inputs", () => {
    const graph = withEdges(
      ["trigger.manual", "x", "data.merge"],
      [e("1", "n0", "n1"), e("2", "n1", "n2", "input1"), e("3", "n0", "n2", "input2")],
    );
    assert.deepEqual(fanInProblems(graph, isJoin), []);
  });

  it("rejects two edges on one input of a merge node", () => {
    const graph = withEdges(
      ["trigger.manual", "x", "data.merge"],
      [e("1", "n0", "n1"), e("2", "n1", "n2", "input1"), e("3", "n0", "n2", "input1")],
    );
    assert.equal(fanInProblems(graph, isJoin).length, 1);
  });

  it("rejects two forward edges into a node that is not a merge node", () => {
    const graph = withEdges(
      ["trigger.manual", "x", "x"],
      [e("1", "n0", "n1"), e("2", "n0", "n2"), e("3", "n1", "n2")],
    );
    assert.match(fanInProblems(graph, isJoin)[0] ?? "", /Merge node/);
  });

  it("allows a loop edge back into a node", () => {
    const graph = withEdges(
      ["trigger.manual", "loop", "x"],
      [e("1", "n0", "n1"), e("2", "n1", "n2"), e("3", "n2", "n1")],
    );
    assert.deepEqual(fanInProblems(graph, isJoin), []);
  });
});
