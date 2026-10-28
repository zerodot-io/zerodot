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

/** A node package that an instance admin installed. */
export type InstalledNodePackage = { name: string; version: string };

export async function getNodePackages(db: Db): Promise<InstalledNodePackage[]> {
  const [row] = await db
    .select({ value: instanceSetting.value })
    .from(instanceSetting)
    .where(eq(instanceSetting.key, NODE_PACKAGES))
    .limit(1);
  if (!row) return [];
  try {
    const list: unknown = JSON.parse(row.value);
    if (!Array.isArray(list)) return [];
    return list.filter(
      (item): item is InstalledNodePackage =>
        typeof item?.name === "string" && typeof item?.version === "string",
    );
  } catch {
    return [];
  }
}

export async function setNodePackages(db: Db, list: InstalledNodePackage[]): Promise<void> {
  const value = JSON.stringify(list);
  await db
    .insert(instanceSetting)
    .values({ key: NODE_PACKAGES, value })
    .onConflictDoUpdate({ target: instanceSetting.key, set: { value, updatedAt: new Date() } });
}
