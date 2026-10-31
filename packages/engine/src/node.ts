// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from "zod";
import type { CodeLog, SandboxClient } from "./sandbox";
import type { ShowRules } from "./show-when";
import type { TableStore } from "./tables";

/** The workflow that a sub-workflow node runs: one of the organization, or a graph in the config. */
export type SubWorkflowSource =
  | { kind: "database"; workflowId: string }
  | { kind: "parameter"; graph: unknown };

export type SubWorkflowRunner = (
  source: SubWorkflowSource,
  input: unknown,
  options: { wait: boolean },
) => Promise<unknown>;

export type NodeCategory = "trigger" | "core" | "logic" | "data" | "flow" | "code" | "integration";

/** A credential after decryption. The type is the credential type, for example "http.bearer". */
export type ResolvedCredential = { type: string; data: Record<string, unknown> };

export type NodeRunContext<Config> = {
  /** Config with expressions resolved and checked against the Zod schema. */
  config: Config;
  /** Output data of the parent node. For a trigger node, the trigger input. */
  input: unknown;
  /** Decrypted credential, if the node has one. */
  credential: ResolvedCredential | null;
  signal: AbortSignal;
  /** Plain values that the expression language can read: $trigger, $node, $input, $vars, $run, $resumeUrl. */
  scope: Record<string, unknown>;
  /** Adds `console` logs of the node to the result of this node. They show in the run. */
  log?: (logs: CodeLog[]) => void;
  /** The code sandbox, or null when the worker has none. */
  sandbox: SandboxClient | null;
  /** Data tables of the project, or null when the worker has none. */
  tables: TableStore | null;
  /**
   * Address that answers this node while it waits. A person opens it, and the run goes on with
   * their answer as the node output. Not set when the worker does not know the public address.
   */
  resumeUrl?: string | null;
  /**
   * Runs another workflow of the same organization with `input` as its trigger input. With
   * `wait: true` it returns the output of the last node that ran. With `wait: false` it only
   * starts the run and returns `{ runId }`. Null when the worker cannot run a sub-workflow.
   */
  runWorkflow?: SubWorkflowRunner | null;
  /**
   * True when the data came back along a loop: the edge into this node starts at a node that
   * this node feeds, directly or through other nodes. False for a first entry and for a trigger.
   */
  loopBack?: boolean;
  /**
   * What this node returned as `state` the last time it ran in this run. Only for a node with
   * `stateful: true`. It is not kept when the run stops, because the engine builds it again.
   */
  state?: unknown;
  /**
   * Values of the supply nodes connected to the `supplyPorts` of this node, by port name. A port
   * with `multiple: true` gives a list (it can be empty). A single port with no node is not set.
   */
  supplies?: Record<string, unknown>;
};

/** A port at the bottom of a node. Supply nodes of the same `kind` connect to it. */
export type SupplyPort = {
  name: string;
  /** The kind of value, for example "ai.model". It matches `supplies` of a supply node. */
  kind: string;
  label: string;
  /** The node cannot run without a supply node here. */
  required?: boolean;
  /** More than one supply node can connect. The node then gets a list. */
  multiple?: boolean;
};

/**
 * What a supply node gets when its parent runs. Expressions in the config are resolved with the
 * scope of the parent, so `$input` is the input of the parent.
 */
export type SupplyContext<Config> = {
  config: Config;
  /** The credential of the supply node. */
  credential: ResolvedCredential | null;
  /** The signal of the run. */
  signal: AbortSignal;
  /** The scope of the parent. */
  scope: Record<string, unknown>;
  /** Adds logs to the parent node, with the name of the supply node in front. */
  log?: (logs: CodeLog[]) => void;
  sandbox: SandboxClient | null;
  tables: TableStore | null;
  runWorkflow?: SubWorkflowRunner | null;
  /** The supply node. */
  node: { id: string; name: string };
  /**
   * Values of the supply nodes connected to the `supplyPorts` of this supply node, by port name,
   * as in `NodeRunContext.supplies`.
   */
  supplies?: Record<string, unknown>;
};

export const FORM_FIELD_TYPES = [
  "text",
  "number",
  "email",
  "textarea",
  "dropdown",
  "checkbox",
  "radio",
  "password",
  "date",
] as const;

