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

// ---- Network guard. It runs before any package code. ----
// The package may call servers on the internet, but not addresses inside the network of the
// server: the database, Valkey, other services, and the metadata address of a cloud. The guard
// checks the address after the DNS lookup, so a name that points inside is refused too.
const net = require("node:net");
const dns = require("node:dns");
const allowHosts = new Set(JSON.parse(process.argv[1] || "[]").map((host) => String(host).toLowerCase()));

const IPV4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];
const ipv4Number = (ip) => ip.split(".").reduce((sum, part) => sum * 256 + Number(part), 0);
const inIpv4Range = (ip, base, bits) =>
  Math.floor(ipv4Number(ip) / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits));

/** The 8 groups of an IPv6 address as numbers, or null. A dotted IPv4 end counts as 2 groups. */
function ipv6Groups(address) {
  let text = address;
  const dotted = /((?:\d+\.){3}\d+)$/.exec(text);
  if (dotted) {
    if (!net.isIPv4(dotted[1])) return null;
    const n = ipv4Number(dotted[1]);
    text = text.slice(0, -dotted[1].length) + (Math.floor(n / 65536)).toString(16) + ":" + (n % 65536).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/** True for an address inside a private, local, or special network. */
function isBlockedIp(ip) {
  const address = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (net.isIPv4(address)) return IPV4_BLOCKED.some(([base, bits]) => inIpv4Range(address, base, bits));
  if (!net.isIPv6(address)) return true;
  const g = ipv6Groups(address);
  if (!g) return true;
  const zeroPrefix = g.slice(0, 5).every((x) => x === 0);
  // An IPv4 address inside an IPv6 address: ::ffff:a.b.c.d, ::a.b.c.d, and 64:ff9b::a.b.c.d (NAT64).
  if ((zeroPrefix && (g[5] === 0xffff || g[5] === 0)) || (g[0] === 0x64 && g[1] === 0xff9b)) {
    if (zeroPrefix && g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
    return isBlockedIp([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join("."));
  }
  // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast.
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

const blocked = (host) =>
  new Error("zerodot does not let a community package reach " + host + ". It is inside the network of the server");

/** A DNS lookup that refuses an answer inside the network of the server. */
function guardLookup(lookup, host) {
  return (hostname, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : options;
    lookup(hostname, opts, (error, address, family) => {
      if (error) return done(error);
      const list = Array.isArray(address) ? address : [{ address, family }];
      if (list.some((item) => isBlockedIp(item.address))) return done(blocked(host));
      done(null, address, family);
    });
  };
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() passes [options, callback] as one array. The other forms are (options),
  // (port, host), and (path).
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let options = first;
  if (typeof first !== "object" || first === null) {
    options = typeof first === "string" && Number.isNaN(Number(first))
      ? { path: first }
      : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
    if (options.path === undefined) {
      if (Array.isArray(args[0])) args[0][0] = options;
      else args.splice(0, typeof args[1] === "string" ? 2 : 1, options);
    }
  }
  if (options.path !== undefined) throw new Error("zerodot does not let a community package open a local socket");
  const host = String(options.host || "localhost").toLowerCase();
  if (allowHosts.has(host)) return connect.apply(this, args);
  if (net.isIP(host.replace(/^\[|\]$/g, ""))) {
    if (isBlockedIp(host) && !allowHosts.has(host)) throw blocked(host);
  } else {
    options.lookup = guardLookup(options.lookup || dns.lookup, host);
  }
  return connect.apply(this, args);
};
// UDP can reach the same addresses. Nodes do not need it.
require("node:dgram").createSocket = () => {
  throw new Error("zerodot does not let a community package use UDP");
};

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
    usableAsTool: typeof node.usableAsTool === "boolean" ? node.usableAsTool : undefined,
    hasRun: typeof node.run === "function",
    // Supply values hold functions. They cannot cross the process boundary.
    hasSupply: node.supplies !== undefined || typeof node.supply === "function" || Array.isArray(node.supplyPorts),
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
