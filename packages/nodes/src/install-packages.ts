// SPDX-License-Identifier: AGPL-3.0-only
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import {
  loadNodePackages,
  type ManifestReader,
  type NodePackageReport,
  type PackageManifest,
} from "./load-packages";

const run = promisify(execFile);

const NPM_REGISTRY = "https://registry.npmjs.org";
const INSTALL_TIMEOUT_MS = 180_000;

/** Only packages of the zerodot organization can be installed for now. */
const OFFICIAL_PACKAGE = /^@zerodot\/[a-z0-9][a-z0-9-]*$/;
export const isOfficialPackage = (name: string): boolean =>
  name.length <= 214 && OFFICIAL_PACKAGE.test(name);

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

type Packument = {
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

export async function fetchPackument(
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Packument> {
  // The short form of the document has no custom fields, so it has no `zerodot.sdk`.
  const response = await fetchImpl(`${NPM_REGISTRY}/${name.replace("/", "%2f")}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) throw new Error(`The package "${name}" does not exist on npm`);
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

/** Install scripts do not run: package code runs only when a workflow runs it. */
export async function installFromNpm(
  dir: string,
  name: string,
  version: string,
  runner: NpmRunner = npm,
): Promise<void> {
  if (!isOfficialPackage(name)) throw new Error("Only @zerodot/* packages can be installed");
  ensureNodesDir(dir);
  await runner(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
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
  if (!isOfficialPackage(name)) throw new Error("Only @zerodot/* packages can be removed");
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

/** Node types that each loaded package added. A restart clears it. */
const loadedTypes = new Map<string, string[]>();
export const isLoaded = (name: string): boolean => loadedTypes.has(name);

/** Loads installed packages into this process. A package that is loaded already is skipped. */
export async function loadInstalled(dir: string, names: string[]): Promise<NodePackageReport[]> {
  const todo = names.filter((name) => !loadedTypes.has(name));
  const reports = await loadNodePackages(
    todo,
    (name) => import(/* @vite-ignore */ pathToFileURL(packageEntry(dir, name)).href),
    manifestReaderFor(dir),
  );
  for (const report of reports) {
    lastReports.set(report.name, report);
    if (!report.error) loadedTypes.set(report.name, report.added);
  }
  return reports;
}

/** Removes the nodes of a package from this process. Credential types stay until a restart. */
export async function unloadPackage(name: string): Promise<void> {
  const { unregisterNodes } = await import("./index");
  unregisterNodes(loadedTypes.get(name) ?? []);
  loadedTypes.delete(name);
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
      if (!isOfficialPackage(name)) throw new Error("Only @zerodot/* packages can be installed");
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
  for (const name of [...loadedTypes.keys()]) {
    if (!names.has(name)) {
      await unloadPackage(name);
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

/** Reads the catalog JSON: `{ packages: [...] }`. Entries with a wrong shape or name are dropped. */
export function parseCatalog(json: unknown): CatalogPackage[] {
  const list = (json as { packages?: unknown } | null)?.packages;
  if (!Array.isArray(list)) throw new Error('The catalog has no "packages" list');
  const packages: CatalogPackage[] = [];
  for (const item of list as Record<string, unknown>[]) {
    if (!isText(item?.name) || !isOfficialPackage(item.name)) continue;
    if (!isText(item.version) || !isText(item.sdk)) continue;
    const nodes = Array.isArray(item.nodes) ? item.nodes : [];
    packages.push({
      name: item.name,
      label: isText(item.label) ? item.label : item.name,
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
let cachedCatalog: { url: string; at: number; packages: CatalogPackage[] } | null = null;

/** The list of packages one can install. Cached for ten minutes. Throws when the file is not reachable. */
export async function fetchCatalog(
  url: string = DEFAULT_CATALOG_URL,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<CatalogPackage[]> {
  if (cachedCatalog && cachedCatalog.url === url && now - cachedCatalog.at < CATALOG_TTL_MS) {
    return cachedCatalog.packages;
  }
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`The catalog answered with status ${response.status}`);
  const packages = parseCatalog(await response.json());
  cachedCatalog = { url, at: now, packages };
  return packages;
}

export const clearCatalogCache = (): void => {
  cachedCatalog = null;
};
