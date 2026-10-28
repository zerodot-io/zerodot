// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffGraphs } from "./diff";
import type { Graph } from "./graph";

const node = (id: string, config: Record<string, unknown> = {}, x = 0) => ({
  id,
  type: "test.echo",
  name: `Node ${id}`,
  position: { x, y: 0 },
  config,
  credentialId: null,
  pinned: null,
  onError: "fail" as const,
});
const edge = (id: string, from: string, to: string) => ({
  id,
  from,
  fromPort: "out",
  to,
  toPort: "in",
});

describe("diffGraphs", () => {
  const base: Graph = {
    schema: 1,
    nodes: [node("a", { x: 1, y: 2 }), node("b")],
    edges: [edge("e1", "a", "b")],
  };

  it("finds no change in equal graphs, key order, or a moved node", () => {
    const same: Graph = {
      schema: 1,
      nodes: [node("a", { y: 2, x: 1 }, 300), node("b")],
      edges: [edge("other-id", "a", "b")],
    };
    const diff = diffGraphs(base, same);
    assert.deepEqual(diff, {
      addedNodes: [],
      removedNodes: [],
      changedNodes: [],
      addedEdges: 0,
      removedEdges: 0,
    });
  });

  it("finds added, removed, and changed nodes and edges", () => {
    const next: Graph = {
      schema: 1,
      nodes: [node("a", { x: 9, y: 2 }), node("c")],
      edges: [edge("e2", "a", "c")],
    };
    const diff = diffGraphs(base, next);
    assert.deepEqual(diff.addedNodes, [{ id: "c", name: "Node c" }]);
    assert.deepEqual(diff.removedNodes, [{ id: "b", name: "Node b" }]);
    assert.deepEqual(diff.changedNodes, [{ id: "a", name: "Node a", fields: ["config"] }]);
    assert.equal(diff.addedEdges, 1);
    assert.equal(diff.removedEdges, 1);
  });
});