/** A field of the page that a person fills in to answer a node that waits. */
export type WaitFormField = {
  fieldLabel: string;
  /** The key of the answer in the output. Default: the label. */
  key?: string;
  fieldType?: (typeof FORM_FIELD_TYPES)[number];
  placeholder?: string;
  requiredField?: boolean;
  /** For dropdown, checkbox, and radio. */
  fieldOptions?: { values: { option: string }[] };
};

export type WaitForm = {
  title?: string;
  description?: string;
  buttonLabel?: string;
  fields: WaitFormField[];
};

export type NodeResult = {
  port: string;
  data: unknown;
  /**
   * Epoch ms. The node is done, but the run must not go on before this time.
   * The engine stops the run and the worker resumes it later. Nothing waits in memory.
   */
  waitUntil?: number;
  /**
   * The answer to the HTTP request that started the run. A "respond to webhook" node sets it.
   * The worker passes it to the web app, which holds the request open.
   */
  respond?: RunResponse;
  /**
   * Kept in memory for the next run of this node in the same run (a loop). Only for a node with
   * `stateful: true`. It never goes to the database.
   */
  state?: unknown;
};

/** The answer to a webhook request: status, headers, and body. */
export type RunResponse = { status: number; headers: Record<string, string>; body: unknown };

/** A request to the webhook address of a trigger: `/hooks/:token`. */
export type WebhookRequest = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** The body as text, before it was parsed. */
  rawBody?: string;
  /** The body bytes as base64. The Webhook node saves them as binary data. */
  bodyBase64?: string;
  /** The address of the caller. Set only when the server trusts the proxy headers. */
  ip?: string | null;
};

/** What a trigger node says about a request. `response` replaces the default answer of the route. */
export type WebhookVerdict =
  | { verdict: "accept"; input: unknown; response?: { status: number; body: unknown } }
  | { verdict: "ignore"; response?: { status: number; body: unknown } }
  | { verdict: "forbidden"; status?: number; headers?: Record<string, string> };

/** What a trigger node gets when it handles a request, or when its workflow starts or stops. */
export type WebhookContext<Config = Record<string, unknown>> = {
  config: Config;
  credential: ResolvedCredential | null;
  /** Address of the webhook of this trigger, for example `https://zerodot.example/hooks/abc`. */
  url: string;
  workflow: { id: string; name: string };
  node: { id: string; name: string };
  /** Data that the node kept before. A node writes it by returning it from `activate` or `deactivate`. */
  state: unknown;
  signal: AbortSignal;
};

/**
 * A trigger that gets requests at its webhook address. `receive` checks a request and gives the
 * trigger input of the run. `activate` and `deactivate` register and remove the webhook at
 * another service. They return the new `state`.
 */
export type NodeWebhook = {
  receive(ctx: WebhookContext & { request: WebhookRequest }): Promise<WebhookVerdict>;
  activate?(ctx: WebhookContext): Promise<unknown>;
  deactivate?(ctx: WebhookContext): Promise<unknown>;
};

/** What a polling trigger gets on each tick. */
export type PollContext<Config = Record<string, unknown>> = {
  config: Config;
  credential: ResolvedCredential | null;
  /** What the last poll returned as `cursor`. Null on the first poll after activation. */
  cursor: unknown;
  /** True on the first poll after activation. The items of this poll start no runs. */
  firstPoll: boolean;
  workflow: { id: string; name: string };
  node: { id: string; name: string };
  signal: AbortSignal;
};

/** One new thing at another service. Each item starts one run. */
export type PollItem = {
  /** Stable id of the item. The engine skips a key it has seen, so the same item starts one run. */
  key: string;
  /** The trigger input of the run. */
  data: unknown;
};

export type PollResult = {
  /** New items, oldest first. */
  items: PollItem[];
  /** Kept and given back to the next poll. Not changed when the poll throws. */
  cursor: unknown;
};

