// SPDX-License-Identifier: AGPL-3.0-only
import { type FromAIType, fromAICalls } from "./expression";
import type { GraphNode } from "./graph";
import type { NodeDefinition } from "./node";

/** The JSON Schema of one input of a tool. */
export type ToolInputProperty = {
  type?: string;
  description?: string;
  default?: unknown;
  anyOf?: Record<string, unknown>[];
};

/** What a tool tells the model: its name, what it does, and the JSON Schema of its input. */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolInputProperty>;
    required: string[];
    additionalProperties: false;
  };
};

/** A node that runs as a tool, as the parent gets it on a supply port. */
export type NodeTool = {
  spec: ToolSpec;
  call(input: unknown, signal?: AbortSignal): Promise<unknown>;
};

/** A `$fromAI` key: 1 to 64 letters, digits, underscores, or hyphens. */
const FROM_AI_KEY = /^[a-zA-Z0-9_-]{1,64}$/;

/** One input of a node tool. */
export type FromAIInput = { description: string; type: FromAIType; defaultValue?: unknown };

function* texts(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* texts(item);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* texts(item);
  }
}

/**
 * The `$fromAI` keys of a node config, with the description, type, and default of each. Throws
 * when a call cannot be read, a key is not valid, or one key has two descriptions or types. When
 * a key is used more than once, the last call gives the default.
 */
export function fromAIInputs(
  node: Pick<GraphNode, "config">,
  definition: Pick<NodeDefinition, "rawConfigKeys">,
): Map<string, FromAIInput> {
  const rawKeys = new Set(definition.rawConfigKeys ?? []);
  const found = new Map<string, FromAIInput>();
  for (const [key, value] of Object.entries(node.config)) {
    if (rawKeys.has(key)) continue;
    for (const text of texts(value)) {
      const { calls, error } = fromAICalls(text);
      if (error !== undefined) throw new Error(`config.${key}: ${error}`);
      for (const call of calls) {
        if (call.key === "") {
          throw new Error(`config.${key}: You must specify a key when using $fromAI()`);
        }
        if (!FROM_AI_KEY.test(call.key)) {
          throw new Error(
            `config.${key}: Parameter key \`${call.key}\` is invalid. A key has 1 to 64 letters, numbers, underscores, or hyphens`,
          );
        }
        const known = found.get(call.key);
        if (known && (known.description !== call.description || known.type !== call.type)) {
          throw new Error(
            `Duplicate key '${call.key}' found with different description or type. Give all $fromAI() calls with the same key the same description and type`,
          );
        }
        found.set(call.key, {
          description: call.description,
          type: call.type,
          ...(call.defaultValue === undefined ? {} : { defaultValue: call.defaultValue }),
        });
      }
    }
  }
  return found;
}

/**
 * The JSON Schema of the input of a node tool. A key with a default value is optional. "json"
 * takes an object with at least one key or a list with at least one item.
 */
export function toolInputSchema(inputs: Map<string, FromAIInput>): ToolSpec["inputSchema"] {
  const properties: ToolSpec["inputSchema"]["properties"] = {};
  const required: string[] = [];
  for (const [key, { description, type, defaultValue }] of inputs) {
    properties[key] = {
      ...(type === "json"
        ? {
            anyOf: [
              { type: "object", minProperties: 1 },
              { type: "array", minItems: 1 },
            ],
          }
        : { type }),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
    };
    if (defaultValue === undefined) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/**
 * The input that the model gave a tool, checked against its keys, with the defaults added and
 * other keys left out.
 * Throws with each problem, so the model can call the tool again with good input.
 */
export function checkToolInput(
  inputs: Map<string, FromAIInput>,
  given: unknown,
): Record<string, unknown> {
  const values =
    given !== null && typeof given === "object" && !Array.isArray(given)
      ? { ...(given as Record<string, unknown>) }
      : {};
  const problems: string[] = [];
  for (const [key, { type, defaultValue }] of inputs) {
    const value = values[key];
    if (value === undefined) {
      if (defaultValue === undefined) problems.push(`"${key}" is required`);
      else values[key] = defaultValue;
      continue;
    }
    const fits =
      type === "json"
        ? Array.isArray(value)
          ? value.length > 0
          : value !== null && typeof value === "object" && Object.keys(value).length > 0
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : typeof value === type;
    if (!fits) {
      problems.push(
        type === "json"
          ? `"${key}" must be a non-empty object or a non-empty array`
          : `"${key}" must be a ${type}`,
      );
    }
  }
  // Keys that are not inputs are left out, as a schema check that strips them does.
  for (const key of Object.keys(values)) if (!inputs.has(key)) delete values[key];
  if (problems.length > 0) throw new Error(`The tool input is not valid: ${problems.join("; ")}`);
  return values;
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
