// SPDX-License-Identifier: AGPL-3.0-only

import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import type {
  CredentialTypeDefinition,
  ListenContext,
  ListenHandle,
  NodeDefinition,
  NodeRunContext,
  NodeWebhook,
  PollContext,
  WebhookContext,
} from "@zerodot/engine";
import { z } from "zod";
import { HOST_CODE } from "./isolated-host";
import { kept } from "./kept";
import { sentSchemas } from "./schema-copies";

/**
 * A community package runs in its own process, not in the process of zerodot:
 *
 * - The environment is empty, so the package cannot read the secret keys of zerodot.
 * - Node's permission model lets it read only the nodes folder. It cannot write files, start
 *   processes or worker threads, or load native addons. It can use the network.
 * - It gets only what one call needs: the config, the input, and the credential of that node. It
 *   has no database, no data tables, no sandbox, and no sub-workflows.
 *
 * zerodot keeps copies of the node definitions. Their functions send the call to the process.
 */

const MEMORY_MB = 256;

/**
 * Hosts inside the network of the server that community packages may reach anyway, from
 * `ZERODOT_COMMUNITY_NODES_ALLOW_HOSTS` (names or IP addresses, comma-separated). By default a
 * package can reach only addresses on the internet.
 */
export const allowedHosts = (env: Record<string, string | undefined> = process.env): string[] =>
  (env.ZERODOT_COMMUNITY_NODES_ALLOW_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");

/**
 * True only when `ZERODOT_COMMUNITY_NODES_AS_TOOLS=true`. Off by default: as a tool, a community
 * node runs with values that a model chose.
 */
export const communityTools = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.ZERODOT_COMMUNITY_NODES_AS_TOOLS ?? "").trim().toLowerCase() === "true";
const LOAD_TIMEOUT_MS = 30_000;

type NodeManifest = {
  type: string;
  label: string;
  description?: string;
  category: NodeDefinition["category"];
  actions?: NodeDefinition["actions"];
  app?: string;
  icon: string;
  iconUrl?: string;
  configSchema: unknown;
  defaultConfig: unknown;
  credentialTypes?: string[];
  credentialRules?: NodeDefinition["credentialRules"];
  ports: NodeDefinition["ports"];
  join: boolean;
  stateful: boolean;
  rawConfigKeys?: string[];
  webhookTest?: NodeDefinition["webhookTest"];
  usableAsTool?: boolean;
  hasRun: boolean;
  /** The node gives a supply or has supply ports. */
  hasSupply?: boolean;
  hasPoll: boolean;
  hasListen: boolean;
  webhook: { activate: boolean; deactivate: boolean } | null;
  problem: string | null;
};

type CredentialManifest = {
  type: string;
  label: string;
  fieldsSchema: unknown;
  secretFields: string[];
  serverFields?: string[];
  oauth2?: CredentialTypeDefinition["oauth2"];
  oauth2Function: boolean;
  icon?: string;
  iconUrl?: string;
  hasTest: boolean;
};

type Manifest = { nodes: NodeManifest[]; credentialTypes: CredentialManifest[] };

type HostMessage =
  | { op: "ready" }
  | { op: "result"; id: number; value?: unknown; error?: string }
  | { op: "log"; id: number; logs: Parameters<NonNullable<NodeRunContext<unknown>["log"]>>[0] }
  | { op: "emit"; id: number; ask: number; item: Parameters<ListenContext["emit"]>[0] }
  | { op: "fail"; id: number; error: string };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** For a run: where its logs go. */
  log?: NodeRunContext<unknown>["log"];
};

type Listener = Pick<ListenContext, "emit" | "fail">;

/** The flags of `node` that turn on the permission model. Node 22 has both names. */
const permissionFlag = (): string =>
  process.allowedNodeEnvironmentFlags.has("--permission")
    ? "--permission"
    : "--experimental-permission";

/** One process that runs one package. It starts again on the next call when it stopped. */
class PackageHost {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<number, Listener>();
  private stopped = false;

  constructor(
    readonly name: string,
    private readonly entry: string,
    private readonly format: "cjs" | "esm",
    /** Folders the package may read: the nodes folder, and more in tests. */
    private readonly readable: string[],
  ) {}

  /** Starts the process and loads the package. Returns what the package has. */
  async load(): Promise<Manifest> {
    return (await this.request({ op: "load", entry: this.entry, format: this.format })) as Manifest;
  }

