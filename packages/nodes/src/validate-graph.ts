// SPDX-License-Identifier: AGPL-3.0-only
import {
  fanInProblems,
  type Graph,
  inputPortsOf,
  type NodeRegistry,
  outputPortsOf,
} from "@zerodot/engine";

const EXPRESSION = "{{";

function valueAt(root: unknown, path: PropertyKey[]): unknown {
  let current = root;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return current;
}

/**
 * Checks what an API client sends: known node types, config against the Zod schema of the
 * node, and edge ports. A value that holds `{{ }}` is an expression. It resolves at run time,
 * so its type is not checked here. Returns one message for each problem.
 */
export function checkGraphNodes(graph: Graph, registry: NodeRegistry): string[] {
  const problems: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    const definition = registry.get(node.type);
    if (!definition) {
      problems.push(`"${node.name}": unknown node type "${node.type}"`);
      continue;
    }
    const result = definition.config.safeParse(node.config);
    if (result.success) continue;
    for (const issue of result.error.issues) {
      const value = valueAt(node.config, issue.path);
      if (typeof value === "string" && value.includes(EXPRESSION)) continue;
      const where = issue.path.length > 0 ? ` config.${issue.path.join(".")}` : " config";
      problems.push(`"${node.name}":${where}: ${issue.message}`);
    }
  }
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const fromDefinition = from ? registry.get(from.type) : undefined;
    const toDefinition = to ? registry.get(to.type) : undefined;
    if (from && fromDefinition) {
      const ports = outputPortsOf(fromDefinition, from.config);
      if (!ports.includes(edge.fromPort)) {
        problems.push(
          `Edge "${edge.id}": "${from.name}" has no output port "${edge.fromPort}". Ports: ${ports.join(", ")}`,
        );
      }
    }
    if (to && toDefinition) {
      // The input ports can depend on the config (the inputs of a Merge node).
      const ports = inputPortsOf(toDefinition, to.config);
      if (!ports.includes(edge.toPort)) {
        problems.push(
          `Edge "${edge.id}": "${to.name}" has no input port "${edge.toPort}". Ports: ${ports.join(", ")}. Remove the edge or raise the number of inputs`,
        );
      }
    }
  }
  problems.push(...fanInProblems(graph, (node) => registry.get(node.type)?.join === true));
  return problems;
}
