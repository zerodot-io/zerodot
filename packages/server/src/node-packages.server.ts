// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Db,
  getNodePackages,
  getNodeRegistries,
  type InstalledNodePackage,
  type NodeRegistry,
  recordAudit,
  setNodePackages,
  setNodeRegistries,
} from "@zerodot/db";
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import { catalog as nodeCatalog } from "@zerodot/nodes";
import {
  type CatalogPackage,
  checkPackumentIntegrity,
  checkRegistryUrl,
  clearCatalogCache,
  compatibleVersions,
  createPackageSyncer,
  DEFAULT_VERIFIED_URL,
  fetchCatalog,
  fetchPackument,
  fetchRegistry,
  fetchVerified,
  installedVersion,
  installFromNpm,
  isOfficialPackage,
  isPackageName,
  isVerified,
  loadInstalled,
  mergeWanted,
  nodesDir,
  packageReports,
  reconcilePackages,
  resolveVersion,
  type SyncLog,
  switchVersion,
  uninstallFromNpm,
  type VerifiedPackage,
  withInstallLock,
} from "@zerodot/nodes/install";
import { parseNodePackages, sdkMismatch } from "@zerodot/nodes/load";
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
 * True only when `ZERODOT_COMMUNITY_NODES=true`. Off by default: a community package runs code
 * that nobody checked. It runs in its own process, but it gets the credentials of its nodes.
 */
export const communityEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  installEnabled(env) && (env.ZERODOT_COMMUNITY_NODES ?? "").trim().toLowerCase() === "true";

/**
 * False when `ZERODOT_UNVERIFIED_NODES=false`: only community packages that the zerodot team
 * reviewed can be installed.
 */
export const unverifiedEnabled = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.ZERODOT_UNVERIFIED_NODES ?? "true").trim().toLowerCase() !== "false";

/** The reviewed community package versions. Empty when the list is not reachable. */
const verifiedList = (): Promise<VerifiedPackage[]> =>
  fetchVerified(process.env.ZERODOT_VERIFIED_NODES_URL || DEFAULT_VERIFIED_URL).catch(() => []);

/** The most registries one instance can have. Each one is read when the Nodes page opens. */
const MAX_REGISTRIES = 20;

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
  /** Why `latest` does not work with this zerodot, for a tooltip. Null when it works. */
  incompatible: string | null;
  icon: string | null;
  iconUrl: string | null;
  nodes: { type: string; label: string; description?: string }[];
  /** The community registry of the package. Null for an official package. */
  registry: { url: string; name: string } | null;
  /**
   * For a community package: the zerodot team reviewed the source of this version (the installed
   * one, or the one the registry lists). Always false for an official package.
   */
  verified: boolean;
};

export type NodeRegistryView = NodeRegistry & {
  /** Why the registry could not be read. */
  error: string | null;
  /** How many packages it lists. */
  count: number;
};

export type NodePackagesOverview = {
  installEnabled: boolean;
  /** True only when `ZERODOT_COMMUNITY_NODES=true` and installing is on. */
  communityEnabled: boolean;
  /** False when `ZERODOT_UNVERIFIED_NODES=false`: only verified community packages install. */
  unverifiedEnabled: boolean;
  catalogUrl: string;
  /** Why the catalog could not be read. The installed packages still show. */
  catalogError: string | null;
  registries: NodeRegistryView[];
  packages: NodePackageView[];
};

const errorText = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

const viewOf = (
  item: CatalogPackage,
  registry: NodePackageView["registry"],
  verified = false,
): NodePackageView => ({
  name: item.name,
  label: item.label,
  summary: item.summary,
  description: item.description,
  version: null,
  source: null,
  status: "available",
  latest: item.version,
  compatible: satisfiesSdk(item.sdk, SDK_VERSION),
  incompatible: satisfiesSdk(item.sdk, SDK_VERSION) ? null : sdkMismatch(item.label, item.sdk),
  icon: item.icon ?? null,
  iconUrl: item.iconUrl ?? null,
  nodes: item.nodes,
  registry,
  verified,
});

/** Drops the cached catalog and version lists, then reads them again. Instance admins only. */
export async function refreshNodePackages(headers: Headers): Promise<NodePackagesOverview> {
  await requireInstanceAdmin(headers);
  clearCatalogCache();
  return nodePackagesOverview(headers);
}

