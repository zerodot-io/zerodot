// SPDX-License-Identifier: AGPL-3.0-only
import { type Db, getNodePackages, recordAudit, setNodePackages } from "@zerodot/db";
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import { catalog as nodeCatalog } from "@zerodot/nodes";
import {
  type CatalogPackage,
  compatibleVersions,
  createPackageSyncer,
  fetchCatalog,
  fetchPackument,
  installedVersion,
  installFromNpm,
  isOfficialPackage,
  loadInstalled,
  mergeWanted,
  nodesDir,
  packageReports,
  reconcilePackages,
  resolveVersion,
  type SyncLog,
  switchVersion,
  uninstallFromNpm,
  withInstallLock,
} from "@zerodot/nodes/install";
import { parseNodePackages } from "@zerodot/nodes/load";
import { listenForNodesChanged, publishNodesChanged } from "@zerodot/queue";
import type { Redis } from "ioredis";
import { isInstanceAdmin, requireInstanceAdmin } from "./admin.server";
import { badRequest, conflict, notFound } from "./api/errors";
import { catalogUrl } from "./node-catalog";
import { getServices } from "./services.server";
import { sessionFor } from "./session.server";

/** The packages that `ZERODOT_NODE_PACKAGES` lists. They load at start and an admin cannot remove them. */
const envPackages = (env: Record<string, string | undefined> = process.env): string[] =>
  parseNodePackages(env.ZERODOT_NODE_PACKAGES);

/** False when `ZERODOT_NODES_INSTALL=false`: nobody installs or removes a package in the UI. */
export const installEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.ZERODOT_NODES_INSTALL ?? "true").trim().toLowerCase() !== "false";

/**
 * Loads the node packages at start, then again each time an admin changes them. `subscriber`
 * must be a connection that only subscribes.
 */
export async function startNodePackages(db: Db, subscriber: Redis, log: SyncLog): Promise<void> {
  const sync = createPackageSyncer(
    async () => mergeWanted(envPackages(), await getNodePackages(db)),
    log,
  );
  await sync();
  await listenForNodesChanged(subscriber, () => void sync()).catch((error) =>
    log("error", "nodes.subscribe_failed", { error: String(error) }),
  );
}

// ---- The Nodes page. Only instance admins can use it. ----

export type NodePackageView = {
  name: string;
  label: string;
  summary: string;
  description: string;
  /** The installed version, or null. */
  version: string | null;
  /** "env" packages come from ZERODOT_NODE_PACKAGES. An admin cannot remove them. */
  source: "ui" | "env" | null;
  status: "loaded" | "error" | "not-loaded" | "available";
  error?: string;
  /** The newest version in the catalog. */
  latest: string | null;
  /** False when `latest` needs a newer zerodot, so the update badge must not show. */
  compatible: boolean;
  icon: string | null;
  iconUrl: string | null;
  nodes: { type: string; label: string; description?: string }[];
};

export type NodePackagesOverview = {
  installEnabled: boolean;
  catalogUrl: string;
  /** Why the catalog could not be read. The installed packages still show. */
  catalogError: string | null;
  packages: NodePackageView[];
};

