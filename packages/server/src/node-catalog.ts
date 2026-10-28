// SPDX-License-Identifier: AGPL-3.0-only
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import { DEFAULT_CATALOG_URL, fetchCatalog } from "@zerodot/nodes/install";

export const catalogUrl = (): string => process.env.ZERODOT_NODE_CATALOG_URL || DEFAULT_CATALOG_URL;

export type PackageForTypes = {
  name: string;
  label: string;
  version: string;
  /** False when the newest version needs a newer zerodot. */
  compatible: boolean;
  /** The node types of the question that this package gives. */
  types: string[];
};

/** The catalog packages that give the node types, and the types that no package gives. */
export async function catalogPackagesForTypes(types: string[]): Promise<{
  catalogError: string | null;
  packages: PackageForTypes[];
  unknown: string[];
}> {
  if (types.length === 0) return { catalogError: null, packages: [], unknown: [] };
  try {
    const packages: PackageForTypes[] = [];
    const found = new Set<string>();
    for (const item of await fetchCatalog(catalogUrl())) {
      const given = item.nodes.map((node) => node.type).filter((type) => types.includes(type));
      if (given.length === 0) continue;
      for (const type of given) found.add(type);
      packages.push({
        name: item.name,
        label: item.label,
        version: item.version,
        compatible: satisfiesSdk(item.sdk, SDK_VERSION),
        types: given,
      });
    }
    return { catalogError: null, packages, unknown: types.filter((type) => !found.has(type)) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The catalog is not reachable";
    return { catalogError: message, packages: [], unknown: types };
  }
}
