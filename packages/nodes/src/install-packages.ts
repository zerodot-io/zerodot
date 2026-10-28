// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import { unregisterCredentialTypes } from "./credentials";
import { importIsolated, stopIsolated } from "./isolated-packages";
import {
  loadNodePackages,
  type ManifestReader,
  type NodePackageReport,
  type PackageManifest,
} from "./load-packages";

const run = promisify(execFile);

const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * The npm registry that packages come from. `ZERODOT_NPM_REGISTRY` sets another one, for example a
 * private mirror. Version checks and installs both use it.
 */
export function npmRegistry(env: Record<string, string | undefined> = process.env): string {
  return (env.ZERODOT_NPM_REGISTRY?.trim() || DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
}
const INSTALL_TIMEOUT_MS = 180_000;

/** Only packages of the zerodot organization can be installed for now. */
const OFFICIAL_PACKAGE = /^@zerodot\/[a-z0-9][a-z0-9-]*$/;
export const isOfficialPackage = (name: string): boolean =>
  name.length <= 214 && OFFICIAL_PACKAGE.test(name);

/**
 * A valid npm package name, scoped or not. A package from a community registry can have any such
 * name. The first character is a letter or a digit, so the name cannot be read as an npm option.
 */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
export const isPackageName = (name: string): boolean =>
  name.length <= 214 && PACKAGE_NAME.test(name);

/** The folder where installed packages live. It must survive a restart. */
export function nodesDir(env: Record<string, string | undefined> = process.env): string {
  return resolve(env.ZERODOT_NODES_DIR || join(process.cwd(), ".zerodot", "nodes"));
}

function ensureNodesDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "package.json");
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify({ name: "zerodot-installed-nodes", private: true }));
  }
}

export type Packument = {
  versions?: Record<string, { zerodot?: PackageManifest } | undefined>;
};

type Triple = [number, number, number];

function parseVersion(version: string): Triple | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

const compareTriples = (a: Triple, b: Triple): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** The newest version (no pre-release) whose `zerodot.sdk` range fits this zerodot. */
export function pickVersion(packument: Packument, sdkVersion: string = SDK_VERSION): string | null {
  let best: { version: string; parts: Triple } | null = null;
  for (const [version, meta] of Object.entries(packument.versions ?? {})) {
    const parts = parseVersion(version);
    const range = meta?.zerodot?.sdk;
    if (!parts || typeof range !== "string" || !satisfiesSdk(range, sdkVersion)) continue;
    if (!best || compareTriples(parts, best.parts) > 0) best = { version, parts };
  }
  return best?.version ?? null;
}

/** Every version (no pre-release) whose `zerodot.sdk` range fits this zerodot, newest first. */
export function compatibleVersions(
  packument: Packument,
  sdkVersion: string = SDK_VERSION,
): string[] {
  const found: { version: string; parts: Triple }[] = [];
  for (const [version, meta] of Object.entries(packument.versions ?? {})) {
    const parts = parseVersion(version);
    const range = meta?.zerodot?.sdk;
    if (parts && typeof range === "string" && satisfiesSdk(range, sdkVersion)) {
      found.push({ version, parts });
    }
  }
  return found.sort((a, b) => compareTriples(b.parts, a.parts)).map((item) => item.version);
}