export async function nodePackagesOverview(headers: Headers): Promise<NodePackagesOverview> {
  await requireInstanceAdmin(headers);
  const { db } = await getServices();
  const installed = await getNodePackages(db);
  const fromEnv = new Set(envPackages());
  let catalog: CatalogPackage[] = [];
  let catalogError: string | null = null;
  try {
    catalog = await fetchCatalog(catalogUrl());
  } catch (error) {
    catalogError = error instanceof Error ? error.message : "The catalog is not reachable";
  }
  const reports = new Map(packageReports().map((report) => [report.name, report]));
  const byName = new Map<string, NodePackageView>();
  for (const item of catalog) {
    byName.set(item.name, {
      name: item.name,
      label: item.label,
      summary: item.summary,
      description: item.description,
      version: null,
      source: null,
      status: "available",
      latest: item.version,
      compatible: satisfiesSdk(item.sdk, SDK_VERSION),
      icon: item.icon ?? null,
      iconUrl: item.iconUrl ?? null,
      nodes: item.nodes,
    });
  }
  const names = new Set([...installed.map((item) => item.name), ...fromEnv]);
  for (const name of names) {
    const view = byName.get(name) ?? {
      name,
      label: name,
      summary: "",
      description: "",
      version: null,
      source: null,
      status: "not-loaded" as const,
      latest: null,
      compatible: false,
      icon: null,
      iconUrl: null,
      nodes: [],
    };
    const report = reports.get(name);
    view.version = installedVersion(nodesDir(), name);
    view.source = fromEnv.has(name) ? "env" : "ui";
    view.status = report?.error ? "error" : report ? "loaded" : "not-loaded";
    if (report?.error) view.error = report.error;
    // A loaded package shows the icon of its first node that has one. The catalog may lack it.
    const loaded = nodeCatalog.find(
      (entry) => report?.added.includes(entry.type) && (entry.iconUrl || entry.icon),
    );
    view.iconUrl = view.iconUrl ?? loaded?.iconUrl ?? null;
    view.icon = view.icon ?? loaded?.icon ?? null;
    byName.set(name, view);
  }
  return {
    installEnabled: installEnabled(),
    catalogUrl: catalogUrl(),
    catalogError,
    packages: [...byName.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function checkName(name: string): void {
  if (!isOfficialPackage(name)) throw badRequest("Only @zerodot/* packages can be installed");
  if (!installEnabled()) throw conflict("Installing packages is turned off on this instance");
}

/**
 * Installs the newest version that works with this zerodot, loads it here, and tells the other
 * processes. A package that does not load is removed again and not saved.
 */
export async function installNodePackage(
  headers: Headers,
  input: { name: string },
): Promise<{ name: string; version: string; added: string[] }> {
  const actor = await requireInstanceAdmin(headers);
  checkName(input.name);
  const { db, redis } = await getServices();
  const dir = nodesDir();
  const version = await resolveVersion(input.name);
  await installFromNpm(dir, input.name, version);
  const [report] = await loadInstalled(dir, [input.name]);
  if (!report || report.error) {
    await uninstallFromNpm(dir, input.name).catch(() => undefined);
    throw conflict(report?.error ?? "The package did not load");
  }
  const rest = (await getNodePackages(db)).filter((item) => item.name !== input.name);
  await setNodePackages(db, [...rest, { name: input.name, version }]);
  await recordAudit(db, {
    actor,
    action: "node_package.install",
    targetType: "node_package",
    targetId: input.name,
    details: { version },
  });
  await publishNodesChanged(redis);
  return { name: input.name, version, added: report.added };
}

export async function uninstallNodePackage(
  headers: Headers,
  input: { name: string },
): Promise<void> {
  const actor = await requireInstanceAdmin(headers);
  checkName(input.name);
  if (envPackages().includes(input.name)) {
    throw conflict("This package is in ZERODOT_NODE_PACKAGES. Remove it there");
  }
  const { db, redis } = await getServices();
  const rest = (await getNodePackages(db)).filter((item) => item.name !== input.name);
  await setNodePackages(db, rest);
  await reconcilePackages(nodesDir(), mergeWanted(envPackages(), rest));
  await uninstallFromNpm(nodesDir(), input.name);
  await recordAudit(db, {
    actor,
    action: "node_package.uninstall",
    targetType: "node_package",
    targetId: input.name,
  });
  await publishNodesChanged(redis);
}

/** Installable versions of an installed package: the ones that work with this zerodot, newest first. */
export async function nodePackageVersions(
  headers: Headers,
  input: { name: string },
): Promise<{ installed: string | null; versions: string[] }> {
  await requireInstanceAdmin(headers);
  checkName(input.name);
  return {
    installed: installedVersion(nodesDir(), input.name),
    versions: compatibleVersions(await fetchPackument(input.name)),
  };
}

/**
 * Moves an installed package to another version, up or down, and runs it in every process without
 * a restart. The old version comes back when the new one does not load.
 */
export async function updateNodePackage(
  headers: Headers,
  input: { name: string; version: string },
): Promise<{ name: string; from: string; to: string; added: string[] }> {
  const actor = await requireInstanceAdmin(headers);
  checkName(input.name);
  if (envPackages().includes(input.name)) {
    throw conflict("This package is in ZERODOT_NODE_PACKAGES. Change it there");
  }
  const { db, redis } = await getServices();
  const saved = await getNodePackages(db);
  const current = saved.find((item) => item.name === input.name);
  if (!current) throw notFound("Package");
  const dir = nodesDir();
  if (input.version === current.version) throw badRequest("This version is installed already");
  if (!compatibleVersions(await fetchPackument(input.name)).includes(input.version)) {
    throw badRequest(`Version ${input.version} does not work with this zerodot`);
  }
  const report = await withInstallLock(dir, () =>
    switchVersion(dir, input.name, input.version),
  ).catch((error: unknown) => {
    throw conflict(error instanceof Error ? error.message : "The package did not load");
  });
  const rest = saved.filter((item) => item.name !== input.name);
  await setNodePackages(db, [...rest, { name: input.name, version: input.version }]);
  await recordAudit(db, {
    actor,
    action: "node_package.update",
    targetType: "node_package",
    targetId: input.name,
    details: { from: current.version, to: input.version },
  });
  await publishNodesChanged(redis);
  return { name: input.name, from: current.version, to: input.version, added: report.added };
}

// ---- The Add node list. Any signed-in person can see what is available. ----

export type AvailableNodePackage = {
  name: string;
  label: string;
  summary: string;
  description: string;
  version: string;
  icon: string | null;
  iconUrl: string | null;
  nodes: { type: string; label: string; description?: string }[];
  /** False when the newest version needs a newer zerodot. */
  compatible: boolean;
};

export type AvailableNodePackages = {
  /** True for an instance admin when installing is on. */
  canInstall: boolean;
  catalogError: string | null;
  packages: AvailableNodePackage[];
};

/** The catalog packages that are not installed here. */
export async function availableNodePackages(headers: Headers): Promise<AvailableNodePackages> {
  const { session } = await sessionFor(headers);
  if (!session) throw notFound("Page");
  const { db } = await getServices();
  const have = new Set([...(await getNodePackages(db)).map((item) => item.name), ...envPackages()]);
  let catalogError: string | null = null;
  let packages: AvailableNodePackage[] = [];
  try {
    packages = (await fetchCatalog(catalogUrl()))
      .filter((item) => !have.has(item.name))
      .map((item) => ({
        name: item.name,
        label: item.label,
        summary: item.summary,
        description: item.description,
        version: item.version,
        icon: item.icon ?? null,
        iconUrl: item.iconUrl ?? null,
        nodes: item.nodes,
        compatible: satisfiesSdk(item.sdk, SDK_VERSION),
      }));
  } catch (error) {
    catalogError = error instanceof Error ? error.message : "The catalog is not reachable";
  }
  return {
    canInstall:
      installEnabled() &&
      (await isInstanceAdmin({ id: session.user.id, email: session.user.email })),
    catalogError,
    packages,
  };
}

// ---- Import a workflow that uses nodes this instance does not have. ----

export type NeededNodePackages = {
  /** True for an instance admin when installing is on. */
  canInstall: boolean;
  catalogError: string | null;
  /** Catalog packages that give one or more of the node types. */
  packages: (AvailableNodePackage & { types: string[] })[];
  /** Node types that no catalog package gives. */
  unknown: string[];
};

/** The catalog packages that give the node types. Any signed-in person. */
export async function packagesForNodeTypes(
  headers: Headers,
  types: string[],
): Promise<NeededNodePackages> {
  const available = await availableNodePackages(headers);
  const packages: NeededNodePackages["packages"] = [];
  const found = new Set<string>();
  for (const item of available.packages) {
    const given = item.nodes.map((node) => node.type).filter((type) => types.includes(type));
    if (given.length === 0) continue;
    for (const type of given) found.add(type);
    packages.push({ ...item, types: given });
  }
  return {
    canInstall: available.canInstall,
    catalogError: available.catalogError,
    packages,
    unknown: types.filter((type) => !found.has(type)),
  };
}
