// SPDX-License-Identifier: AGPL-3.0-only
import { type BlobStore, containsBlobRef, hydrate } from "./blob";
import {
  credentialRefsUsed,
  ExpressionError,
  resolveConfig,
  StrictRecord,
  ToolInput,
} from "./expression";
import {
  flowEdges,
  type Graph,
  type GraphEdge,
  type GraphNode,
  isSupplyEdge,
  isTriggerType,
  supplyPortOf,
  validateGraph,
} from "./graph";
import {
  canBeTool,
  inputPortsOf,
  type NodeDefinition,
  type NodeRegistry,
  outputPortsOf,
  type ResolvedCredential,
  type RunResponse,
  type SubWorkflowRunner,
  TOOL_KIND,
} from "./node";
import type { CodeLog, SandboxClient } from "./sandbox";
import { type SupplyCall, type SupplyUseStatus, trackUse } from "./supply-use";
import type { TableStore } from "./tables";
import {
  fromAIInputs,
  type NodeTool,
  toolDescription,
  toolInputSchema,
  toolName,
  withoutBinary,
} from "./tool";

export type NodeStatus = "running" | "waiting" | "succeeded" | "failed" | "skipped";

export type StoredNodeResult = {
  nodeId: string;
  attempt: number;
  status: NodeStatus;
  port: string | null;
  output: unknown;
};

export type NodeEvent = {
  node: GraphNode;
  attempt: number;
};

export type NodeEndEvent = NodeEvent & {
  status: Exclude<NodeStatus, "running">;
  port: string | null;
  input: unknown;
  output: unknown;
  error: { message: string; path?: string } | null;
  durationMs: number;
  /** True when the output came from pinned data. */
  pinned: boolean;
  /** The answer that a node gave to the webhook request of the run. */
  respond?: RunResponse;
  /** The `console` calls of the node (a Code node). Also set when the node failed. */
  logs?: CodeLog[];
};

export type RunStatus = "succeeded" | "failed" | "cancelled";

/** Persistence, live events, logging, and error workflows are hook implementations. */
export type ExecutionHooks = {
  onRunStart?(): void | Promise<void>;
  beforeNode?(event: NodeEvent & { input: unknown }): void | Promise<void>;
  afterNode?(event: NodeEndEvent): void | Promise<void>;
  /**
   * A supply node or a tool of a running node is in use: its value got a call ("running"), or
   * its last open call ended. Supply nodes are no steps, so this is their only live status.
   */
  onSupplyUse?(event: {
    node: GraphNode;
    parentId: string;
    status: SupplyUseStatus;
    /** The call that ended, with its input and output. Not set when a call starts. */
    call?: SupplyCall;
  }): void | Promise<void>;
  /** The run stops here and the worker resumes it at `resumeAt` (epoch ms). */
  onRunWait?(event: { resumeAt: number; nodeId: string }): void | Promise<void>;
  onRunEnd?(event: {
    status: RunStatus;
    error: { message: string; nodeId?: string } | null;
    failedNodeId: string | null;
  }): void | Promise<void>;
};

/**
 * Test runs can stop early. `to` runs the path from the trigger to the node and stops after it.
 * `only` runs one node with the given input. `outputs` are the last known outputs of the other
 * nodes, so expressions that read `$node["Name"]` still work.
 */
export type ExecuteTarget =
  | { kind: "to"; nodeId: string }
  | {
      kind: "only";
      nodeId: string;
      input: unknown;
      outputs: Record<string, { port: string; data: unknown }>;
    };

export type ExecuteOptions = {
  graph: Graph;
  registry: NodeRegistry;
  /** Data from the trigger. */
  triggerInput: unknown;
  mode: "production" | "test";
  signal: AbortSignal;
  /** Results saved by an earlier attempt of this run. Succeeded nodes are skipped. */
  previousResults?: StoredNodeResult[];
  /** Start at this trigger node. Default: the first trigger node. */
  startNodeId?: string;
  /** Test runs only. Stop at a node, or run one node. */
  target?: ExecuteTarget;
  hooks?: ExecutionHooks[];
  variables?: Record<string, unknown>;
  env?: Record<string, string>;
  run?: { id: string; startedAt: string };
  /**
   * Opens a credential. `by: "idOrName"` is for a `credentialExpression`: the text is an id or the
   * name of a credential of the project.
   */
  credentials?: (credential: string, by?: "id" | "idOrName") => Promise<ResolvedCredential | null>;
  /** Runs code for the `code.js` node. */
  sandbox?: SandboxClient;
  /** Reads and writes data tables for the `table.*` nodes. */
  tables?: TableStore;
  /** The address that answers a waiting node. The worker signs it. */
  resumeUrl?: (nodeId: string) => string | null;
  /** Runs another workflow for the `flow.execute_workflow` node. Returns its last node output. */
  runWorkflow?: SubWorkflowRunner;
  /** A node output above this size fails the node. */
  maxOutputBytes?: number;
  /**
   * Reads blobs. A resumed run gets saved data with blob references. Before a node runs, its
   * input and the saved outputs it can read are changed back to base64 data. Without a store,
   * the references stay as they are.
   */
  blobs?: BlobStore;
  /** The most node runs in one run. A loop that does not end hits this limit. Default 1000. */
  maxNodeRuns?: number;
  /** Wait between node retries. Tests replace it. */
  sleep?: (ms: number) => Promise<void>;
};

