// SPDX-License-Identifier: AGPL-3.0-only
import type { Graph, GraphEdge, GraphNode } from "./graph";

export type NodeChange = {
  id: string;
  name: string;
  /** The parts of the node that are not the same. */
  fields: ("name" | "type" | "config" | "credential" | "options")[];
};

export type GraphDiff = {
  addedNodes: { id: string; name: string }[];
  removedNodes: { id: string; name: string }[];
  changedNodes: NodeChange[];
  addedEdges: number;
  removedEdges: number;
};

/** A stable text for a value. Object keys are sorted, so key order does not matter. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const edgeKey = (e: GraphEdge) => `${e.from}:${e.fromPort}>${e.to}:${e.toPort}`;

function changedFields(a: GraphNode, b: GraphNode): NodeChange["fields"] {
  const fields: NodeChange["fields"] = [];
  if (a.name !== b.name) fields.push("name");
  if (a.type !== b.type) fields.push("type");
  if (canonical(a.config) !== canonical(b.config)) fields.push("config");
  if (
    a.credentialId !== b.credentialId ||
    (a.credentialExpression ?? "") !== (b.credentialExpression ?? "")
  )
    fields.push("credential");
  const options = (n: GraphNode) =>
    canonical([
      n.pinned,
      n.disabled ?? false,
      n.retry,
      n.onError,
      n.alwaysOutputData ?? false,
      n.executeOnce ?? false,
      n.notes ?? "",
      n.notesInFlow ?? false,
    ]);
  if (options(a) !== options(b)) fields.push("options");
  return fields;
}

/**
 * What changed from `before` to `after`. Nodes match by id. A move on the canvas is not a change.
 * Edges match by their ends and ports, so a new edge id alone is not a change.
 */
export function diffGraphs(before: Graph, after: Graph): GraphDiff {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const next = new Map(after.nodes.map((n) => [n.id, n]));
  const changedNodes: NodeChange[] = [];
  for (const [id, node] of next) {
    const previous = old.get(id);
    if (!previous) continue;
    const fields = changedFields(previous, node);
    if (fields.length > 0) changedNodes.push({ id, name: node.name, fields });
  }
  const oldEdges = new Set(before.edges.map(edgeKey));
  const nextEdges = new Set(after.edges.map(edgeKey));
  return {
    addedNodes: after.nodes.filter((n) => !old.has(n.id)).map((n) => ({ id: n.id, name: n.name })),
    removedNodes: before.nodes
      .filter((n) => !next.has(n.id))
      .map((n) => ({ id: n.id, name: n.name })),
    changedNodes,
    addedEdges: [...nextEdges].filter((k) => !oldEdges.has(k)).length,
    removedEdges: [...oldEdges].filter((k) => !nextEdges.has(k)).length,
  };
}