/** What a listening trigger gets when the worker starts it. */
export type ListenContext<Config = Record<string, unknown>> = {
  config: Config;
  credential: ResolvedCredential | null;
  workflow: { id: string; name: string };
  node: { id: string; name: string };
  /** Aborts when the worker stops. */
  signal: AbortSignal;
  /**
   * Starts one production run. The `key` is stable for one event, so the same event starts
   * one run. Resolves when the run is stored. Throws when the run cannot be stored.
   */
  emit(item: PollItem): Promise<void>;
  /** Reports a problem of the connection. The trigger shows it as its last error. */
  fail(error: Error): void;
};

/** What a listening trigger gives back. The worker calls `close` when the trigger stops. */
export type ListenHandle = {
  /**
   * `remove` is true when the workflow is not active any more, or the trigger changed. The node
   * then removes what it made at another service. It is false when only the worker stops.
   */
  close(options: { remove: boolean }): Promise<void>;
};

/** The most items one poll may return. A poll that returns more fails and the cursor stays. */
export const POLL_MAX_ITEMS = 1000;

export type NodeDefinition<Schema extends z.ZodType = z.ZodType> = {
  type: string;
  label: string;
  /** One line under the name in the Add node list. */
  description?: string;
  category: NodeCategory;
  /**
   * Rows of the Add node list for this node, one for each thing it does, for example one for each
   * operation. A row adds the node with `config` on top of the default config.
   */
  actions?: { label: string; config: Record<string, unknown> }[];
  /** App the node belongs to, for example "Postgres". The Add node list shows one row for the app. */
  app?: string;
  /** Name of a Hugeicons icon, for example "Globe02Icon". The editor shows it. */
  icon: string;
  /** Image of the node, as a data URL. The editor shows it in place of `icon`. */
  iconUrl?: string;
  config: Schema;
  /** Config for a node that the user just added. */
  defaultConfig: z.input<Schema>;
  /** Credential types this node accepts. The user picks one credential of these types. */
  credentialTypes?: string[];
  /**
   * When a credential type applies, by config value. For example `{ "http.basic": { showWhen:
   * { authentication: ["basic"] } } }`. A type with no rule always applies. The editor shows only
   * the types that apply. The run accepts every type in `credentialTypes`.
   */
  credentialRules?: Record<string, ShowRules>;
  /** Short text under the node name in the editor. Config can hold unresolved expressions. */
  subtitle?(config: Record<string, unknown>): string | undefined;
  ports: { in: string[]; out: string[] };
  /**
   * Input ports that depend on the config (a merge node has one port for each input). Without
   * it the node has `ports.in`. An edge into a port that this list does not have is ignored by
   * the engine and reported by the graph check.
   */
  inPorts?(config: Record<string, unknown>): string[];
  /**
   * A join node waits for all of its parents. Its input is an object with the data of each
   * input port, for example `{ input1, input2 }`. A parent that was skipped sends no data.
   */
  join?: boolean;
  /**
   * The node keeps `state` between its runs in one run (a loop counter). When a stopped run
   * goes on, the engine runs the node again with its saved inputs to build the state again, and
   * keeps the saved result. So `run` must have no side effects and must give the same answer for
   * the same inputs.
   */
  stateful?: boolean;
  /** Config keys (top level) whose text is not an expression. The engine leaves `{{ }}` as it is. */
  rawConfigKeys?: string[];
  /**
   * For a node that waits for a person: the form that the resume page shows, or null when
   * the node needs no form (a click on a button is the answer, as `?approved=true`).
   */
  waitForm?(config: Record<string, unknown>): WaitForm | null;
  /**
   * For a node that waits for an HTTP call to its resume address. Returns true when the config
   * asks for it. Any method works. The method, headers, query, and body of the call are the
   * node output. The address is also in the expression scope as `$resumeUrl["Node name"]`.
   */
  waitsForCallback?(config: Record<string, unknown>): boolean;
  /** For a trigger node with a webhook that needs its own checks or registration. */
  webhook?: NodeWebhook;
  /**
   * For a trigger whose `webhook.activate` registers the address at another service. A test run
   * in the editor then calls `activate` with the test address, and sets the production address
   * back (or calls `deactivate`) when the test ends. A person does not call the test address, so
   * the editor shows `hint` where the Webhook node shows its address. Plain data: the catalog has it.
   */
  webhookTest?: { hint: string };
  /**
   * For a trigger node that asks another service for news. The worker calls it on a timer
   * (config key `intervalSeconds`, in seconds) while the workflow is active.
   */
  poll?(ctx: PollContext<z.output<Schema>>): Promise<PollResult>;
  /**
   * For a trigger node that gets events through a connection that stays open. The worker calls
   * it when the workflow is active, and keeps the handle until the trigger stops.
   */
  listen?(ctx: ListenContext<z.output<Schema>>): Promise<ListenHandle>;
  /** Output ports that depend on the config (a switch has one port for each case). */
  outPorts?(config: Record<string, unknown>): string[];
  /**
   * Ports at the bottom of the node. The values of the supply nodes connected to them are in
   * `ctx.supplies` when the node runs.
   */
  supplyPorts?: SupplyPort[];
  /**
   * The kind of value this node gives, for example "ai.model". A supply node has no in or out
   * ports and is never a step: it builds a value with `supply` each time its parent runs.
   */
  supplies?: string;
  /**
   * The node can connect to a supply port of kind `TOOL_KIND` and run as a tool: the model fills
   * the config values that use `$fromAI`. Default: true for an "integration" node.
   */
  usableAsTool?: boolean;
  // Method syntax keeps parameter bivariance, so a typed node fits the registry type.
  /**
   * Builds the value of a supply node. The engine builds it one time for the run when the config
   * and the credential use no `$input`, `$node`, or `$fromAI` (nor do the supply nodes under it).
   * Otherwise it builds it for each run of the parent. When the value has a `close()` function,
   * the engine calls it when the value is not used again: at the end of the run, or when the
   * parent is done.
   */
  supply?(ctx: SupplyContext<z.output<Schema>>): unknown;
  /** A supply node made with `defineSupplyNode` gets a `run` that throws. It is never called. */
  run(ctx: NodeRunContext<z.output<Schema>>): Promise<NodeResult> | NodeResult;
};

