// SPDX-License-Identifier: AGPL-3.0-only

import type { Edge, Node } from "@xyflow/react";
import { type Graph, type GraphNode, graphSchema, isSupplyEdge } from "@zerodot/engine";
import {
  type CredentialTypeCatalogEntry,
  catalog,
  mergeCatalog,
  mergeCredentialTypeCatalog,
  type NodeCatalogEntry,
} from "@zerodot/nodes";

export type NodeRunStatus = "idle" | "running" | "waiting" | "succeeded" | "failed" | "skipped";

export type ZerodotFlowNode = Node<{ graphNode: GraphNode }, "zerodot">;

export const catalogByType = new Map<string, NodeCatalogEntry>(catalog.map((c) => [c.type, c]));

/** Adds the nodes and credential types that the server has and the browser bundle does not. */
export function addServerCatalog(extra: { nodes: unknown; credentialTypes: unknown }) {
  const nodes = extra.nodes as NodeCatalogEntry[];
  mergeCatalog(nodes);
  mergeCredentialTypeCatalog(extra.credentialTypes as CredentialTypeCatalogEntry[]);
  for (const entry of nodes) catalogByType.set(entry.type, entry);
}

/** True for an edge from a supply node into a supply port. It carries no data. */
export const isSupplyFlowEdge = (edge: Pick<Edge, "sourceHandle" | "targetHandle">) =>
  isSupplyEdge({ fromPort: edge.sourceHandle ?? "out", toPort: edge.targetHandle ?? "in" });

/**
 * Supply nodes and tools are no steps, so a run gives them no status. They take the status of the
 * node they supply while it runs or after it succeeded, so the run shows the whole chain.
 */
export function withSupplyStatuses(
  statuses: Record<string, NodeRunStatus>,
  edges: Pick<Edge, "source" | "target" | "sourceHandle" | "targetHandle">[],
): Record<string, NodeRunStatus> {
  const next = { ...statuses };
  for (const edge of edges) {
    if (!isSupplyFlowEdge(edge) || statuses[edge.source]) continue;
    const parent = statuses[edge.target];
    if (parent === "running" || parent === "waiting" || parent === "succeeded") {
      next[edge.source] = parent;
    }
  }
  return next;
}

export function toFlow(graph: Graph): { nodes: ZerodotFlowNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "zerodot",
      position: n.position,
      data: { graphNode: n },
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      type: "zerodot",
      source: e.from,
      sourceHandle: e.fromPort,
      target: e.to,
      targetHandle: e.toPort,
    })),
  };
}

export function toGraph(nodes: ZerodotFlowNode[], edges: Edge[]): Graph {
  return {
    schema: 1,
    nodes: nodes.map((n) => ({ ...n.data.graphNode, position: n.position })),
    edges: edges.map((e) => ({
      id: e.id,
      from: e.source,
      fromPort: e.sourceHandle ?? "out",
      to: e.target,
      toPort: e.targetHandle ?? "in",
    })),
  };
}

export function parseGraph(raw: unknown): Graph {
  return graphSchema.parse(raw);
}

/** A name that no other node uses: "HTTP Request", "HTTP Request 2", ... */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const names = new Set(taken);
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

export function newNode(
  type: string,
  existing: ZerodotFlowNode[],
  config: Record<string, unknown> = {},
): ZerodotFlowNode {
  const entry = catalogByType.get(type);
  if (!entry) throw new Error(`Unknown node type "${type}"`);
  const last = existing.at(-1);
  const graphNode: GraphNode = {
    id: `n_${crypto.randomUUID().slice(0, 8)}`,
    type,
    name: uniqueName(
      entry.label,
      existing.map((n) => n.data.graphNode.name),
    ),
    position: last ? { x: last.position.x + 260, y: last.position.y } : { x: 40, y: 120 },
    config: {
      ...structuredClone((entry.defaultConfig ?? {}) as Record<string, unknown>),
      // A Webhook node starts with a path, so its URL is stable from the first test.
      ...(type === "trigger.webhook" ? { path: crypto.randomUUID() } : {}),
      ...config,
    },
    credentialId: null,
    pinned: null,
    onError: "fail",
  };
  return { id: graphNode.id, type: "zerodot", position: graphNode.position, data: { graphNode } };
}

/** The clipboard text for the selected nodes and the edges between them. Null if none selected. */
export function copyGraph(nodes: ZerodotFlowNode[], edges: Edge[]): string | null {
  const picked = nodes.filter((n) => n.selected);
  if (picked.length === 0) return null;
  const ids = new Set(picked.map((n) => n.id));
  const inside = edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return JSON.stringify(toGraph(picked, inside), null, 2);
}

/**
 * Nodes and edges from clipboard text, with new ids and names that do not clash with `existing`.
 * Null if the text is not a zerodot graph. The nodes move by `offset` so they do not hide the originals.
 */
export function pasteGraph(
  text: string,
  existing: ZerodotFlowNode[],
  offset = 40,
): { nodes: ZerodotFlowNode[]; edges: Edge[] } | null {
  let graph: Graph;
  try {
    graph = graphSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
  if (graph.nodes.length === 0) return null;
  const idMap = new Map(graph.nodes.map((n) => [n.id, `n_${crypto.randomUUID().slice(0, 8)}`]));
  const names = existing.map((n) => n.data.graphNode.name);
  const nodes = graph.nodes.map((n): ZerodotFlowNode => {
    const name = uniqueName(n.name, names);
    names.push(name);
    const id = idMap.get(n.id) ?? n.id;
    const position = { x: n.position.x + offset, y: n.position.y + offset };
    return {
      id,
      type: "zerodot",
      position,
      selected: true,
      data: { graphNode: { ...n, id, name, position } },
    };
  });
  const edges: Edge[] = graph.edges.flatMap((e) => {
    const source = idMap.get(e.from);
    const target = idMap.get(e.to);
    if (!source || !target) return [];
    return [
      {
        id: `e_${crypto.randomUUID().slice(0, 8)}`,
        type: "zerodot",
        source,
        sourceHandle: e.fromPort,
        target,
        targetHandle: e.toPort,
      },
    ];
  });
  return { nodes, edges };
}
