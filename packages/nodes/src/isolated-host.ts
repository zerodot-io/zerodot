// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The code of the process that runs one community package. It is plain JavaScript in a string, so
 * that a bundler cannot change it, and it runs with `node -e`. It has no access to the code or the
 * memory of zerodot. It talks to zerodot only through the IPC channel:
 *
 * - zerodot sends `{ op: "load", entry, format }`. The host loads the package and answers with
 *   plain data about its nodes and credential types (the manifest).
 * - zerodot sends `{ op: "call", id, type, method, ctx }`. The host checks the config with the
 *   real schema of the node, calls the method, and answers `{ op: "result", id, value }` or
 *   `{ op: "result", id, error }`.
 * - A listen trigger sends `{ op: "emit" }` and `{ op: "fail" }` to zerodot while it runs.
 */
export const HOST_CODE = String.raw`
"use strict";
const { pathToFileURL } = require("node:url");

const nodes = new Map();
const credentialTypes = new Map();
const controllers = new Map();
const listens = new Map();
const waiting = new Map();
let nextAsk = 0;

const send = (message) => process.send(message);
const errorText = (error) => (error && error.message) || String(error);
const schemaOf = (schema) => {
  try {
    return schema.toJSONSchema({ io: "input", unrepresentable: "any" });
  } catch {
    return {};
  }
};

/** Why zerodot cannot run this node in a separate process. Null when it can. */
function unsupported(node) {
  for (const key of ["outPorts", "inPorts", "waitForm", "waitsForCallback"]) {
    if (typeof node[key] === "function") return key + "() is not supported in a community package";
  }
  return null;
}

function nodeManifest(node) {
  const problem = unsupported(node);
  const webhook = node.webhook && typeof node.webhook.receive === "function" ? node.webhook : null;
  return {
    type: node.type,
    label: node.label,
    description: node.description,
    category: node.category,
    actions: node.actions,
    app: node.app,
    icon: node.icon,
    iconUrl: node.iconUrl,
    configSchema: node.config && typeof node.config.toJSONSchema === "function" ? schemaOf(node.config) : null,
    defaultConfig: node.defaultConfig,
    credentialTypes: node.credentialTypes,
    credentialRules: node.credentialRules,
    ports: node.ports,
    join: node.join === true,
    stateful: node.stateful === true,
    rawConfigKeys: node.rawConfigKeys,
    webhookTest: node.webhookTest,
    hasRun: typeof node.run === "function",
    hasPoll: typeof node.poll === "function",
    hasListen: typeof node.listen === "function",
    webhook: webhook
      ? { activate: typeof webhook.activate === "function", deactivate: typeof webhook.deactivate === "function" }
      : null,
    problem,
  };
}

function credentialManifest(type) {
  return {
    type: type.type,
    label: type.label,
    fieldsSchema: type.fields && typeof type.fields.toJSONSchema === "function" ? schemaOf(type.fields) : null,
    secretFields: type.secretFields,
    serverFields: type.serverFields,
    // An OAuth2 resolver is a function. It cannot cross the process border.
    oauth2: typeof type.oauth2 === "function" ? undefined : type.oauth2,
    oauth2Function: typeof type.oauth2 === "function",
    icon: type.icon,
    iconUrl: type.iconUrl,
    hasTest: typeof type.test === "function",
  };
}

async function load(message) {
  const loaded = message.format === "cjs"
    ? require(message.entry)
    : await import(pathToFileURL(message.entry).href);
  const fallback = loaded.default || {};
  const list = loaded.nodes || fallback.nodes;
  const types = loaded.credentialTypes || fallback.credentialTypes;
  if (!Array.isArray(list)) throw new Error('The package does not export a list named "nodes"');
  for (const node of list) if (node && typeof node.type === "string") nodes.set(node.type, node);
  if (Array.isArray(types)) {
    for (const type of types) if (type && typeof type.type === "string") credentialTypes.set(type.type, type);
  }
  return {
    nodes: [...nodes.values()].map(nodeManifest),
    credentialTypes: [...credentialTypes.values()].map(credentialManifest),
  };
}

/** Asks zerodot and waits for the answer. A listen trigger uses it for emit(). */
function ask(message) {
  const key = ++nextAsk;
  return new Promise((resolve, reject) => {
    waiting.set(key, { resolve, reject });
    send({ ...message, ask: key });
  });
}

async function call(message, signal) {
  const ctx = message.ctx;
  if (message.method === "credentialTest") {
    const type = credentialTypes.get(message.type);
    if (!type || typeof type.test !== "function") throw new Error("This credential type has no test");
    return type.test(ctx.credential);
  }
  const node = nodes.get(message.type);
  if (!node) throw new Error("Unknown node type " + message.type);
  // zerodot checked the config with a copy of the schema. The real schema runs its transforms.
  const config = node.config.parse(ctx.config);
  const full = { ...ctx, config, signal };
  switch (message.method) {
    case "run":
      return node.run({ ...full, sandbox: null, tables: null, runWorkflow: null,
        log: (logs) => send({ op: "log", id: message.id, logs }) });
    case "poll":
      return node.poll(full);
    case "receive":
      return node.webhook.receive(full);
    case "activate":
      return node.webhook.activate(full);
    case "deactivate":
      return node.webhook.deactivate(full);
    case "listen": {
      const handle = await node.listen({
        ...full,
        emit: (item) => ask({ op: "emit", id: message.id, item }),
        fail: (error) => send({ op: "fail", id: message.id, error: errorText(error) }),
      });
      listens.set(message.id, handle);
      return null;
    }
    default:
      throw new Error("Unknown method " + message.method);
  }
}

process.on("message", async (message) => {
  if (message.op === "abort") {
    controllers.get(message.id)?.abort();
    return;
  }
  if (message.op === "answer") {
    const found = waiting.get(message.ask);
    waiting.delete(message.ask);
    if (found) message.error ? found.reject(new Error(message.error)) : found.resolve(undefined);
    return;
  }
  if (message.op === "close") {
    const handle = listens.get(message.listenId);
    listens.delete(message.listenId);
    try {
      await handle?.close({ remove: message.remove === true });
      send({ op: "result", id: message.id, value: null });
    } catch (error) {
      send({ op: "result", id: message.id, error: errorText(error) });
    }
    return;
  }
  const controller = new AbortController();
  controllers.set(message.id, controller);
  try {
    const value = message.op === "load" ? await load(message) : await call(message, controller.signal);
    send({ op: "result", id: message.id, value: value === undefined ? null : value });
  } catch (error) {
    send({ op: "result", id: message.id, error: errorText(error) });
  } finally {
    controllers.delete(message.id);
  }
});

process.on("disconnect", () => process.exit(0));
send({ op: "ready" });
`;