/** The output ports of a node with this config. */
export function outputPortsOf(
  definition: Pick<NodeDefinition, "ports" | "outPorts">,
  config: Record<string, unknown>,
): string[] {
  try {
    return definition.outPorts?.(config) ?? definition.ports.out;
  } catch {
    return definition.ports.out;
  }
}

/** The input ports of a node with this config. */
export function inputPortsOf(
  definition: Pick<NodeDefinition, "ports" | "inPorts">,
  config: Record<string, unknown>,
): string[] {
  try {
    return definition.inPorts?.(config) ?? definition.ports.in;
  } catch {
    return definition.ports.in;
  }
}

export function defineNode<Schema extends z.ZodType>(
  definition: NodeDefinition<Schema>,
): NodeDefinition<Schema> {
  return definition;
}

/** The supply kind of a tool. A port of this kind also takes nodes that can be tools. */
export const TOOL_KIND = "ai.tool";

/** True when a node can run as a tool (see `usableAsTool`). Supply nodes and triggers cannot. */
export function canBeTool(
  definition: Pick<NodeDefinition, "supplies" | "category" | "usableAsTool" | "join">,
): boolean {
  if (definition.supplies !== undefined || definition.category === "trigger") return false;
  // A join node waits for all of its parents. A tool call has one input only.
  if (definition.join) return false;
  return definition.usableAsTool ?? definition.category === "integration";
}

/**
 * Defines a supply node: it has no ports and no step. It gives a value of the kind `supplies`
 * to the supply ports of other nodes (see `supply`).
 */
export function defineSupplyNode<Schema extends z.ZodType>(
  definition: Omit<NodeDefinition<Schema>, "run" | "ports" | "supplies" | "supply"> & {
    supplies: string;
    supply(ctx: SupplyContext<z.output<Schema>>): unknown;
  },
): NodeDefinition<Schema> {
  return {
    ...definition,
    ports: { in: [], out: [] },
    run: () => {
      throw new Error("A supply node does not run as a step");
    },
  };
}

export type NodeRegistry = ReadonlyMap<string, NodeDefinition>;

export function createRegistry(definitions: NodeDefinition[]): NodeRegistry {
  const map = new Map<string, NodeDefinition>();
  for (const definition of definitions) {
    if (map.has(definition.type)) throw new Error(`Duplicate node type "${definition.type}"`);
    map.set(definition.type, definition);
  }
  return map;
}