export async function nodePackagesOverview(headers: Headers): Promise<NodePackagesOverview> {
  await requireInstanceAdmin(headers);
  const { db } = await getServices();
  const installed = await getNodePackages(db);
  const saved = await getNodeRegistries(db);
  const fromEnv = new Set(envPackages());
  let catalog: CatalogPackage[] = [];
  let catalogError: string | null = null;
  const [verified, [catalogResult, ...registryResults]] = await Promise.all([
    saved.length > 0 || installed.some((item) => item.registry) ? verifiedList() : [],
    Promise.allSettled([
      fetchCatalog(catalogUrl()),
      ...saved.map((registry) => fetchRegistry(registry.url)),
    ]),
  ]);
  if (catalogResult?.status === "fulfilled") catalog = catalogResult.value;
  else catalogError = errorText(catalogResult?.reason, "The catalog is not reachable");
  const reports = new Map(packageReports().map((report) => [report.name, report]));
  const byName = new Map<string, NodePackageView>();
  for (const item of catalog) byName.set(item.name, viewOf(item, null));
  // An official package wins over a community one, and the first registry wins over the next.
  const registries: NodeRegistryView[] = saved.map((registry, index) => {
    const result = registryResults[index];
    if (result?.status !== "fulfilled") {
      return {
        ...registry,
        error: errorText(result?.reason, "The registry is not reachable"),
        count: 0,
      };
    }
    for (const item of result.value.packages) {
      if (!byName.has(item.name)) {
        byName.set(
          item.name,
          viewOf(
            item,
            { url: registry.url, name: registry.name },
            isVerified(verified, item.name, item.version, item.integrity),
          ),
        );
      }
    }
    return { ...registry, error: null, count: result.value.packages.length };
  });
  const savedByName = new Map(installed.map((item) => [item.name, item]));
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
      incompatible: null,
      icon: null,
      iconUrl: null,
      nodes: [],
      registry: null,
      verified: false,
    };
    // An installed community package keeps its registry, also when the registry is gone.
    const from = savedByName.get(name)?.registry;
    if (from && view.registry?.url !== from) {
      view.registry = { url: from, name: saved.find((r) => r.url === from)?.name ?? from };
    }
    const report = reports.get(name);
    view.version = installedVersion(nodesDir(), name);
    const entry = savedByName.get(name);
    if (entry?.registry && view.version) {
      view.verified = isVerified(verified, name, view.version, entry.integrity);
    }
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
    communityEnabled: communityEnabled(),
    unverifiedEnabled: unverifiedEnabled(),
    catalogUrl: catalogUrl(),
    catalogError,
    registries,
    packages: [...byName.values()].sort((a, b) => a.label.localeCompare(b.label)),
  };
}

function checkName(name: string): void {
  if (!isPackageName(name)) throw badRequest("This is not a valid package name");
  if (!installEnabled()) throw conflict("Installing packages is turned off on this instance");
}

const RISK_NOT_ACCEPTED =
  "A community package can run any code on this server. Accept the risk to continue";

/**
 * The version that a community registry lists for the package. The registry is read again, so the
 * admin installs the version that they saw and accepted, and no other one.
 */