export type ExecuteResult =
  | { status: RunStatus; error: { message: string; nodeId?: string } | null }
  | { status: "waiting"; resumeAt: number; error: null };

type Output = { port: string; data: unknown };

function toError(error: unknown): { message: string; path?: string } {
  if (error instanceof ExpressionError) {
    return error.path ? { message: error.detail, path: error.path } : { message: error.detail };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}

/** Text values of a credential. They must not appear in a stored error. */
function secretValues(data: unknown, found: string[] = []): string[] {
  if (typeof data === "string") {
    if (data.length >= 4) found.push(data);
  } else if (Array.isArray(data)) {
    for (const item of data) secretValues(item, found);
  } else if (data !== null && typeof data === "object") {
    for (const item of Object.values(data)) secretValues(item, found);
  }
  return found;
}

function scrubError(error: { message: string; path?: string }, secrets: string[]) {
  if (secrets.length === 0) return error;
  let message = error.message;
  // Longest first, so a secret that holds another secret is removed whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    message = message.split(secret).join("***");
  }
  return error.path ? { message, path: error.path } : { message };
}

/** The secret as it can appear in a URL: raw and percent-encoded. */
function secretForms(value: string): string[] {
  const encoded = encodeURIComponent(value);
  return encoded === value ? [value] : [value, encoded];
}

/** A copy of a value where each secret in any text is now `***`. Keys and other types stay. */
function maskSecrets<T>(value: T, secrets: string[]): T {
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) text = text.split(secret).join("***");
      return text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (
      item !== null &&
      typeof item === "object" &&
      Object.getPrototypeOf(item) === Object.prototype
    ) {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    }
    return item;
  };
  return walk(value) as T;
}

/** Scope keys that keep their value for the whole run. */
const STATIC_SCOPE_KEYS = new Set(["$vars", "$env", "$credentials", "$trigger", "$run"]);

