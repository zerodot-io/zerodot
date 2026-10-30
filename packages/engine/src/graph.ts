// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

export const retrySchema = z.object({
  max: z.number().int().min(1).max(10),
  backoffMs: z.number().int().min(0).max(60_000).default(1000),
});

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  position: z.object({ x: z.number(), y: z.number() }),
  config: z.record(z.string(), z.unknown()).default({}),
  credentialId: z.string().nullable().default(null),
  /**
   * An expression that gives the id or the name of the credential at run time. When set, it is
   * used instead of `credentialId`.
   */
  credentialExpression: z.string().min(1).optional(),
  /** Sample output. Test runs use it and skip the node. */
  pinned: z.object({ port: z.string(), data: z.unknown() }).nullable().default(null),
  /** A deactivated node passes its input through and does not run. */
  disabled: z.boolean().optional(),
  retry: retrySchema.optional(),
  onError: z.enum(["fail", "continue"]).default("fail"),
  /** If the node returns nothing or an empty list, it outputs an empty object instead. */
  alwaysOutputData: z.boolean().optional(),
  /** If the input is a list, the node runs once with the first item only. */
  executeOnce: z.boolean().optional(),
  /** A note for people. Not used at run time. */
  notes: z.string().optional(),
  /** Show the note under the node on the canvas. */
  notesInFlow: z.boolean().optional(),
});

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  fromPort: z.string().min(1),
  to: z.string().min(1),
  toPort: z.string().min(1),
});

export const graphSchema = z.object({
  schema: z.literal(1),
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

export type Graph = z.infer<typeof graphSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const EMPTY_GRAPH: Graph = { schema: 1, nodes: [], edges: [] };

export const TRIGGER_PREFIX = "trigger.";

export function isTriggerType(type: string) {
  return type.startsWith(TRIGGER_PREFIX);
}

/** The output port of a supply node. A supply edge goes from it to a supply port of a node. */
export const SUPPLY_OUT_PORT = "supply";
/** The input port of a supply edge is this prefix and the name of the supply port. */
export const SUPPLY_PORT_PREFIX = "supply:";

/** True for an edge from a supply node into a supply port. It carries no data and is no step. */
export function isSupplyEdge(edge: Pick<GraphEdge, "fromPort" | "toPort">): boolean {
  return edge.fromPort === SUPPLY_OUT_PORT || edge.toPort.startsWith(SUPPLY_PORT_PREFIX);
}

/** The name of the supply port of a supply edge, for example "model" for "supply:model". */
export function supplyPortOf(edge: Pick<GraphEdge, "toPort">): string {
  return edge.toPort.slice(SUPPLY_PORT_PREFIX.length);
}

/** The edges that carry data. The step walk, roots, loops and joins use these only. */
export function flowEdges(graph: Pick<Graph, "edges">): GraphEdge[] {
  return graph.edges.filter((e) => !isSupplyEdge(e));
}

/** The nodes that an edge leaves through the supply port. They are never steps. */
function supplySources(graph: Pick<Graph, "edges">): Set<string> {
  return new Set(graph.edges.filter(isSupplyEdge).map((e) => e.from));
}

/**
 * The nodes that no edge leads into. A workflow with no trigger starts at one of them. A node
 * that gives a supply is not one.
 */
export function rootNodes(graph: Graph): GraphNode[] {
  const targets = new Set(flowEdges(graph).map((e) => e.to));
  const supplies = supplySources(graph);
  return graph.nodes.filter((n) => !targets.has(n.id) && !supplies.has(n.id) && !n.disabled);
}

export class GraphError extends Error {}

/**
 * Structure checks: unique ids, known edge ends, no edge into a trigger.
 * Node config is not checked here. It can hold expressions and is checked at run time.
 */
export function validateGraph(graph: Graph): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) throw new GraphError(`Duplicate node id "${node.id}"`);
    ids.add(node.id);
  }
  const names = new Set<string>();
  for (const node of graph.nodes) {
    if (names.has(node.name)) throw new GraphError(`Duplicate node name "${node.name}"`);
    names.add(node.name);
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new GraphError(`Edge "${edge.id}" points to a missing node`);
    }
  }
  // A node can have more than one parent, and an edge can go back to an earlier node (a loop).
  // The engine stops a run that does not end (see `maxNodeRuns`). A trigger starts the run, so no
  // edge can lead into it.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const edge of graph.edges) {
    const target = byId.get(edge.to);
    if (target && isTriggerType(target.type)) {
      throw new GraphError(`The trigger node "${target.name}" cannot have an incoming edge`);
    }
  }
}

/** The nodes that a node feeds, directly or through other nodes. */
function downstreamOf(edges: GraphEdge[], nodeId: string): Set<string> {
  const found = new Set<string>();
  const queue = [nodeId];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const edge of edges) {
      if (edge.from === id && !found.has(edge.to)) {
        found.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return found;
}

/** An edge comes back when its source is downstream of its target (a loop). */
export function isBackEdge(edges: GraphEdge[], edge: GraphEdge): boolean {
  return edge.from === edge.to || downstreamOf(edges, edge.to).has(edge.from);
}

/**
 * Fan-in rules. Fan-out is free: one port can feed any number of nodes. Fan-in is allowed only
 * into a merge (join) node, where each input port takes one edge. Any other node takes one
 * forward edge; a loop adds an edge that comes back to it. `isJoin` tells which nodes are merge
 * nodes. Returns one message for each problem.
 */
export function fanInProblems(graph: Graph, isJoin: (node: GraphNode) => boolean): string[] {
  const problems: string[] = [];
  const edges = flowEdges(graph);
  for (const node of graph.nodes) {
    const incoming = edges.filter((e) => e.to === node.id);
    if (incoming.length < 2) continue;
    if (isJoin(node)) {
      const seen = new Set<string>();
      for (const edge of incoming) {
        if (seen.has(edge.toPort)) {
          problems.push(
            `"${node.name}": input "${edge.toPort}" has more than one edge. Connect each branch to its own input.`,
          );
        }
        seen.add(edge.toPort);
      }
    } else if (incoming.filter((e) => !isBackEdge(edges, e)).length > 1) {
      problems.push(
        `"${node.name}" has more than one incoming edge. Join the branches with a Merge node first.`,
      );
    }
  }
  return problems;
}
