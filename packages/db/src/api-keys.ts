// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { apiKey } from "./schema";

export const API_KEY_PREFIX = "zerodot_";
const SHOWN_PREFIX_LENGTH = API_KEY_PREFIX.length + 4;
/** `lastUsedAt` is written at most once in this time, so a busy key does not write on each call. */
const LAST_USED_GRANULARITY_MS = 60_000;

export type ApiKeyRole = "admin" | "member";

export type ApiKeySummary = {
  id: string;
  name: string;
  prefix: string;
  role: ApiKeyRole;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

const summaryColumns = {
  id: apiKey.id,
  name: apiKey.name,
  prefix: apiKey.prefix,
  role: apiKey.role,
  expiresAt: apiKey.expiresAt,
  lastUsedAt: apiKey.lastUsedAt,
  createdAt: apiKey.createdAt,
};

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** 32 random bytes. High entropy, so a plain SHA-256 is enough for the stored hash. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Keys of one organization. The full key is returned once, by `create`. */
export function apiKeys(db: Db, organizationId: string) {
  return {
    async list(): Promise<ApiKeySummary[]> {
      return db
        .select(summaryColumns)
        .from(apiKey)
        .where(eq(apiKey.organizationId, organizationId))
        .orderBy(desc(apiKey.createdAt), desc(apiKey.id));
    },

    async create(input: {
      name: string;
      role: ApiKeyRole;
      expiresAt: Date | null;
      userId: string | null;
    }): Promise<{ key: string; summary: ApiKeySummary }> {
      const key = generateApiKey();
      const [summary] = await db
        .insert(apiKey)
        .values({
          organizationId,
          name: input.name,
          prefix: key.slice(0, SHOWN_PREFIX_LENGTH),
          keyHash: hashApiKey(key),
          role: input.role,
          expiresAt: input.expiresAt,
          createdBy: input.userId,
        })
        .returning(summaryColumns);
      if (!summary) throw new Error("insert returned no row");
      return { key, summary };
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db
        .delete(apiKey)
        .where(and(eq(apiKey.organizationId, organizationId), eq(apiKey.id, id)))
        .returning({ id: apiKey.id });
      return rows.length > 0;
    },
  };
}

export type ApiKeyIdentity = {
  id: string;
  organizationId: string;
  role: ApiKeyRole;
  expiresAt: Date | null;
};

/**
 * Key lookup. The caller has no session, so the organization comes from the key.
 * Returns null for an unknown key. The caller checks `expiresAt`.
 */
export async function findApiKey(db: Db, key: string): Promise<ApiKeyIdentity | null> {
  const [row] = await db
    .select({
      id: apiKey.id,
      organizationId: apiKey.organizationId,
      role: apiKey.role,
      expiresAt: apiKey.expiresAt,
      lastUsedAt: apiKey.lastUsedAt,
    })
    .from(apiKey)
    .where(eq(apiKey.keyHash, hashApiKey(key)))
    .limit(1);
  if (!row) return null;
  const stale = !row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS;
  if (stale) {
    await db.update(apiKey).set({ lastUsedAt: sql`now()` }).where(eq(apiKey.id, row.id));
  }
  return {
    id: row.id,
    organizationId: row.organizationId,
    role: row.role,
    expiresAt: row.expiresAt,
  };
}