async function communityVersion(
  db: Db,
  input: { name: string; registry: string; version?: string; acceptRisk?: boolean },
): Promise<{ version: string; integrity: string; verified: boolean }> {
  if (!communityEnabled()) {
    throw conflict(
      "Community packages are off on this instance. The operator sets ZERODOT_COMMUNITY_NODES=true to turn them on",
    );
  }
  if (input.acceptRisk !== true) throw badRequest(RISK_NOT_ACCEPTED);
  if (isOfficialPackage(input.name))
    throw badRequest("Install @zerodot/* packages from the catalog");
  if (!(await getNodeRegistries(db)).some((item) => item.url === input.registry)) {
    throw notFound("Registry");
  }
  const listed = (
    await fetchRegistry(input.registry).catch((error: unknown) => {
      throw conflict(errorText(error, "The registry is not reachable"));
    })
  ).packages.find((item) => item.name === input.name);
  if (!listed) throw notFound("Package in this registry");
  if (input.version && input.version !== listed.version) {
    throw conflict(
      `The registry now lists version ${listed.version}, not ${input.version}. Check the package again`,
    );
  }
  // parseRegistry keeps only entries with a checksum.
  const integrity = listed.integrity as string;
  const verified = isVerified(await verifiedList(), listed.name, listed.version, integrity);
  if (!verified && !unverifiedEnabled()) {
    throw conflict(
      "This instance installs verified community packages only (ZERODOT_UNVERIFIED_NODES=false)",
    );
  }
  const packument = await fetchPackument(input.name);
  if (!compatibleVersions(packument).includes(listed.version)) {
    throw badRequest(`Version ${listed.version} does not work with this zerodot`);
  }
  try {
    checkPackumentIntegrity(packument, input.name, listed.version, integrity);
  } catch (error) {
    throw conflict(errorText(error, "The checksum does not match"));
  }
  return { version: listed.version, integrity, verified };
}

/**
 * Installs a package, loads it here, and tells the other processes. An official package gets the
 * newest version that works with this zerodot. A community package gets the version that its
 * registry lists, and only when the admin accepted the risk. A package that does not load is
 * removed again and not saved.
 */
