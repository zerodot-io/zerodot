// SPDX-License-Identifier: AGPL-3.0-only
import {
  canBeTool,
  fanInProblems,
  fromAIInputs,
  type Graph,
  inputPortsOf,
  isSupplyEdge,
  type NodeRegistry,
  outputPortsOf,
  SUPPLY_OUT_PORT,
  supplyPortOf,
  TOOL_KIND,
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
    if (isSupplyEdge(edge)) continue;
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
  problems.push(...supplyProblems(graph, registry));
  return problems;
}

/**
 * Supply rules: a supply edge goes from a supply node into a supply port of the same kind, a
 * single port takes one node, and a supply node has no data edges and no supply ports. A required
 * port with no node is not checked here, so a draft can be saved. The run reports it.
 */
function supplyProblems(graph: Graph, registry: NodeRegistry): string[] {
  const problems: string[] = [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const counts = new Map<string, number>();
  // A node with a supply edge out of it is a supply node or a node tool. It takes no data.
  const suppliers = new Set(graph.edges.filter(isSupplyEdge).map((e) => e.from));
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const fromDefinition = from ? registry.get(from.type) : undefined;
    const toDefinition = to ? registry.get(to.type) : undefined;
    if (!isSupplyEdge(edge)) {
      if (from && (fromDefinition?.supplies !== undefined || suppliers.has(from.id))) {
        problems.push(`"${from.name}" gives a supply. Connect it to a supply port only`);
      }
      if (to && (toDefinition?.supplies !== undefined || suppliers.has(to.id))) {
        problems.push(`"${to.name}" gives a supply. It cannot take data`);
      }
      continue;
    }
    if (!from || !to || !fromDefinition || !toDefinition) continue;
    const port = toDefinition.supplyPorts?.find((p) => p.name === supplyPortOf(edge));
    if (!port) {
      problems.push(`Edge "${edge.id}": "${to.name}" has no supply port "${supplyPortOf(edge)}"`);
      continue;
    }
    const asTool =
      fromDefinition.supplies === undefined && port.kind === TOOL_KIND && canBeTool(fromDefinition);
    if (edge.fromPort !== SUPPLY_OUT_PORT || (fromDefinition.supplies === undefined && !asTool)) {
      problems.push(
        port.kind === TOOL_KIND
          ? `Edge "${edge.id}": "${from.name}" cannot be a tool`
          : `Edge "${edge.id}": "${from.name}" gives no supply`,
      );
      continue;
    }
    if (!asTool && port.kind !== fromDefinition.supplies) {
      problems.push(
        `Edge "${edge.id}": "${port.label}" of "${to.name}" takes "${port.kind}", not "${fromDefinition.supplies}"`,
      );
      continue;
    }
    if (from.disabled) continue;
    const key = `${to.id}:${port.name}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if (count === 2 && !port.multiple) {
      problems.push(`"${port.label}" of "${to.name}" takes one node`);
    }
  }
  for (const node of graph.nodes) {
    const definition = registry.get(node.type);
    if (!definition) continue;
    if (definition.supplies !== undefined && definition.supplyPorts?.length) {
      problems.push(`"${node.name}": a supply node cannot have supply ports`);
    }
    // $fromAI needs a node that runs as a tool, in the literal form.
    try {
      const inputs = fromAIInputs(node, definition);
      if (inputs.size > 0 && (!suppliers.has(node.id) || definition.supplies !== undefined)) {
        problems.push(`"${node.name}": $fromAI works only in a node connected as a tool`);
      }
    } catch (error) {
      problems.push(`"${node.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}