  private start(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      const reads = this.readable.map((dir) => `--allow-fs-read=${realpathSync(dir)}`);
      const child = spawn(
        process.execPath,
        [
          permissionFlag(),
          ...reads,
          `--max-old-space-size=${MEMORY_MB}`,
          "-e",
          HOST_CODE,
          JSON.stringify(allowedHosts()),
        ],
        {
          // No variables of zerodot. PATH is not needed: the package cannot start programs.
          env: {},
          stdio: ["ignore", "inherit", "inherit", "ipc"],
          serialization: "advanced",
        },
      );
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`The package process of ${this.name} did not start`));
      }, LOAD_TIMEOUT_MS);
      child.on("message", (message: HostMessage) => {
        if (message.op === "ready") {
          clearTimeout(timer);
          this.child = child;
          resolve(child);
          return;
        }
        this.receive(message);
      });
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        this.starting = null;
        const error = new Error(
          `The package process of ${this.name} stopped (${signal ?? `code ${code}`})`,
        );
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
        for (const listener of this.listeners.values()) listener.fail(error);
        this.listeners.clear();
        reject(error);
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private receive(message: HostMessage): void {
    if (message.op === "result") {
      const found = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (!found) return;
      if (message.error !== undefined) found.reject(new Error(message.error));
      else found.resolve(message.value);
    } else if (message.op === "log") {
      this.pending.get(message.id)?.log?.(message.logs);
    } else if (message.op === "emit") {
      const listener = this.listeners.get(message.id);
      const answer = (error?: string): void => {
        this.child?.send({ op: "answer", ask: message.ask, error });
      };
      if (!listener) {
        answer("The trigger stopped");
        return;
      }
      listener.emit(message.item).then(
        () => answer(),
        (error: unknown) => answer(error instanceof Error ? error.message : String(error)),
      );
    } else if (message.op === "fail") {
      this.listeners.get(message.id)?.fail(new Error(message.error));
    }
  }

  /** Sends a message and waits for its result. `signal` stops the call in the package. */
  async request(
    message: Record<string, unknown>,
    options: { signal?: AbortSignal; log?: Pending["log"]; id?: number } = {},
  ): Promise<unknown> {
    if (this.stopped) throw new Error(`The package ${this.name} was removed`);
    const isLoad = message.op === "load";
    const child = await this.start();
    // A process that started again has not loaded the package yet.
    if (!isLoad && !this.loaded.has(child)) {
      await this.send(child, { op: "load", entry: this.entry, format: this.format });
    }
    return this.send(child, message, options).then((value) => {
      if (isLoad) this.loaded.add(child);
      return value;
    });
  }

  private readonly loaded = new WeakSet<ChildProcess>();

  private send(
    child: ChildProcess,
    message: Record<string, unknown>,
    options: { signal?: AbortSignal; log?: Pending["log"]; id?: number } = {},
  ): Promise<unknown> {
    const id = options.id ?? ++this.nextId;
    const { signal } = options;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("The call was stopped"));
      const abort = () => child.send({ op: "abort", id });
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        log: options.log,
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      child.send({ ...message, id });
    });
  }

  /** Calls a method of a node or of a credential type in the package. */
  call(
    type: string,
    method: string,
    ctx: Record<string, unknown>,
    options: { signal?: AbortSignal; log?: Pending["log"] } = {},
  ): Promise<unknown> {
    return this.request({ op: "call", type, method, ctx }, options);
  }

  /** Starts a listen trigger. The package sends its items to `listener`. */
  async listen(
    type: string,
    ctx: Record<string, unknown>,
    listener: Listener,
  ): Promise<ListenHandle> {
    const id = ++this.nextId;
    this.listeners.set(id, listener);
    try {
      await this.request({ op: "call", type, method: "listen", ctx }, { id });
    } catch (error) {
      this.listeners.delete(id);
      throw error;
    }
    return {
      close: async ({ remove }) => {
        this.listeners.delete(id);
        if (!this.child) return;
        await this.request({ op: "close", listenId: id, remove }).catch(() => undefined);
      },
    };
  }

  /** Stops the process for good. */
  stop(): void {
    this.stopped = true;
    this.child?.kill("SIGKILL");
    this.child = null;
  }
}

/** Plain parts of a context: the functions and the signal stay in this process. */
function plainContext<T extends { signal: AbortSignal }>(
  ctx: T,
  drop: string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "signal" || drop.includes(key) || typeof value === "function") continue;
    out[key] = value;
  }
  return out;
}

/** A Zod schema built from the JSON Schema that the package sent. The package checks again. */
function schemaFrom(json: unknown): z.ZodType {
  if (!json || typeof json !== "object") return z.unknown();
  try {
    const schema = z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
    sentSchemas.set(schema, json);
    return schema;
  } catch {
    const schema = z.unknown();
    sentSchemas.set(schema, json);
    return schema;
  }
}