export async function installNodePackage(
  headers: Headers,
  input: { name: string; registry?: string; version?: string; acceptRisk?: boolean },
): Promise<{ name: string; version: string; added: string[] }> {
  const actor = await requireInstanceAdmin(headers);
  checkName(input.name);
  const { db, redis } = await getServices();
  const dir = nodesDir();
  const { registry } = input;
  if (!registry && !isOfficialPackage(input.name)) {
    throw badRequest("A package that is not @zerodot/* must come from a registry");
  }
  const community = registry ? await communityVersion(db, { ...input, registry }) : null;
  const version = community?.version ?? (await resolveVersion(input.name));
  // The lock keeps the other processes from running npm or loading files during the install.
  const [report] = await withInstallLock(dir, async () => {
    await installFromNpm(dir, input.name, version, undefined, community?.integrity).catch(
      (error: unknown) => {
        throw conflict(errorText(error, "The package did not install"));
      },
    );
    return loadInstalled(dir, [input.name]);
  });
  if (!report || report.error) {
    await uninstallFromNpm(dir, input.name).catch(() => undefined);
    throw conflict(report?.error ?? "The package did not load");
  }
  const rest = (await getNodePackages(db)).filter((item) => item.name !== input.name);
  const entry: InstalledNodePackage = {
    name: input.name,
    version,
    ...(registry && community ? { registry, integrity: community.integrity } : {}),
  };
  await setNodePackages(db, [...rest, entry]);
  await recordAudit(db, {
    actor,
    action: "node_package.install",
    targetType: "node_package",
    targetId: input.name,
    details:
      registry && community
        ? {
            version,
            registry,
            integrity: community.integrity,
            verified: community.verified,
            riskAccepted: true,
          }
        : { version },
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
  const installed = installedVersion(nodesDir(), input.name);
  const { db } = await getServices();
  const saved = (await getNodePackages(db)).find((item) => item.name === input.name);
  if (saved?.registry) {
    // A community package can only move to the version that its registry lists, with its checksum.
    const listed = await fetchRegistry(saved.registry)
      .then((registry) => registry.packages.find((item) => item.name === input.name))
      .catch(() => undefined);
    const versions = [...new Set([listed?.version, installed].filter((v): v is string => !!v))];
    return { installed, versions };
  }
  return { installed, versions: compatibleVersions(await fetchPackument(input.name)) };
}

/**
 * Moves an installed package to another version, up or down, and runs it in every process without
 * a restart. The old version comes back when the new one does not load.
 */
export async function updateNodePackage(
  headers: Headers,
  input: { name: string; version: string; acceptRisk?: boolean },
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
  // Another version of a community package is new code that nobody checked.
  if (current.registry && !communityEnabled()) {
    throw conflict(
      "Community packages are off on this instance. The operator sets ZERODOT_COMMUNITY_NODES=true to turn them on",
    );
  }
  if (current.registry && input.acceptRisk !== true) throw badRequest(RISK_NOT_ACCEPTED);
  const dir = nodesDir();
  if (input.version === current.version) throw badRequest("This version is installed already");
  const community = current.registry
    ? await communityVersion(db, {
        name: input.name,
        registry: current.registry,
        version: input.version,
        acceptRisk: true,
      })
    : null;
  if (!community && !compatibleVersions(await fetchPackument(input.name)).includes(input.version)) {
    throw badRequest(`Version ${input.version} does not work with this zerodot`);
  }
  const report = await withInstallLock(dir, () =>
    switchVersion(dir, input.name, input.version, {
      integrity: community?.integrity,
      fromIntegrity: current.integrity,
    }),
  ).catch((error: unknown) => {
    throw conflict(error instanceof Error ? error.message : "The package did not load");
  });
  const rest = saved.filter((item) => item.name !== input.name);
  await setNodePackages(db, [
    ...rest,
    {
      ...current,
      version: input.version,
      ...(community ? { integrity: community.integrity } : {}),
    },
  ]);
  await recordAudit(db, {
    actor,
    action: "node_package.update",
    targetType: "node_package",
    targetId: input.name,
    details: current.registry
      ? {
          from: current.version,
          to: input.version,
          registry: current.registry,
          integrity: community?.integrity ?? null,
          verified: community?.verified ?? false,
          riskAccepted: true,
        }
      : { from: current.version, to: input.version },
  });
  await publishNodesChanged(redis);
  return { name: input.name, from: current.version, to: input.version, added: report.added };
}

// ---- Community registries. Only instance admins can change them. ----

/**
 * Adds a community registry. The file is read first, so a bad address fails here. Its packages
 * show on the Nodes page. Nothing is installed.
 */
export async function addNodeRegistry(
  headers: Headers,
  input: { url: string; acceptRisk?: boolean },
): Promise<NodeRegistry> {
  const actor = await requireInstanceAdmin(headers);
  if (!communityEnabled()) {
    throw conflict(
      "Community packages are off on this instance. The operator sets ZERODOT_COMMUNITY_NODES=true to turn them on",
    );
  }
  if (input.acceptRisk !== true) {
    throw badRequest("A registry lists code that nobody checked. Accept the risk to continue");
  }
  let url: string;
  try {
    url = checkRegistryUrl(input.url);
  } catch (error) {
    throw badRequest(errorText(error, "The registry address is not valid"));
  }
  const { db } = await getServices();
  const saved = await getNodeRegistries(db);
  if (saved.some((item) => item.url === url))
    throw conflict("This registry is in the list already");
  if (saved.length >= MAX_REGISTRIES) {
    throw conflict(`An instance can have ${MAX_REGISTRIES} registries at most`);
  }
  const registry = await fetchRegistry(url).catch((error: unknown) => {
    throw badRequest(errorText(error, "The registry is not reachable"));
  });
  const added: NodeRegistry = { url, name: registry.name, addedAt: new Date().toISOString() };
  await setNodeRegistries(db, [...saved, added]);
  await recordAudit(db, {
    actor,
    action: "node_registry.add",
    targetType: "node_registry",
    targetId: url,
    details: { name: registry.name, packages: registry.packages.length, riskAccepted: true },
  });
  return added;
}

/** Removes a registry from the list. Packages that came from it stay installed. */
export async function removeNodeRegistry(headers: Headers, input: { url: string }): Promise<void> {
  const actor = await requireInstanceAdmin(headers);
  const { db } = await getServices();
  const saved = await getNodeRegistries(db);
  if (!saved.some((item) => item.url === input.url)) throw notFound("Registry");
  await setNodeRegistries(
    db,
    saved.filter((item) => item.url !== input.url),
  );
  await recordAudit(db, {
    actor,
    action: "node_registry.remove",
    targetType: "node_registry",
    targetId: input.url,
  });
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
  credentialTypes: string[];
  /** False when the newest version needs a newer zerodot. */
  compatible: boolean;
  /** Why the newest version does not work with this zerodot, for a tooltip. Null when it works. */
  incompatible: string | null;
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
        credentialTypes: item.credentialTypes ?? [],
        compatible: satisfiesSdk(item.sdk, SDK_VERSION),
        incompatible: satisfiesSdk(item.sdk, SDK_VERSION)
          ? null
          : sdkMismatch(item.label, item.sdk),
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
  /** True when `canInstall` and community packages are on. */
  canInstallCommunity: boolean;
  catalogError: string | null;
  /**
   * Packages that give one or more of the node types. Official packages first. `registry` is set
   * for a package from a community registry: it needs its own install, with the risk accepted.
   */
  packages: (AvailableNodePackage & {
    types: string[];
    registry: { url: string; name: string } | null;
    /** For a community package: the zerodot team reviewed this version. */
    verified: boolean;
  })[];
  /** Types that no package gives. */
  unknown: string[];
};

/** The node types of the package that are in `types`. */
const givenNodeTypes = (item: Pick<CatalogPackage, "nodes">, types: string[]) =>
  item.nodes.map((node) => node.type).filter((type) => types.includes(type));

/**
 * The credential types of the package that are in `types`. An older catalog has no credential
 * types: then a type matches when its first part is the first part of a node type of the package,
 * for example `github.token` and `github.api`.
 */
function givenCredentialTypes(
  item: Pick<CatalogPackage, "nodes" | "credentialTypes">,
  types: string[],
): string[] {
  if (item.credentialTypes) return item.credentialTypes.filter((type) => types.includes(type));
  const prefixes = new Set(item.nodes.map((node) => node.type.split(".")[0]));
  return types.filter((type) => prefixes.has(type.split(".")[0]));
}

/**
 * The packages that give the node types: from the official catalog, then from the community
 * registries for the types that are left. Any signed-in person.
 */
export function packagesForNodeTypes(
  headers: Headers,
  types: string[],
): Promise<NeededNodePackages> {
  return packagesFor(headers, types, givenNodeTypes);
}

/** The packages that give the credential types. Any signed-in person. */
export function packagesForCredentialTypes(
  headers: Headers,
  types: string[],
): Promise<NeededNodePackages> {
  return packagesFor(headers, types, givenCredentialTypes);
}

async function packagesFor(
  headers: Headers,
  types: string[],
  givenOf: (item: Pick<CatalogPackage, "nodes" | "credentialTypes">, types: string[]) => string[],
): Promise<NeededNodePackages> {
  const available = await availableNodePackages(headers);
  const packages: NeededNodePackages["packages"] = [];
  const found = new Set<string>();
  for (const item of available.packages) {
    const given = givenOf(item, types);
    if (given.length === 0) continue;
    for (const type of given) found.add(type);
    packages.push({ ...item, types: given, registry: null, verified: false });
  }
  if (communityEnabled() && types.some((type) => !found.has(type))) {
    const { db } = await getServices();
    const have = new Set([
      ...(await getNodePackages(db)).map((item) => item.name),
      ...envPackages(),
      ...packages.map((item) => item.name),
    ]);
    const saved = await getNodeRegistries(db);
    const [verified, results] = await Promise.all([
      verifiedList(),
      Promise.allSettled(saved.map((item) => fetchRegistry(item.url))),
    ]);
    saved.forEach((registry, index) => {
      const result = results[index];
      if (result?.status !== "fulfilled") return;
      for (const item of result.value.packages) {
        if (have.has(item.name)) continue;
        const given = givenOf(item, types).filter((type) => !found.has(type));
        if (given.length === 0) continue;
        for (const type of given) found.add(type);
        have.add(item.name);
        packages.push({
          name: item.name,
          label: item.label,
          summary: item.summary,
          description: item.description,
          version: item.version,
          icon: item.icon ?? null,
          iconUrl: item.iconUrl ?? null,
          nodes: item.nodes,
          credentialTypes: item.credentialTypes ?? [],
          compatible: satisfiesSdk(item.sdk, SDK_VERSION),
          incompatible: satisfiesSdk(item.sdk, SDK_VERSION)
            ? null
            : sdkMismatch(item.label, item.sdk),
          types: given,
          registry: { url: registry.url, name: registry.name },
          verified: isVerified(verified, item.name, item.version, item.integrity),
        });
      }
    });
  }
  return {
    canInstall: available.canInstall,
    canInstallCommunity: available.canInstall && communityEnabled(),
    catalogError: available.catalogError,
    packages,
    unknown: types.filter((type) => !found.has(type)),
  };
}
