// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { open, seal } from "./crypto";
import { credential } from "./schema";

export class ConflictError extends Error {}

export type CredentialStatus = "ok" | "needs_reconnect";

export type CredentialSummary = {
  id: string;
  name: string;
  type: string;
  status: CredentialStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialListItem = CredentialSummary & {
  /** True when the data has an OAuth2 access token. The token itself never leaves the server. */
  connected: boolean;
};

const hasAccessToken = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  typeof (data as { accessToken?: unknown }).accessToken === "string";

export type OpenedCredential = {
  id: string;
  name: string;
  type: string;
  status: CredentialStatus;
  data: Record<string, unknown>;
};

export type RefreshOutcome = { data: Record<string, unknown> } | { status: "needs_reconnect" };

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code;
  const causeCode = (error as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505" || causeCode === "23505";
}

/**
 * Credentials of one organization. The data is sealed with ZERODOT_SECRET_KEY and the organization id.
 * Only `open` returns the data. Use it in the worker. Never send its result to the browser.
 */
export function credentials(db: Db, organizationId: string, secretKey: Buffer | undefined) {
  const owned = (id: string) =>
    and(eq(credential.organizationId, organizationId), eq(credential.id, id));
  const key = () => {
    if (!secretKey) throw new Error("ZERODOT_SECRET_KEY is not set");
    return secretKey;
  };

  return {
    async list(): Promise<CredentialListItem[]> {
      const rows = await db
        .select({
          id: credential.id,
          name: credential.name,
          type: credential.type,
          status: credential.status,
          dataEncrypted: credential.dataEncrypted,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
        })
        .from(credential)
        .where(eq(credential.organizationId, organizationId))
        .orderBy(asc(credential.name));
      return rows.map(({ dataEncrypted, ...row }) => ({
        ...row,
        connected: hasAccessToken(open(key(), dataEncrypted, organizationId)),
      }));
    },

    async create(input: {
      name: string;
      type: string;
      data: Record<string, unknown>;
    }): Promise<CredentialSummary> {
      try {
        const [row] = await db
          .insert(credential)
          .values({
            organizationId,
            name: input.name,
            type: input.type,
            dataEncrypted: seal(key(), input.data, organizationId),
          })
          .returning({
            id: credential.id,
            name: credential.name,
            type: credential.type,
            status: credential.status,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
          });
        if (!row) throw new Error("insert returned no row");
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError("A credential with this name exists");
        throw error;
      }
    },

    /**
     * Rename, and change data. A field that is missing or empty in `patch` keeps its value,
     * so the form never needs the saved secret.
     */
    async update(
      id: string,
      input: { name?: string; patch?: Record<string, unknown> },
    ): Promise<CredentialSummary | null> {
      const [existing] = await db.select().from(credential).where(owned(id)).limit(1);
      if (!existing) return null;
      const set: Partial<typeof credential.$inferInsert> = { updatedAt: new Date() };
      if (input.name !== undefined) set.name = input.name;
      if (input.patch) {
        const current = open(key(), existing.dataEncrypted, organizationId) as Record<
          string,
          unknown
        >;
        const next = { ...current };
        for (const [field, value] of Object.entries(input.patch)) {
          if (value !== undefined && value !== "") next[field] = value;
        }
        set.dataEncrypted = seal(key(), next, organizationId);
      }
      try {
        const [row] = await db.update(credential).set(set).where(owned(id)).returning({
          id: credential.id,
          name: credential.name,
          type: credential.type,
          status: credential.status,
          createdAt: credential.createdAt,
          updatedAt: credential.updatedAt,
        });
        return row ?? null;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError("A credential with this name exists");
        throw error;
      }
    },

    /** The id of the credential with this name, or null. Names are unique inside a project. */
    async idByName(name: string): Promise<string | null> {
      const [row] = await db
        .select({ id: credential.id })
        .from(credential)
        .where(and(eq(credential.organizationId, organizationId), eq(credential.name, name)))
        .limit(1);
      return row?.id ?? null;
    },

    /** The decrypted data. For the worker only. */
    async open(id: string): Promise<OpenedCredential | null> {
      const [row] = await db.select().from(credential).where(owned(id)).limit(1);
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        status: row.status,
        data: open(key(), row.dataEncrypted, organizationId) as Record<string, unknown>,
      };
    },

    /**
     * Change the data of a credential that needs a refresh. The row stays locked while `refresh`
     * runs, so two callers cannot use the same refresh token at once. The second caller waits,
     * reads the new data, and `refresh` sees it. `refresh` returns:
     * - `{ data }` to save new data and set the status to `ok`,
     * - `{ status: "needs_reconnect" }` to keep the data and mark the credential,
     * - `null` to change nothing (the data is fresh).
     * If `refresh` throws, nothing changes.
     */
    async refresh(
      id: string,
      refresh: (current: OpenedCredential) => Promise<RefreshOutcome | null>,
    ): Promise<OpenedCredential | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(credential).where(owned(id)).limit(1).for("update");
        if (!row) return null;
        const current: OpenedCredential = {
          id: row.id,
          name: row.name,
          type: row.type,
          status: row.status,
          data: open(key(), row.dataEncrypted, organizationId) as Record<string, unknown>,
        };
        const outcome = await refresh(current);
        if (!outcome) return current;
        if ("data" in outcome) {
          await tx
            .update(credential)
            .set({
              dataEncrypted: seal(key(), outcome.data, organizationId),
              status: "ok",
              updatedAt: new Date(),
            })
            .where(owned(id));
          return { ...current, status: "ok", data: outcome.data };
        }
        await tx
          .update(credential)
          .set({ status: outcome.status, updatedAt: new Date() })
          .where(owned(id));
        return { ...current, status: outcome.status };
      });
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db.delete(credential).where(owned(id)).returning({ id: credential.id });
      return rows.length > 0;
    },

    /**
     * Workflows whose draft or published graph uses this credential: it is picked on a node, or
     * a config reads `$credentials["name"]`. The second check is a text search of the saved graph,
     * so it can find a few extra matches.
     */
    async usedBy(id: string): Promise<{ id: string; name: string }[]> {
      const needle = JSON.stringify({ nodes: [{ credentialId: id }] });
      const [row] = await db
        .select({ name: credential.name })
        .from(credential)
        .where(owned(id))
        .limit(1);
      // The patterns are in the form the JSON text has, so a quote in a name is escaped.
      const patterns = row
        ? [`$credentials["${row.name}"]`, `$credentials['${row.name}']`].map((p) =>
            JSON.stringify(p).slice(1, -1),
          )
        : [];
      const byName = (column: string) =>
        sql.join(
          [sql`false`, ...patterns.map((p) => sql`strpos(${sql.raw(column)}::text, ${p}) > 0`)],
          sql` or `,
        );
      const rows = await db.execute(sql`
        select w.id, w.name from workflow w
        where w.organization_id = ${organizationId}
          and (
            w.draft_graph @> ${needle}::jsonb
            or (${byName("w.draft_graph")})
            or exists (
              select 1 from workflow_version v
              where v.id = w.published_version_id
                and (v.graph @> ${needle}::jsonb or (${byName("v.graph")}))
            )
          )
        order by w.name
      `);
      return Array.from(rows as unknown as { id: string; name: string }[]);
    },
  };
}

/** Re-seal every credential with a new key. One transaction. Returns the number of rows. */
export async function rotateSecretKey(db: Db, oldKey: Buffer, newKey: Buffer): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(credential);
    for (const row of rows) {
      const data = open(oldKey, row.dataEncrypted, row.organizationId);
      await tx
        .update(credential)
        .set({ dataEncrypted: seal(newKey, data, row.organizationId) })
        .where(eq(credential.id, row.id));
    }
    return rows.length;
  });
}