function nodeFrom(host: PackageHost, manifest: NodeManifest): NodeDefinition {
  const { type } = manifest;
  const definition: NodeDefinition & { isolationProblem?: string } = {
    type,
    label: manifest.label,
    description: manifest.description,
    category: manifest.category,
    actions: manifest.actions,
    app: manifest.app,
    icon: manifest.icon,
    iconUrl: manifest.iconUrl,
    config: schemaFrom(manifest.configSchema),
    defaultConfig: manifest.defaultConfig,
    credentialTypes: manifest.credentialTypes,
    credentialRules: manifest.credentialRules,
    ports: manifest.ports,
    // False, not undefined: an integration node is a tool by default.
    usableAsTool: communityTools() ? manifest.usableAsTool : false,
    join: manifest.join || undefined,
    stateful: manifest.stateful || undefined,
    rawConfigKeys: manifest.rawConfigKeys,
    webhookTest: manifest.webhookTest,
    run: async (ctx: NodeRunContext<unknown>) =>
      (await host.call(
        type,
        "run",
        plainContext(ctx, ["sandbox", "tables", "runWorkflow", "scope"]),
        { signal: ctx.signal, log: ctx.log },
      )) as Awaited<ReturnType<NodeDefinition["run"]>>,
  };
  if (manifest.problem) definition.isolationProblem = manifest.problem;
  if (!manifest.hasRun) definition.isolationProblem = "no run()";
  if (manifest.hasSupply) {
    definition.isolationProblem = "supply nodes and ports need an official @zerodot package";
  }
  if (manifest.hasPoll) {
    definition.poll = async (ctx: PollContext) =>
      (await host.call(type, "poll", plainContext(ctx), { signal: ctx.signal })) as Awaited<
        ReturnType<NonNullable<NodeDefinition["poll"]>>
      >;
  }
  if (manifest.hasListen) {
    definition.listen = (ctx: ListenContext) =>
      host.listen(type, plainContext(ctx), { emit: ctx.emit, fail: ctx.fail });
  }
  if (manifest.webhook) {
    const call = (method: string) => async (ctx: WebhookContext) =>
      host.call(type, method, plainContext(ctx), { signal: ctx.signal });
    const webhook: NodeWebhook = {
      receive: async (ctx) =>
        (await call("receive")(ctx)) as Awaited<ReturnType<NodeWebhook["receive"]>>,
    };
    if (manifest.webhook.activate) webhook.activate = call("activate");
    if (manifest.webhook.deactivate) webhook.deactivate = call("deactivate");
    definition.webhook = webhook;
  }
  return definition;
}

function credentialTypeFrom(
  host: PackageHost,
  manifest: CredentialManifest,
): CredentialTypeDefinition | { type: string; problem: string } {
  if (manifest.oauth2Function) {
    return {
      type: manifest.type,
      problem: "an OAuth2 function is not supported in a community package",
    };
  }
  const fields = schemaFrom(manifest.fieldsSchema);
  if (!(fields instanceof z.ZodObject)) {
    return { type: manifest.type, problem: "the fields are not an object schema" };
  }
  return {
    type: manifest.type,
    label: manifest.label,
    fields: fields as CredentialTypeDefinition["fields"],
    secretFields: manifest.secretFields,
    serverFields: manifest.serverFields,
    oauth2: manifest.oauth2,
    icon: manifest.icon,
    iconUrl: manifest.iconUrl,
    ...(manifest.hasTest
      ? {
          test: async (credential) => {
            await host.call(manifest.type, "credentialTest", { credential });
          },
        }
      : {}),
  };
}

const hosts = kept("hosts", () => new Map<string, PackageHost>());

/**
 * Starts a process for a community package and loads it there. Returns exports in the shape of a
 * package: `nodes` and `credentialTypes`, whose functions call the process.
 */
export async function importIsolated(
  name: string,
  entry: string,
  format: "cjs" | "esm",
  readable: string[],
): Promise<Record<string, unknown>> {
  stopIsolated(name);
  // Real paths: resolving a link outside the readable folders is not allowed in the process.
  const host = new PackageHost(name, realpathSync(entry), format, readable);
  hosts.set(name, host);
  try {
    const manifest = await host.load();
    return {
      nodes: manifest.nodes.map((node) => nodeFrom(host, node)),
      credentialTypes: manifest.credentialTypes.map((type) => credentialTypeFrom(host, type)),
    };
  } catch (error) {
    stopIsolated(name);
    throw error;
  }
}

/** Stops the process of a package. Its nodes stop working. */
export function stopIsolated(name: string): void {
  hosts.get(name)?.stop();
  hosts.delete(name);
}

export const isIsolated = (name: string): boolean => hosts.has(name);