function hasClose(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function* configTexts(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const item of value) yield* configTexts(item);
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) yield* configTexts(item);
  }
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function executeGraph(options: ExecuteOptions): Promise<ExecuteResult> {
  const { registry, signal } = options;
  validateGraph(options.graph);
  // Supply edges carry no data. The walk sees the flow edges only, so a supply node never runs
  // as a step. Its parent builds its value (see `suppliesFor`).
  const graph: Graph = { ...options.graph, edges: flowEdges(options.graph) };
  const supplyEdges = options.graph.edges.filter(isSupplyEdge);
  const hooks = options.hooks ?? [];
  const sleep = options.sleep ?? defaultSleep;
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const outputs = new Map<string, Output>();
  const attempts = new Map<string, number>();
  /** `state` that stateful nodes returned. It lives in memory for one pass of the walk. */
  const nodeState = new Map<string, unknown>();

  const target = options.target;
  const targetNode = target ? nodesById.get(target.nodeId) : undefined;
  if (target && !targetNode) {
    return { status: "failed", error: { message: `The node "${target.nodeId}" does not exist` } };
  }
  // With a `to` target, the walk follows only the nodes that lead to the node. A node can have
  // more than one parent, and a loop makes a node its own ancestor, so this walks the edges back.
  const pathIds = new Set<string>();
  if (target?.kind === "to") {
    const queue = [target.nodeId];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      if (pathIds.has(id)) continue;
      pathIds.add(id);
      for (const edge of graph.edges) if (edge.to === id) queue.push(edge.from);
    }
  }

  const start =
    target?.kind === "only"
      ? targetNode
      : options.startNodeId
        ? nodesById.get(options.startNodeId)
        : graph.nodes.find((n) => isTriggerType(n.type));
  // A named start node can be any node that no edge leads into: a workflow with no trigger runs
  // from another workflow.
  const startOk =
    start &&
    (target?.kind === "only" ||
      isTriggerType(start.type) ||
      (options.startNodeId !== undefined && !graph.edges.some((e) => e.to === start.id)));
  if (!start || !startOk) {
    return { status: "failed", error: { message: "The graph has no trigger node" } };
  }

  // A node can run more than once in a run (a loop, or a join). A resumed run replays the saved
  // results of each node in order, so the same walk gives the same data and no node runs twice.
  // A waiting result keeps what the node will send when the wait is over.
  type Replay =
    | { status: "succeeded"; attempt: number; port: string; data: unknown }
    | { status: "waiting"; attempt: number; resumeAt: number; port: string; data: unknown };
  const replays = new Map<string, Replay[]>();
  const sortedPrevious = [...(options.previousResults ?? [])].sort((a, b) => a.attempt - b.attempt);
  for (const previous of sortedPrevious) {
    attempts.set(previous.nodeId, Math.max(attempts.get(previous.nodeId) ?? 0, previous.attempt));
    let entry: Replay | undefined;
    if (previous.status === "succeeded" && previous.port) {
      entry = {
        status: "succeeded",
        attempt: previous.attempt,
        port: previous.port,
        data: previous.output,
      };
    } else if (previous.status === "waiting" && previous.port) {
      const stored = previous.output as { resumeAt: number; data: unknown };
      entry = {
        status: "waiting",
        attempt: previous.attempt,
        resumeAt: stored.resumeAt,
        port: previous.port,
        data: stored.data,
      };
    }
    if (entry) replays.set(previous.nodeId, [...(replays.get(previous.nodeId) ?? []), entry]);
  }
  const maxNodeRuns = options.maxNodeRuns ?? 1000;
  let nodeRuns = 0;

  // Saved outputs that still hold blob references. They are read from the store only when a
  // node runs, so a replay of many nodes does not load every file.
  const unhydrated = new Set<string>();
  const hydrateValue = async (value: unknown): Promise<unknown> =>
    options.blobs && containsBlobRef(value) ? hydrate(value, options.blobs) : value;
  const hydrateSaved = async () => {
    for (const id of [...unhydrated]) {
      unhydrated.delete(id);
      const output = outputs.get(id);
      if (output) outputs.set(id, { port: output.port, data: await hydrateValue(output.data) });
    }
  };

  if (target?.kind === "only") {
    for (const [id, output] of Object.entries(target.outputs)) {
      if (id !== target.nodeId && nodesById.has(id)) outputs.set(id, output);
    }
  }

  const call = async <K extends keyof ExecutionHooks>(
    name: K,
    ...args: Parameters<NonNullable<ExecutionHooks[K]>>
  ) => {
    for (const hook of hooks) {
      const fn = hook[name] as ((...a: typeof args) => void | Promise<void>) | undefined;
      await fn?.call(hook, ...args);
    }
  };

  /** The resume address of each node that waits for a callback, by node name. */
  const resumeUrls: Record<string, string> = {};
  if (options.resumeUrl) {
    for (const node of graph.nodes) {
      const url = registry.get(node.type)?.waitsForCallback?.(node.config)
        ? options.resumeUrl(node.id)
        : null;
      if (url) resumeUrls[node.name] = url;
    }
  }

  const scopeFor = (input: unknown): Record<string, unknown> => {
    const byName: Record<string, { data: unknown }> = {};
    for (const [id, output] of outputs) {
      const node = nodesById.get(id);
      if (node) byName[node.name] = { data: output.data };
    }
    return {
      $trigger: options.triggerInput,
      $node: byName,
      $input: input,
      $vars: new StrictRecord("Variable", options.variables ?? {}),
      $env: options.env ?? {},
      $run: options.run ?? { id: "", startedAt: "" },
      $resumeUrl: new StrictRecord("Resume URL", resumeUrls),
    };
  };

  /** The config of a node with its expressions resolved and checked. */
  const configFor = (
    node: GraphNode,
    definition: NodeDefinition,
    scope: Record<string, unknown>,
  ) => {
    const rawKeys = new Set(definition.rawConfigKeys ?? []);
    return definition.config.parse(
      Object.fromEntries(
        Object.entries(node.config).map(([key, value]) => [
          key,
          rawKeys.has(key) ? value : resolveConfig(value, scope, `config.${key}`),
        ]),
      ),
    );
  };

  /** The `scope` that a node gets in its run context. */
  const runScope = (scope: Record<string, unknown>, input: unknown) => ({
    $trigger: options.triggerInput,
    $node: scope.$node,
    $input: input,
    $vars: options.variables ?? {},
    $run: scope.$run,
    $resumeUrl: resumeUrls,
  });

  /**
   * The config and the credential of a node, with `scope`. Adds the values of `$credentials`
   * fields to `masked` and each credential value to `secrets`.
   */
  const resolveNode = async (
    node: GraphNode,
    definition: NodeDefinition,
    scope: Record<string, unknown>,
    secrets: string[],
    masked: string[],
  ) => {
    const refs = new Map<string, Set<string>>();
    const rawKeys = new Set(definition.rawConfigKeys ?? []);
    for (const [key, value] of Object.entries(node.config)) {
      if (rawKeys.has(key)) continue;
      for (const text of configTexts(value)) {
        const found = credentialRefsUsed(text);
        if (found.invalid) {
          // A credential with no field: name the fields it has. Names only, no values.
          const bare = /\$credentials\[\s*(?:"([^"]+)"|'([^']+)')\s*\](?!\s*(?:\.|\[))/.exec(text);
          const bareName = bare?.[1] ?? bare?.[2];
          const opened = bareName ? await options.credentials?.(bareName, "idOrName") : null;
          if (bareName && opened) {
            throw new Error(
              `Add a field to $credentials["${bareName}"]. Fields: ${Object.keys(opened.data).join(", ")}`,
            );
          }
          throw new Error(
            'Write a credential field as $credentials["name"].field. The name must be text, not an expression',
          );
        }
        for (const ref of found.refs) {
          refs.set(ref.name, (refs.get(ref.name) ?? new Set()).add(ref.field));
        }
      }
    }
    let configScope = scope;
    if (refs.size > 0) {
      const byName: Record<string, StrictRecord> = {};
      const added: string[] = [];
      for (const [name, fields] of refs) {
        const opened = await options.credentials?.(name, "idOrName");
        if (!opened) throw new Error(`The credential "${name}" does not exist`);
        const values: Record<string, unknown> = {};
        for (const field of fields) {
          if (!Object.hasOwn(opened.data, field)) continue;
          const value = opened.data[field];
          values[field] = value;
          if (typeof value === "string" && value.length >= 4) added.push(...secretForms(value));
        }
        byName[name] = new StrictRecord(`Field of credential "${name}"`, values);
      }
      masked.push(...added);
      masked.sort((a, b) => b.length - a.length);
      secrets.push(...added);
      configScope = { ...scope, $credentials: new StrictRecord("Credential", byName) };
    }
    const config = configFor(node, definition, configScope);
    let credential: ResolvedCredential | null = null;
    if (node.credentialExpression || node.credentialId) {
      if (node.credentialExpression) {
        const ref = resolveConfig(node.credentialExpression, scope, "credentialExpression");
        if (typeof ref !== "string" || ref.trim() === "") {
          throw new Error("The credential expression must give the id or the name of a credential");
        }
        credential = (await options.credentials?.(ref.trim(), "idOrName")) ?? null;
        if (!credential) throw new Error(`The credential "${ref.trim()}" does not exist`);
      } else {
        credential = (await options.credentials?.(node.credentialId as string, "id")) ?? null;
        if (!credential) throw new Error("The credential of this node does not exist");
      }
      const allowed = definition.credentialTypes;
      if (!allowed?.includes(credential.type)) {
        throw new Error(`This node does not accept a credential of type "${credential.type}"`);
      }
      secrets.push(...secretValues(credential.data));
    }
    return { config, credential };
  };

  /**
   * Supply values that stay the same for the whole run, by supply node id. With the credential
   * values of the node, so a parent that gets a value from here masks them too.
   */
  const supplyCache = new Map<string, { value: unknown; secrets: string[]; masked: string[] }>();
  /** Supply values with a `close` function that live to the end of the run, in build order. */
  const runClosers: unknown[] = [];

  /**
   * True when the value of a supply node is the same for each parent run: its config and its
   * credential use no expression that changes in the run (`$input`, `$node`, `$fromAI`), and the
   * same is true for the supply nodes under it. A tool on its ports changes with the input.
   */
  const staticSupply = (
    node: GraphNode,
    definition: NodeDefinition,
    seen: Set<string>,
  ): boolean => {
    if (seen.has(node.id)) return false;
    const rawKeys = new Set(definition.rawConfigKeys ?? []);
    const texts = [
      ...Object.entries(node.config).flatMap(([key, value]) =>
        rawKeys.has(key) ? [] : [...configTexts(value)],
      ),
      ...(node.credentialExpression ? [node.credentialExpression] : []),
    ];
    for (const text of texts) {
      if (!text.includes("{{")) continue;
      for (const [name] of text.matchAll(/\$[A-Za-z_]\w*/g)) {
        if (!STATIC_SCOPE_KEYS.has(name)) return false;
      }
    }
    const inner = new Set(seen).add(node.id);
    return supplyEdges
      .filter((e) => e.to === node.id)
      .every((e) => {
        const child = nodesById.get(e.from);
        if (!child || child.disabled) return true;
        const childDefinition = registry.get(child.type);
        return childDefinition?.supply !== undefined && staticSupply(child, childDefinition, inner);
      });
  };

  /** Calls `close` of each value, the last built first. An error does not stop the others. */
  const closeAll = async (values: unknown[]) => {
    for (const value of values.splice(0).reverse()) {
      try {
        await (value as { close(): unknown }).close();
      } catch {
        // The run has its result. A supply that cannot close does not change it.
      }
    }
  };

  /**
   * Builds the values of the supply nodes connected to the supply ports of a node. The config of
   * a supply node resolves with the scope of the parent. Undefined for a node with no supply ports.
   * A supply node with supply ports gets the values of its own supply nodes. Values that are
   * built again for each parent run and have a `close` function go in `sink.closers`: the caller
   * closes them when the parent is done. Values from the run cache close at the end of the run.
   */
  const suppliesFor = async (
    parent: GraphNode,
    definition: NodeDefinition,
    scope: Record<string, unknown>,
    input: unknown,
    sink: { secrets: string[]; masked: string[]; logs: CodeLog[]; closers: unknown[] },
    path: Set<string> = new Set(),
  ): Promise<Record<string, unknown> | undefined> => {
    if (!definition.supplyPorts?.length) return undefined;
    if (path.has(parent.id)) throw new Error("The supply nodes make a loop");
    const below = new Set(path).add(parent.id);
    const supplies: Record<string, unknown> = {};
    for (const port of definition.supplyPorts) {
      // Left to right on the canvas, so the order is the one a person sees.
      const connected = supplyEdges
        .filter((e) => e.to === parent.id && supplyPortOf(e) === port.name)
        .map((e) => nodesById.get(e.from))
        .filter((n): n is GraphNode => n !== undefined && !n.disabled)
        .sort((a, b) => a.position.x - b.position.x || a.id.localeCompare(b.id));
      if (connected.length === 0 && port.required) {
        throw new Error(`Connect a node to "${port.label}"`);
      }
      if (connected.length > 1 && !port.multiple) {
        throw new Error(`"${port.label}" takes one node. ${connected.length} are connected`);
      }
      const values: unknown[] = [];
      const toolNames = new Set<string>();
      for (const node of connected) {
        const supplier = registry.get(node.type);
        try {
          if (!supplier) throw new Error(`Unknown node type "${node.type}"`);
          if (!supplier.supply && port.kind === TOOL_KIND && canBeTool(supplier)) {
            values.push(
              track(
                nodeTool(node, supplier, scope, input, toolNames, sink.logs, below),
                node,
                parent,
              ),
            );
            continue;
          }
          if (!supplier.supply || supplier.supplies !== port.kind) {
            throw new Error(`The node does not give "${port.kind}"`);
          }
          if (below.has(node.id)) throw new Error("The supply nodes make a loop");
          const cached = supplyCache.get(node.id);
          if (cached) {
            sink.secrets.push(...cached.secrets);
            sink.masked.push(...cached.masked);
            sink.masked.sort((a, b) => b.length - a.length);
            values.push(track(cached.value, node, parent));
            continue;
          }
          const keep = staticSupply(node, supplier, new Set());
          const secrets: string[] = [];
          const masked: string[] = [];
          const { config, credential } = await resolveNode(node, supplier, scope, secrets, masked);
          // A kept value lives to the end of the run, so the values under it do too.
          const nested = await suppliesFor(
            node,
            supplier,
            scope,
            input,
            { secrets, masked, logs: sink.logs, closers: keep ? runClosers : sink.closers },
            below,
          );
          sink.secrets.push(...secrets);
          sink.masked.push(...masked);
          sink.masked.sort((a, b) => b.length - a.length);
          const value = await supplier.supply({
            config,
            credential,
            signal,
            scope: runScope(scope, input),
            log: (entries) => {
              const named = entries.map((entry) => ({
                ...entry,
                message: `[${node.name}] ${entry.message}`,
              }));
              sink.logs.push(...(sink.masked.length > 0 ? maskSecrets(named, sink.masked) : named));
            },
            sandbox: options.sandbox ?? null,
            tables: options.tables ?? null,
            runWorkflow: options.runWorkflow ?? null,
            node: { id: node.id, name: node.name },
            ...(nested ? { supplies: nested } : {}),
          });
          if (hasClose(value)) (keep ? runClosers : sink.closers).push(value);
          if (keep) supplyCache.set(node.id, { value, secrets, masked });
          values.push(track(value, node, parent));
        } catch (error) {
          const { message } = toError(error);
          throw new Error(`Supply "${node.name}" (${port.label}): ${message}`);
        }
      }
      if (port.multiple) supplies[port.name] = values;
      else if (values.length === 1) supplies[port.name] = values[0];
    }
    return supplies;
  };

  /** A supply value that reports its use through the `onSupplyUse` hook. */
  const track = <T>(value: T, node: GraphNode, parent: GraphNode): T =>
    trackUse(value, (status, used) => {
      void call("onSupplyUse", {
        node,
        parentId: parent.id,
        status,
        ...(used ? { call: used } : {}),
      });
    });

  /**
   * A node that runs as a tool. Each call resolves its config with the scope of the parent and the
   * values the model gave for `$fromAI`, then runs the node with the input of the parent.
   */
  const nodeTool = (
    node: GraphNode,
    definition: NodeDefinition,
    scope: Record<string, unknown>,
    input: unknown,
    used: Set<string>,
    logs: CodeLog[],
    path: Set<string>,
  ): NodeTool => {
    const name = toolName(node.name, used);
    const spec = {
      name,
      description: toolDescription(node, definition),
      inputSchema: toolInputSchema(fromAIInputs(node, definition)),
    };
    return {
      spec,
      call: async (given, callSignal) => {
        const secrets: string[] = [];
        const masked: string[] = [];
        const closers: unknown[] = [];
        try {
          const values =
            given !== null && typeof given === "object" && !Array.isArray(given)
              ? (given as Record<string, unknown>)
              : {};
          const toolScope = { ...scope, $fromAI: new ToolInput(values) };
          const { config, credential } = await resolveNode(
            node,
            definition,
            toolScope,
            secrets,
            masked,
          );
          const supplies = await suppliesFor(
            node,
            definition,
            toolScope,
            input,
            { secrets, masked, logs, closers },
            path,
          );
          const ran = await definition.run({
            config,
            input,
            credential,
            signal: callSignal ? AbortSignal.any([signal, callSignal]) : signal,
            scope: runScope(scope, input),
            log: (entries) => {
              const named = entries.map((entry) => ({
                ...entry,
                message: `[${node.name}] ${entry.message}`,
              }));
              logs.push(...(masked.length > 0 ? maskSecrets(named, masked) : named));
            },
            sandbox: options.sandbox ?? null,
            tables: options.tables ?? null,
            resumeUrl: null,
            runWorkflow: options.runWorkflow ?? null,
            loopBack: false,
            ...(supplies ? { supplies } : {}),
          });
          if (ran.waitUntil !== undefined) throw new Error("A node that waits cannot be a tool");
          const data = withoutBinary(ran.data);
          return masked.length > 0 ? maskSecrets(data, masked) : data;
        } catch (error) {
          const { message } = scrubError(toError(error), secrets);
          throw new Error(`Tool "${name}": ${message}`);
        } finally {
          await closeAll(closers);
        }
      },
    };
  };

  /** The nodes that a node feeds, directly or through other nodes. */
  const downstreamCache = new Map<string, Set<string>>();
  const downstream = (nodeId: string): Set<string> => {
    const cached = downstreamCache.get(nodeId);
    if (cached) return cached;
    const found = new Set<string>();
    const queue = [nodeId];
    for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
      for (const edge of graph.edges) {
        if (edge.from === id && !found.has(edge.to)) {
          found.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    downstreamCache.set(nodeId, found);
    return found;
  };
  /** An edge comes back when its source is downstream of its target (a loop). */
  const comesBack = (edge: GraphEdge) => downstream(edge.to).has(edge.from);

  const children = (nodeId: string, port?: string) =>
    graph.edges
      .filter((e) => e.from === nodeId && (port === undefined || e.fromPort === port))
      .map((e) => e.to);

  // Nodes that the walk can reach from the start. A join does not wait for the others.
  const reachable = new Set<string>([start.id]);
  const walkQueue = [start.id];
  for (let id = walkQueue.pop(); id !== undefined; id = walkQueue.pop()) {
    for (const edge of graph.edges) {
      if (edge.from === id && !reachable.has(edge.to)) {
        reachable.add(edge.to);
        walkQueue.push(edge.to);
      }
    }
  }

  // A join node collects the data of its parents. It runs when each parent edge has data or
  // was skipped, and at least one has data.
  const joins = new Map<string, { data: Record<string, unknown>; done: Set<string> }>();
  const isJoin = (nodeId: string) => {
    const node = nodesById.get(nodeId);
    return node ? registry.get(node.type)?.join === true : false;
  };
  /**
   * False when the edge goes into an input port that the join node does not have with its config
   * (the input count was lowered and the edge is still in the graph). The engine ignores it.
   */
  const inputLive = (edge: GraphEdge) => {
    const node = nodesById.get(edge.to);
    const definition = node ? registry.get(node.type) : undefined;
    return !node || !definition || inputPortsOf(definition, node.config).includes(edge.toPort);
  };
  /** Records an edge into a join node. Returns the input when the join is ready to run. */
  const arrive = (edge: GraphEdge, data: { value: unknown } | null) => {
    if (!inputLive(edge)) return null;
    const state = joins.get(edge.to) ?? { data: {}, done: new Set<string>() };
    joins.set(edge.to, state);
    state.done.add(edge.id);
    if (data) state.data[edge.toPort] = data.value;
    const expected = graph.edges.filter(
      (e) =>
        e.to === edge.to &&
        inputLive(e) &&
        reachable.has(e.from) &&
        (target === undefined || pathIds.has(e.from)),
    );
    if (!expected.every((e) => state.done.has(e.id))) return null;
    joins.delete(edge.to);
    return { ready: Object.keys(state.data).length > 0, input: state.data };
  };

  const markSkipped = async (nodeId: string, seen = new Set<string>()) => {
    const node = nodesById.get(nodeId);
    // A loop reaches a node again. A node that ran or was skipped keeps its saved result.
    if (!node || seen.has(nodeId) || attempts.has(nodeId)) return;
    seen.add(nodeId);
    attempts.set(nodeId, 1);
    await call("afterNode", {
      node,
      attempt: 1,
      status: "skipped",
      port: null,
      input: null,
      output: null,
      error: null,
      durationMs: 0,
      pinned: false,
    });
    for (const edge of graph.edges.filter((e) => e.from === nodeId)) {
      if (!isJoin(edge.to)) {
        await markSkipped(edge.to, seen);
        continue;
      }
      const joined = arrive(edge, null);
      if (!joined) continue;
      const join = nodesById.get(edge.to);
      if (joined.ready && join) await walk(join, joined.input);
      else await markSkipped(edge.to, seen);
    }
  };

  await call("onRunStart");
  let failure: { message: string; nodeId: string } | null = null;
  let waiting: { resumeAt: number; nodeId: string } | null = null;

  const runNode = async (
    node: GraphNode,
    input: unknown,
    loopBack = false,
  ): Promise<Output | null> => {
    nodeRuns += 1;
    if (nodeRuns > maxNodeRuns) {
      failure = {
        message: `The run stopped after ${maxNodeRuns} node runs. A loop may not end.`,
        nodeId: node.id,
      };
      return null;
    }

    // A resumed run: this node has a saved result for this turn.
    const saved = replays.get(node.id)?.shift();
    if (saved?.status === "succeeded") {
      const done: Output = { port: saved.port, data: saved.data };
      const stateful = registry.get(node.type);
      if (stateful?.stateful) {
        // Build the state again. The saved result stays the result of this turn.
        try {
          await hydrateSaved();
          const fullInput = await hydrateValue(input);
          const scope = scopeFor(fullInput);
          const rebuilt = await stateful.run({
            config: configFor(node, stateful, scope),
            input: fullInput,
            credential: null,
            signal,
            scope: runScope(scope, fullInput),
            sandbox: null,
            tables: null,
            resumeUrl: null,
            loopBack,
            state: nodeState.get(node.id),
          });
          if (rebuilt.state !== undefined) nodeState.set(node.id, rebuilt.state);
        } catch {
          // The node failed or has no state. The saved result is used.
        }
      }
      outputs.set(node.id, done);
      if (containsBlobRef(done.data)) unhydrated.add(node.id);
      return done;
    }

    if (node.disabled && target?.kind !== "only") {
      const first = registry.get(node.type);
      const port = (first ? outputPortsOf(first, node.config)[0] : undefined) ?? "out";
      const passed: Output = { port, data: input };
      outputs.set(node.id, passed);
      attempts.set(node.id, (attempts.get(node.id) ?? 0) + 1);
      await call("afterNode", {
        node,
        attempt: attempts.get(node.id) ?? 1,
        status: "skipped",
        port,
        input,
        output: input,
        error: null,
        durationMs: 0,
        pinned: false,
      });
      return passed;
    }

    if (node.pinned && options.mode === "test" && target?.kind !== "only") {
      outputs.set(node.id, node.pinned);
      await call("afterNode", {
        node,
        attempt: (attempts.get(node.id) ?? 0) + 1,
        status: "succeeded",
        port: node.pinned.port,
        input,
        output: node.pinned.data,
        error: null,
        durationMs: 0,
        pinned: true,
      });
      attempts.set(node.id, (attempts.get(node.id) ?? 0) + 1);
      return node.pinned;
    }

    const definition = registry.get(node.type);

    if (saved?.status === "waiting") {
      if (saved.resumeAt > Date.now()) {
        // Not yet. Keep the entry for the next resume.
        replays.set(node.id, [saved, ...(replays.get(node.id) ?? [])]);
        waiting = { resumeAt: saved.resumeAt, nodeId: node.id };
        return null;
      }
      const done: Output = { port: saved.port, data: saved.data };
      outputs.set(node.id, done);
      if (containsBlobRef(done.data)) unhydrated.add(node.id);
      await call("afterNode", {
        node,
        attempt: saved.attempt,
        status: "succeeded",
        port: saved.port,
        input,
        output: saved.data,
        error: null,
        durationMs: 0,
        pinned: false,
      });
      return done;
    }

    const maxAttempts = (node.retry?.max ?? 0) + 1;
    let lastError: { message: string; path?: string } = { message: "Unknown error" };

    for (let n = 1; n <= maxAttempts; n++) {
      const attempt = (attempts.get(node.id) ?? 0) + 1;
      attempts.set(node.id, attempt);
      if (signal.aborted) throw new Error("Run cancelled");
      await call("beforeNode", { node, attempt, input });
      const startedAt = Date.now();
      /** Credential values. They must not appear in a stored error. */
      const secrets: string[] = [];
      /** Values of `$credentials` fields. They are removed from the output and the logs too. */
      const masked: string[] = [];
      const logs: CodeLog[] = [];
      /** Supply values built for this attempt only. They close when it ends. */
      const closers: unknown[] = [];
      try {
        if (!definition) throw new Error(`Unknown node type "${node.type}"`);
        await hydrateSaved();
        const hydrated = await hydrateValue(input);
        const fullInput =
          node.executeOnce && Array.isArray(hydrated) ? hydrated.slice(0, 1) : hydrated;
        const scope = scopeFor(fullInput);
        const { config, credential } = await resolveNode(node, definition, scope, secrets, masked);
        const supplies = await suppliesFor(node, definition, scope, fullInput, {
          secrets,
          masked,
          logs,
          closers,
        });
        const ran = await definition.run({
          config,
          input: fullInput,
          credential,
          signal,
          scope: runScope(scope, fullInput),
          log: (entries) =>
            logs.push(...(masked.length > 0 ? maskSecrets(entries, masked) : entries)),
          sandbox: options.sandbox ?? null,
          tables: options.tables ?? null,
          resumeUrl: options.resumeUrl?.(node.id) ?? null,
          runWorkflow: options.runWorkflow ?? null,
          loopBack,
          state: nodeState.get(node.id),
          ...(supplies ? { supplies } : {}),
        });
        const raw = masked.length > 0 ? maskSecrets(ran, masked) : ran;
        const empty =
          raw.data === null ||
          raw.data === undefined ||
          (Array.isArray(raw.data) && raw.data.length === 0);
        const result = node.alwaysOutputData && empty ? { ...raw, data: {} } : raw;
        if (!outputPortsOf(definition, node.config).includes(result.port)) {
          throw new Error(`Node returned unknown port "${result.port}"`);
        }
        if (options.maxOutputBytes !== undefined) {
          const size = Buffer.byteLength(JSON.stringify(result.data) ?? "");
          if (size > options.maxOutputBytes) {
            throw new Error(
              `Node output is ${size} bytes. The limit is ${options.maxOutputBytes} bytes`,
            );
          }
        }
        if (result.waitUntil !== undefined && result.waitUntil > Date.now()) {
          waiting = { resumeAt: result.waitUntil, nodeId: node.id };
          await call("afterNode", {
            node,
            attempt,
            status: "waiting",
            port: result.port,
            input,
            output: { resumeAt: result.waitUntil, data: result.data },
            error: null,
            durationMs: Date.now() - startedAt,
            pinned: false,
            logs,
          });
          return null;
        }
        if (result.state !== undefined) nodeState.set(node.id, result.state);
        outputs.set(node.id, result);
        await call("afterNode", {
          node,
          attempt,
          status: "succeeded",
          port: result.port,
          input,
          output: result.data,
          error: null,
          durationMs: Date.now() - startedAt,
          pinned: false,
          respond: result.respond,
          logs,
        });
        return result;
      } catch (error) {
        lastError = scrubError(toError(error), secrets);
        await call("afterNode", {
          node,
          attempt,
          status: "failed",
          port: null,
          input,
          output: null,
          error: lastError,
          durationMs: Date.now() - startedAt,
          pinned: false,
          logs,
        });
        if (signal.aborted) throw new Error("Run cancelled");
        if (n < maxAttempts) await sleep(node.retry?.backoffMs ?? 0);
      } finally {
        await closeAll(closers);
      }
    }

    if (node.onError === "continue") {
      const first = definition ? outputPortsOf(definition, node.config)[0] : undefined;
      const result: Output = { port: first ?? "out", data: { error: lastError } };
      outputs.set(node.id, result);
      return result;
    }
    failure = { message: lastError.message, nodeId: node.id };
    return null;
  };

  const walk = async (node: GraphNode, input: unknown, loopBack = false): Promise<void> => {
    const output = await runNode(node, input, loopBack);
    if (!output || failure || waiting) return;
    if (target?.kind === "only" || (target?.kind === "to" && node.id === target.nodeId)) return;
    const definition = registry.get(node.type);
    for (const port of definition ? outputPortsOf(definition, node.config) : [output.port]) {
      if (port === output.port) continue;
      for (const child of children(node.id, port)) {
        if (target !== undefined && !pathIds.has(child)) continue;
        const edge = graph.edges.find(
          (e) => e.from === node.id && e.fromPort === port && e.to === child,
        );
        if (edge && isJoin(child)) {
          const joined = arrive(edge, null);
          const join = nodesById.get(child);
          if (joined?.ready && join) await walk(join, joined.input);
          else if (joined) await markSkipped(child);
        } else {
          await markSkipped(child);
        }
        if (failure || waiting) return;
      }
    }
    for (const edge of graph.edges.filter(
      (e) => e.from === node.id && e.fromPort === output.port,
    )) {
      if (target?.kind === "to" && !pathIds.has(edge.to)) continue;
      const child = nodesById.get(edge.to);
      if (!child) continue;
      if (isJoin(edge.to)) {
        const joined = arrive(edge, { value: output.data });
        if (joined) await walk(child, joined.input);
      } else {
        await walk(child, output.data, comesBack(edge));
      }
      if (failure || waiting) return;
    }
  };

  let cancelled = false;
  try {
    await walk(start, target?.kind === "only" ? target.input : options.triggerInput);
  } catch (error) {
    if (signal.aborted) cancelled = true;
    else failure = { message: toError(error).message, nodeId: start.id };
  } finally {
    // The run cache ends with the walk. A run that waits builds its supplies again on resume.
    await closeAll(runClosers);
    supplyCache.clear();
  }

  if (cancelled) {
    await call("onRunEnd", { status: "cancelled", error: null, failedNodeId: null });
    return { status: "cancelled", error: null };
  }

  if (waiting) {
    const { resumeAt, nodeId } = waiting as { resumeAt: number; nodeId: string };
    await call("onRunWait", { resumeAt, nodeId });
    return { status: "waiting", resumeAt, error: null };
  }

  if (failure) {
    const { message, nodeId } = failure as { message: string; nodeId: string };
    await call("onRunEnd", { status: "failed", error: { message, nodeId }, failedNodeId: nodeId });
    return { status: "failed", error: { message, nodeId } };
  }
  await call("onRunEnd", { status: "succeeded", error: null, failedNodeId: null });
  return { status: "succeeded", error: null };
}
