// SPDX-License-Identifier: AGPL-3.0-only
import { type FromAIType, fromAICalls } from "./expression";
import type { GraphNode } from "./graph";
import type { NodeDefinition } from "./node";

/** What a tool tells the model: its name, what it does, and the JSON Schema of its input. */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type?: string; description?: string }>;
    required: string[];
    additionalProperties: false;
  };
};

/** A node that runs as a tool, as the parent gets it on a supply port. */
export type NodeTool = {
  spec: ToolSpec;
  call(input: unknown, signal?: AbortSignal): Promise<unknown>;
};

function* texts(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* texts(item);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* texts(item);
  }
}

/**
 * The `$fromAI` keys of a node config, with the description and type of each. Throws when a call
 * is not in the literal form, or one key has two different descriptions or types.
 */
export function fromAIInputs(
  node: Pick<GraphNode, "config">,
  definition: Pick<NodeDefinition, "rawConfigKeys">,
): Map<string, { description: string; type: FromAIType }> {
  const rawKeys = new Set(definition.rawConfigKeys ?? []);
  const found = new Map<string, { description: string; type: FromAIType }>();
  for (const [key, value] of Object.entries(node.config)) {
    if (rawKeys.has(key)) continue;
    for (const text of texts(value)) {
      const { calls, invalid } = fromAICalls(text);
      if (invalid) {
        throw new Error(
          `config.${key}: write $fromAI("key", "description", "type") with text only. The type is string, number, boolean, or json`,
        );
      }
      for (const call of calls) {
        const known = found.get(call.key);
        if (!known) {
          found.set(call.key, { description: call.description, type: call.type });
          continue;
        }
        if (call.type !== known.type) {
          throw new Error(`$fromAI("${call.key}") has two types: ${known.type} and ${call.type}`);
        }
        if (call.description && known.description && call.description !== known.description) {
          throw new Error(`$fromAI("${call.key}") has two descriptions`);
        }
        if (!known.description) known.description = call.description;
      }
    }
  }
  return found;
}

/** The JSON Schema of the input of a node tool. "json" accepts any value. */
export function toolInputSchema(
  inputs: Map<string, { description: string; type: FromAIType }>,
): ToolSpec["inputSchema"] {
  const properties: ToolSpec["inputSchema"]["properties"] = {};
  for (const [key, { description, type }] of inputs) {
    properties[key] = {
      ...(type === "json" ? {} : { type }),
      ...(description ? { description } : {}),
    };
  }
  return { type: "object", properties, required: [...inputs.keys()], additionalProperties: false };
}

/** A tool name from a node name: letters, digits, _ and -, at most 64. Unique in `used`. */
export function toolName(nodeName: string, used: Set<string>): string {
  const base =
    nodeName
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "tool";
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}
