// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import { type Graph, graphSchema } from "./graph";

/**
 * The `.zerodot.json` file: a graph plus a name and the variable keys it reads.
 * It has no variable values and no credential data.
 */
export const workflowExportSchema = graphSchema.extend({
  name: z.string().trim().min(1).max(120).optional(),
  variables: z.array(z.string()).optional(),
});

export type WorkflowExport = z.infer<typeof workflowExportSchema>;

const VARS_PATTERN = /\$vars(?:\.([A-Za-z_][\w-]*)|\[\s*(?:"([^"]+)"|'([^']+)')\s*\])/g;

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* strings(item);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* strings(item);
  }
}

/** Keys read as `$vars.key`, `$vars["key"]`, or `$vars['key']` in the config of any node. */
export function variableKeysUsed(graph: Graph): string[] {
  const keys = new Set<string>();
  for (const node of graph.nodes) {
    for (const text of strings(node.config)) {
      for (const match of text.matchAll(VARS_PATTERN)) {
        const key = match[1] ?? match[2] ?? match[3];
        if (key) keys.add(key);
      }
    }
  }
  return [...keys].sort();
}

export function buildExport(name: string, graph: Graph): WorkflowExport {
  return { name, ...graph, variables: variableKeysUsed(graph) };
}

export type ParsedImport = {
  name: string | null;
  graph: Graph;
  /** Variable keys the file lists, or finds in the graph, that the project does not have. */
  missingVariables: string[];
  /** Nodes that had a credential this project does not have. The import clears it. */
  clearedCredentials: string[];
};

/**
 * Check an import file. A credential id that the project does not know is cleared, because a
 * credential id from another project is not valid here. Throws a ZodError for a bad file.
 */
export function parseImport(
  raw: unknown,
  known: { credentialIds: Iterable<string>; variableKeys: Iterable<string> },
): ParsedImport {
  const file = workflowExportSchema.parse(raw);
  const credentialIds = new Set(known.credentialIds);
  const clearedCredentials: string[] = [];
  const nodes = file.nodes.map((node) => {
    if (node.credentialId && !credentialIds.has(node.credentialId)) {
      clearedCredentials.push(node.name);
      return { ...node, credentialId: null };
    }
    return node;
  });
  const graph: Graph = { schema: 1, nodes, edges: file.edges };
  const have = new Set(known.variableKeys);
  const wanted = new Set([...(file.variables ?? []), ...variableKeysUsed(graph)]);
  return {
    name: file.name ?? null,
    graph,
    missingVariables: [...wanted].filter((key) => !have.has(key)).sort(),
    clearedCredentials,
  };
}
