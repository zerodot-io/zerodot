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

function isBinary(value: object): value is { data: string; mimeType: string; fileName?: string } {
  const record = value as Record<string, unknown>;
  return (
    typeof record.data === "string" &&
    typeof record.mimeType === "string" &&
    Object.keys(record).every((key) => key === "data" || key === "mimeType" || key === "fileName")
  );
}

/**
 * The result of a tool as the model gets it. A model cannot read base64 file data, so each binary
 * value becomes its type, file name, and size in bytes.
 */
export function withoutBinary(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBinary);
  if (value === null || typeof value !== "object") return value;
  if (isBinary(value)) {
    const padding = value.data.endsWith("==") ? 2 : value.data.endsWith("=") ? 1 : 0;
    return {
      mimeType: value.mimeType,
      ...(value.fileName !== undefined ? { fileName: value.fileName } : {}),
      size: Math.floor((value.data.length * 3) / 4) - padding,
    };
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withoutBinary(item)]));
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) =>
    same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * The action of `definition.actions` that the config of a node selects: each config value of
 * the action is the same in the node. When more than one matches, the action with the most
 * values wins, because it is the most exact one.
 */
export function actionOf(
  definition: Pick<NodeDefinition, "actions">,
  config: Record<string, unknown>,
): { label: string; config: Record<string, unknown> } | undefined {
  let found: { label: string; config: Record<string, unknown> } | undefined;
  for (const action of definition.actions ?? []) {
    const entries = Object.entries(action.config);
    if (entries.length === 0 || !entries.every(([key, value]) => same(config[key], value))) {
      continue;
    }
    if (!found || entries.length > Object.keys(found.config).length) found = action;
  }
  return found;
}

/**
 * What a node tool tells the model that it does. The tool does one action, so the label of that
 * action is better than the description of the whole node, for example "Send a message in Slack".
 */
export function toolDescription(
  node: Pick<GraphNode, "config" | "toolDescription">,
  definition: Pick<NodeDefinition, "actions" | "app" | "label" | "description" | "subtitle">,
): string {
  const written = node.toolDescription?.trim();
  if (written) return written;
  const action = actionOf(definition, node.config);
  if (action) return `${action.label} in ${definition.app ?? definition.label}`;
  const subtitle = definition.subtitle?.(node.config);
  return [definition.description, subtitle].filter(Boolean).join(". ") || definition.label;
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