export async function fetchPackument(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Packument> {
  // The short form of the document has no custom fields, so it has no `zerodot.sdk`.
  const response = await fetchImpl(`${npmRegistry()}/${name.replace("/", "%2f")}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    throw new Error(`The package "${name}" does not exist on ${npmRegistry()}`);
  }
  if (!response.ok) throw new Error(`npm answered with status ${response.status}`);
  return (await response.json()) as Packument;
}

/** Picks the version to install: the newest one that works with this zerodot. */
export async function resolveVersion(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const version = pickVersion(await fetchPackument(name, fetchImpl));
  if (!version) {
    throw new Error(
      `No version of "${name}" works with this zerodot (node contract ${SDK_VERSION})`,
    );
  }
  return version;
}

const LOCK_STALE_MS = 5 * 60_000;
const LOCK_WAIT_MS = 4 * 60_000;

/**
 * Web, API, and worker can share one folder. Only one of them runs `npm` there at a time. The lock
 * is a folder, which the file system makes in one step. A lock older than five minutes is left
 * by a process that died, so it is taken over.
 */
export async function withInstallLock<T>(
  dir: string,
  work: () => Promise<T>,
  options: { waitMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<T> {
  const { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS, pollMs = 250 } = options;
  ensureNodesDir(dir);
  const lock = join(dir, ".install-lock");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > staleMs) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("Another install is running. Try again soon");
      await new Promise((done) => setTimeout(done, pollMs));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export type NpmRunner = (args: string[], cwd: string) => Promise<void>;

const npm: NpmRunner = async (args, cwd) => {
  await run("npm", args, { cwd, timeout: INSTALL_TIMEOUT_MS }).catch(
    (error: { stderr?: string; message: string }) => {
      throw new Error(`npm failed: ${(error.stderr || error.message).trim().slice(-500)}`);
    },
  );
};

/**
 * Install scripts do not run. The code of the package still runs when zerodot loads it: at install
 * and at each start, also when no workflow uses its nodes. A community package runs in its own
 * process (see isolated-packages.ts).
 */
export async function installFromNpm(
  dir: string,
  name: string,
  version: string,
  runner: NpmRunner = npm,
): Promise<void> {
  if (!isPackageName(name)) throw new Error(`"${name}" is not a valid package name`);
  ensureNodesDir(dir);
  await runner(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      `--registry=${npmRegistry()}`,
      `${name}@${version}`,
    ],
    dir,
  );
}

export async function uninstallFromNpm(
  dir: string,
  name: string,
  runner: NpmRunner = npm,
): Promise<void> {
  if (!isPackageName(name)) throw new Error(`"${name}" is not a valid package name`);
  await withInstallLock(dir, async () => {
    await runner(["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", name], dir);
    rmSync(join(dir, "node_modules", name), { recursive: true, force: true });
  });
}

type PackageJson = {
  version?: string;
  main?: string;
  exports?: string | { ".": string | { import?: string; default?: string } };
  zerodot?: PackageManifest;
};

function readPackageJson(dir: string, name: string): PackageJson | null {
  const file = join(dir, "node_modules", name, "package.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as PackageJson) : null;
}

/** The installed version of a package, or null. */
export const installedVersion = (dir: string, name: string): string | null =>
  readPackageJson(dir, name)?.version ?? null;

/** The file that `import()` loads for an installed package. */
export function packageEntry(dir: string, name: string): string {
  const json = readPackageJson(dir, name);
  if (!json) throw new Error(`The package "${name}" is not installed`);
  const root = json.exports && typeof json.exports === "object" ? json.exports["."] : json.exports;
  const target =
    typeof root === "string" ? root : (root?.import ?? root?.default ?? json.main ?? "index.js");
  return join(dir, "node_modules", name, target);
}

export const manifestReaderFor =
  (dir: string): ManifestReader =>
  (name) => {
    const json = readPackageJson(dir, name);
    return json ? (json.zerodot ?? {}) : null;
  };

/** The last load report of each package in this process. */
const lastReports = new Map<string, NodePackageReport>();
export const packageReports = (): NodePackageReport[] => [...lastReports.values()];

type Loaded = {
  /** Version on disk when the package was loaded. */
  version: string | null;
  nodes: string[];
  credentialTypes: string[];
  /** The file that was loaded, and how. "isolated": in its own process (a community package). */
  entry: string;
  format: "cjs" | "esm" | "isolated";
};

/** What each loaded package added. A restart clears it. */
const loaded = new Map<string, Loaded>();
export const isLoaded = (name: string): boolean => loaded.has(name);

/** The version of a package that this process runs, or null. */
export const loadedVersion = (name: string): string | null => loaded.get(name)?.version ?? null;

/** Packages that were loaded as ES modules. A process cannot free those: only a restart does. */
export const esmPackages = (): string[] =>
  [...loaded].filter(([, item]) => item.format === "esm").map(([name]) => name);

const isCommonJs = (entry: string): boolean => entry.endsWith(".cjs");

const SHARED_MODULE = /[\\/]node_modules[\\/](zod|@zerodot[\\/][^\\/]+)[\\/]/;

/**
 * Forgets the modules a package loaded, so the next `require` reads the files again and the old
 * code can be freed. It walks the modules that the entry required and removes the ones inside
 * the nodes folder. zod and the zerodot packages stay: all packages share one copy.
 */
function evictModules(dir: string, entry: string): void {
  // The cache is keyed by real paths. A link in the path of the nodes folder would hide the modules.
  const real = realpathSync(entry);
  const cache = createRequire(real).cache;
  const root = cache[real];
  if (!root) return;
  const inside = join(realpathSync(dir), "node_modules");
  const gone = new Set<NodeJS.Module>();
  const walk = (module: NodeJS.Module): void => {
    if (gone.has(module)) return;
    const file = module.filename;
    if (module !== root && (!file.startsWith(inside) || SHARED_MODULE.test(file))) return;
    gone.add(module);
    for (const child of module.children) walk(child);
  };
  walk(root);
  for (const module of gone) delete cache[module.filename];
  // A module that stays holds its children in a list. Without this the old code stays reachable.
  for (const module of Object.values(cache)) {
    if (module) module.children = module.children.filter((child) => !gone.has(child));
  }
}

/** What `importPackage` found for the package that loads now. */
const pending = new Map<string, Pick<Loaded, "version" | "entry" | "format">>();

/** How many times a package was loaded as an ES module. It makes a new address each time. */
let esmLoads = 0;

async function importPackage(dir: string, name: string): Promise<Record<string, unknown>> {
  const entry = packageEntry(dir, name);
  const version = installedVersion(dir, name);
  if (!isOfficialPackage(name)) {
    // A community package runs in its own process. It cannot read the secrets of zerodot.
    pending.set(name, { version, entry, format: "isolated" });
    return importIsolated(name, entry, isCommonJs(entry) ? "cjs" : "esm", [dir]);
  }
  if (isCommonJs(entry)) {
    // The cache has no entry for this file, so `require` reads the file from disk.
    const exports = createRequire(entry)(entry) as Record<string, unknown>;
    pending.set(name, { version, entry, format: "cjs" });
    return exports;
  }
  // An ES module cannot be removed from memory. A new address loads a new copy (a small leak).
  pending.set(name, { version, entry, format: "esm" });
  return import(/* @vite-ignore */ `${pathToFileURL(entry).href}?v=${++esmLoads}`);
}

type UnloadHook = (name: string, nodeTypes: string[]) => Promise<void> | void;
const unloadHooks = new Set<UnloadHook>();

/**
 * Runs `hook` before a package is unloaded, with the node types it added. A process closes what
 * it keeps open for those nodes (for example listeners). Returns a function that removes the hook.
 */
export function onPackageUnload(hook: UnloadHook): () => void {
  unloadHooks.add(hook);
  return () => unloadHooks.delete(hook);
}

/**
 * Loads installed packages into this process. A package that is loaded already is skipped, unless
 * the version on disk changed: then it is unloaded and loaded again.
 */
export async function loadInstalled(dir: string, names: string[]): Promise<NodePackageReport[]> {
  for (const name of names) {
    const current = loaded.get(name);
    if (current && current.version !== installedVersion(dir, name)) await unloadPackage(name, dir);
  }
  const todo = names.filter((name) => !loaded.has(name));
  const reports = await loadNodePackages(
    todo,
    (name) => importPackage(dir, name),
    manifestReaderFor(dir),
  );
  for (const report of reports) {
    const found = pending.get(report.name);
    pending.delete(report.name);
    lastReports.set(report.name, report);
    if (report.error) {
      // The files are loaded. Remove them again, so a failed package leaves nothing in memory.
      if (found?.format === "cjs") evictModules(dir, found.entry);
      if (found?.format === "isolated") stopIsolated(report.name);
      continue;
    }
    if (found) {
      loaded.set(report.name, {
        ...found,
        nodes: report.added,
        credentialTypes: report.credentialTypes,
      });
    }
  }
  return reports;
}

/**
 * Removes a package from this process: its nodes, its credential types, and its code in memory.
 * A hook closes what the process keeps open for those nodes first.
 */
export async function unloadPackage(name: string, dir: string = nodesDir()): Promise<void> {
  const item = loaded.get(name);
  if (!item) return;
  for (const hook of unloadHooks) await hook(name, item.nodes);
  const { unregisterNodes } = await import("./index");
  unregisterNodes(item.nodes);
  unregisterCredentialTypes(item.credentialTypes);
  if (item.format === "cjs") evictModules(dir, item.entry);
  if (item.format === "isolated") stopIsolated(name);
  loaded.delete(name);
}

/**
 * Moves an installed package to `version` (newer or older) and runs it in this process. When the
 * new version does not install or load, the old version comes back, in the files and in memory,
 * and the error is thrown. The caller holds the install lock.
 */
export async function switchVersion(
  dir: string,
  name: string,
  version: string,
  deps: { install?: typeof installFromNpm } = {},
): Promise<NodePackageReport> {
  const install = deps.install ?? installFromNpm;
  const from = installedVersion(dir, name);
  try {
    await install(dir, name, version);
    const [report] = await loadInstalled(dir, [name]);
    if (report && !report.error) return report;
    throw new Error(report?.error ?? "The package did not load");
  } catch (error) {
    if (from) {
      await install(dir, name, from)
        .then(() => loadInstalled(dir, [name]))
        .catch(() => undefined);
    }
    throw error;
  }
}

export type WantedPackage = { name: string; version?: string };

export type SyncResult = { reports: NodePackageReport[]; versions: Record<string, string> };

/**
 * Makes this process match the wanted packages: installs what is missing from the folder, then
 * loads what is not loaded. A package with no version gets the newest one that fits. One package
 * that fails does not stop the others.
 */
export async function syncPackages(
  dir: string,
  wanted: WantedPackage[],
  deps: { resolve?: typeof resolveVersion; install?: typeof installFromNpm } = {},
): Promise<SyncResult> {
  const resolveVersionOf = deps.resolve ?? resolveVersion;
  const install = deps.install ?? installFromNpm;
  const reports: NodePackageReport[] = [];
  const versions: Record<string, string> = {};
  const ready: string[] = [];
  for (const { name, version } of wanted) {
    try {
      if (!isPackageName(name)) throw new Error(`"${name}" is not a valid package name`);
      const have = installedVersion(dir, name);
      if (have && (!version || version === have)) {
        versions[name] = have;
      } else {
        const target = version ?? (await resolveVersionOf(name));
        await install(dir, name, target);
        versions[name] = installedVersion(dir, name) ?? target;
      }
      ready.push(name);
    } catch (error) {
      reports.push({
        name,
        added: [],
        skipped: [],
        credentialTypes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const report of reports) lastReports.set(report.name, report);
  reports.push(...(await loadInstalled(dir, ready)));
  return { reports, versions };
}

/**
 * The packages to run: the ones from `ZERODOT_NODE_PACKAGES` (any version that fits) and the ones
 * an admin installed (the version that was installed). The env list wins for a name in both.
 */
export function mergeWanted(
  envNames: string[],
  installed: { name: string; version: string }[],
): WantedPackage[] {
  const wanted = new Map<string, WantedPackage>();
  for (const { name, version } of installed) wanted.set(name, { name, version });
  for (const name of envNames) wanted.set(name, { name });
  return [...wanted.values()];
}

/** Unloads packages that nobody wants any more, then makes this process match `wanted`. */
export async function reconcilePackages(
  dir: string,
  wanted: WantedPackage[],
  deps?: Parameters<typeof syncPackages>[2],
): Promise<SyncResult> {
  const names = new Set(wanted.map((item) => item.name));
  for (const name of [...loaded.keys()]) {
    if (!names.has(name)) {
      await unloadPackage(name, dir);
      lastReports.delete(name);
    }
  }
  return syncPackages(dir, wanted, deps);
}

export type SyncLog = (
  level: "info" | "error",
  message: string,
  fields: Record<string, unknown>,
) => void;

/**
 * A function that makes this process match `wanted()`. Calls run one at a time, so a burst of
 * "changed" messages cannot start two installs together. It never throws: it logs.
 */
export function createPackageSyncer(
  wanted: () => Promise<WantedPackage[]>,
  log: SyncLog,
  dir: string = nodesDir(),
): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return () => {
    chain = chain.then(async () => {
      try {
        const { reports } = await reconcilePackages(dir, await wanted());
        for (const report of reports) {
          log(report.error ? "error" : "info", "nodes.package", {
            name: report.name,
            added: report.added.length,
            skipped: report.skipped,
            error: report.error,
          });
        }
      } catch (error) {
        log("error", "nodes.sync_failed", { error: String(error) });
      }
    });
    return chain;
  };
}

/** A package in the catalog file of zerodot-nodes. */
export type CatalogPackage = {
  name: string;
  label: string;
  /** One short line for lists. */
  summary: string;
  /** The long text: what the package does and what it is for. */
  description: string;
  version: string;
  /** The node contract range of `version`. */
  sdk: string;
  /** Name of a built-in icon. */
  icon?: string;
  /** The icon of the package as a `data:image/...` URL. Another address is dropped. */
  iconUrl?: string;
  nodes: { type: string; label: string; description?: string }[];
};

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * Reads the catalog JSON: `{ packages: [...] }`. Entries with a wrong shape or name are dropped.
 * `allow` says which names the list can have: by default `@zerodot/*` only.
 */
export function parseCatalog(
  json: unknown,
  allow: (name: string) => boolean = isOfficialPackage,
): CatalogPackage[] {
  const list = (json as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) throw new Error('The catalog has no "packages" list');
  const packages: CatalogPackage[] = [];
  const seen = new Set<string>();
  for (const item of list as Record<string, unknown>[]) {
    if (!isText(item?.name) || !allow(item.name) || seen.has(item.name)) continue;
    if (!isText(item.version) || !parseVersion(item.version) || !isText(item.sdk)) continue;
    seen.add(item.name);
    const nodes = Array.isArray(item.nodes) ? item.nodes : [];
    packages.push({
      name: item.name,
      label: isText(item.label) ? item.label : item.name,
      summary: isText(item.summary) ? item.summary : "",
      description: isText(item.description) ? item.description : "",
      version: item.version,
      sdk: item.sdk,
      ...(isText(item.icon) ? { icon: item.icon } : {}),
      ...(isText(item.iconUrl) && item.iconUrl.startsWith("data:image/")
        ? { iconUrl: item.iconUrl }
        : {}),
      nodes: nodes
        .filter((node): node is { type: string; label?: unknown; description?: unknown } =>
          isText((node as { type?: unknown } | null)?.type),
        )
        .map((node) => ({
          type: node.type,
          label: isText(node.label) ? node.label : node.type,
          ...(isText(node.description) ? { description: node.description } : {}),
        })),
    });
  }
  return packages;
}

export const DEFAULT_CATALOG_URL =
  "https://raw.githubusercontent.com/zerodot-io/zerodot-nodes/main/catalog.json";

const CATALOG_TTL_MS = 10 * 60_000;
/** Read lists by address. The catalog and each registry have their own entry. */
const listCache = new Map<string, { at: number; value: unknown }>();

async function cached<T>(key: string, now: number, read: () => Promise<T>): Promise<T> {
  const hit = listCache.get(key);
  if (hit && now - hit.at < CATALOG_TTL_MS) return hit.value as T;
  const value = await read();
  listCache.set(key, { at: now, value });
  return value;
}

/** The list of packages one can install. Cached for ten minutes. Throws when the file is not reachable. */
export async function fetchCatalog(
  url: string = DEFAULT_CATALOG_URL,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<CatalogPackage[]> {
  return cached(`catalog:${url}`, now, async () => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`The catalog answered with status ${response.status}`);
    return parseCatalog(await response.json());
  });
}

export const clearCatalogCache = (): void => {
  listCache.clear();
};

// ---- Community registries ----

/**
 * A community registry is a `registry.json` file that anybody can host. It lists node packages on
 * npm that other people wrote. zerodot does not check these packages.
 */
export type Registry = {
  name: string;
  homepage: string | null;
  packages: CatalogPackage[];
};

/**
 * A package that a community registry can list. The name without the scope starts with
 * `zerodot-`, for example `zerodot-slack` or `@acme/zerodot-slack`. `@zerodot/*` names belong to
 * the official catalog.
 */
export const isCommunityPackage = (name: string): boolean =>
  isPackageName(name) &&
  !name.startsWith("@zerodot/") &&
  /^zerodot-[a-z0-9]/.test(name.slice(name.indexOf("/") + 1));

/** The address of a registry file: https only, with no user name or password in it. */
export function checkRegistryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The registry address is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("The registry address must start with https://");
  if (url.username || url.password) {
    throw new Error("The registry address cannot have a user name or a password");
  }
  url.hash = "";
  if (url.href.length > 2048) throw new Error("The registry address is too long");
  return url.href;
}

const isHttpsUrl = (value: unknown): value is string => {
  if (!isText(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Reads the registry JSON: `{ name, homepage?, packages: [...] }`. The entries have the shape of
 * catalog entries. Entries with a wrong shape, and `@zerodot/*` names, are dropped.
 */
export function parseRegistry(json: unknown): Registry {
  const root = json as { name?: unknown; homepage?: unknown } | null;
  if (!isText(root?.name)) throw new Error('The registry has no "name"');
  return {
    name: root.name.slice(0, 80),
    homepage: isHttpsUrl(root.homepage) ? root.homepage : null,
    packages: parseCatalog(json, isCommunityPackage),
  };
}

const REGISTRY_MAX_BYTES = 1_000_000;

/** The body of a response as text. Throws when it is larger than `max` bytes. */
async function readLimited(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error("The registry file is larger than 1 MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reads a community registry. Cached for ten minutes. Throws when the file is not reachable or not valid. */
export async function fetchRegistry(
  url: string,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<Registry> {
  const address = checkRegistryUrl(url);
  return cached(`registry:${address}`, now, async () => {
    // A redirect could go to an address that was not checked.
    const response = await fetchImpl(address, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`The registry answered with status ${response.status}`);
    let json: unknown;
    try {
      json = JSON.parse(await readLimited(response, REGISTRY_MAX_BYTES));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The registry file is not valid JSON");
      throw error;
    }
    return parseRegistry(json);
  });
}
