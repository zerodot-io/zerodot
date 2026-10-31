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
  suppliesOf,
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
 * single port takes one node, a supply node has no data edges, and supply edges make no loop. A
 * required port with no node is not checked here, so a draft can be saved. The run reports it.
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
    const fromKind = from && fromDefinition ? suppliesOf(fromDefinition, from.config) : undefined;
    if (!isSupplyEdge(edge)) {
      if (from && (fromKind !== undefined || suppliers.has(from.id))) {
        problems.push(`"${from.name}" gives a supply. Connect it to a supply port only`);
      }
      const toKind = to && toDefinition ? suppliesOf(toDefinition, to.config) : undefined;
      if (to && (toKind !== undefined || suppliers.has(to.id))) {
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
      fromKind === undefined && port.kind === TOOL_KIND && canBeTool(fromDefinition, from.config);
    if (edge.fromPort !== SUPPLY_OUT_PORT || (fromKind === undefined && !asTool)) {
      problems.push(
        port.kind === TOOL_KIND
          ? `Edge "${edge.id}": "${from.name}" cannot be a tool`
          : `Edge "${edge.id}": "${from.name}" gives no supply`,
      );
      continue;
    }
    if (!asTool && port.kind !== fromKind) {
      problems.push(
        `Edge "${edge.id}": "${port.label}" of "${to.name}" takes "${port.kind}", not "${fromKind}"`,
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
  // A supply node can have supply ports, so supply edges can go in a circle.
  const supplyEdges = graph.edges.filter(isSupplyEdge);
  const done = new Set<string>();
  const open = new Set<string>();
  const inLoop = (id: string): boolean => {
    if (open.has(id)) return true;
    if (done.has(id)) return false;
    open.add(id);
    const found = supplyEdges.some((e) => e.to === id && inLoop(e.from));
    open.delete(id);
    done.add(id);
    return found;
  };
  for (const node of graph.nodes) {
    if (!done.has(node.id) && inLoop(node.id)) {
      problems.push(`"${node.name}": the supply nodes make a loop`);
      break;
    }
  }
  for (const node of graph.nodes) {
    const definition = registry.get(node.type);
    if (!definition) continue;
    // $fromAI needs a node that runs as a tool, in the literal form.
    try {
      const inputs = fromAIInputs(node, definition);
      if (
        inputs.size > 0 &&
        (!suppliers.has(node.id) || suppliesOf(definition, node.config) !== undefined)
      ) {
        problems.push(`"${node.name}": $fromAI works only in a node connected as a tool`);
      }
    } catch (error) {
      problems.push(`"${node.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}
