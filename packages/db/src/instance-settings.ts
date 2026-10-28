// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { instanceSetting } from "./schema";

const SIGNUP_DISABLED = "signup_disabled";

/** True when an instance admin turned public signup off. The ZERODOT_SIGNUP_DISABLED variable is separate. */
export async function getSignupDisabled(db: Db): Promise<boolean> {
  const [row] = await db
    .select({ value: instanceSetting.value })
    .from(instanceSetting)
    .where(eq(instanceSetting.key, SIGNUP_DISABLED))
    .limit(1);
  return row?.value === "true";
}

export async function setSignupDisabled(db: Db, disabled: boolean): Promise<void> {
  const value = String(disabled);
  await db
    .insert(instanceSetting)
    .values({ key: SIGNUP_DISABLED, value })
    .onConflictDoUpdate({ target: instanceSetting.key, set: { value, updatedAt: new Date() } });
}

const NODE_PACKAGES = "node_packages";

/**
 * A node package that an instance admin installed. `registry` is the address of the community
 * registry it came from. An official package has none.
 */
export type InstalledNodePackage = { name: string; version: string; registry?: string };

/** The JSON list in a setting. An empty list when the setting is missing or not valid. */
async function readList(db: Db, key: string): Promise<unknown[]> {
  const [row] = await db
    .select({ value: instanceSetting.value })
    .from(instanceSetting)
    .where(eq(instanceSetting.key, key))
    .limit(1);
  if (!row) return [];
  try {
    const list: unknown = JSON.parse(row.value);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function writeList(db: Db, key: string, list: unknown[]): Promise<void> {
  const value = JSON.stringify(list);
  await db
    .insert(instanceSetting)
    .values({ key, value })
    .onConflictDoUpdate({ target: instanceSetting.key, set: { value, updatedAt: new Date() } });
}

export async function getNodePackages(db: Db): Promise<InstalledNodePackage[]> {
  return (await readList(db, NODE_PACKAGES)).filter(
    (item): item is InstalledNodePackage =>
      typeof (item as InstalledNodePackage | null)?.name === "string" &&
      typeof (item as InstalledNodePackage | null)?.version === "string",
  );
}

export async function setNodePackages(db: Db, list: InstalledNodePackage[]): Promise<void> {
  await writeList(db, NODE_PACKAGES, list);
}

const NODE_REGISTRIES = "node_registries";

/** A community registry of node packages that an instance admin added. */
export type NodeRegistry = { url: string; name: string; addedAt: string };

export async function getNodeRegistries(db: Db): Promise<NodeRegistry[]> {
  return (await readList(db, NODE_REGISTRIES)).filter(
    (item): item is NodeRegistry =>
      typeof (item as NodeRegistry | null)?.url === "string" &&
      typeof (item as NodeRegistry | null)?.name === "string" &&
      typeof (item as NodeRegistry | null)?.addedAt === "string",
  );
}

export async function setNodeRegistries(db: Db, list: NodeRegistry[]): Promise<void> {
  await writeList(db, NODE_REGISTRIES, list);
}
