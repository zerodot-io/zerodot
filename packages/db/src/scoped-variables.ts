// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { variable } from "./schema";
import { ConflictError } from "./scoped-credentials";

export type VariableRow = typeof variable.$inferSelect;
export type VariableInput = {
  key: string;
  type: VariableRow["type"];
  value: unknown;
  description: string;
};

function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

export function variables(db: Db, organizationId: string) {
  const owned = (key: string) =>
    and(eq(variable.organizationId, organizationId), eq(variable.key, key));

  return {
    async list(): Promise<VariableRow[]> {
      return db
        .select()
        .from(variable)
        .where(eq(variable.organizationId, organizationId))
        .orderBy(asc(variable.key));
    },

    /** All values as one object. The worker reads it once at the start of a run. */
    async asRecord(): Promise<Record<string, unknown>> {
      const rows = await db
        .select({ key: variable.key, value: variable.value })
        .from(variable)
        .where(eq(variable.organizationId, organizationId));
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    async count(): Promise<number> {
      const [row] = await db
        .select({ n: count() })
        .from(variable)
        .where(eq(variable.organizationId, organizationId));
      return row?.n ?? 0;
    },

    async create(input: VariableInput, userId: string | null): Promise<VariableRow> {
      try {
        const [row] = await db
          .insert(variable)
          .values({ organizationId, ...input, updatedBy: userId })
          .returning();
        if (!row) throw new Error("insert returned no row");
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError(`Variable "${input.key}" exists`);
        throw error;
      }
    },

    async update(
      key: string,
      input: Partial<Pick<VariableInput, "type" | "value" | "description">>,
      userId: string | null,
    ): Promise<VariableRow | null> {
      const [row] = await db
        .update(variable)
        .set({ ...input, updatedAt: new Date(), updatedBy: userId })
        .where(owned(key))
        .returning();
      return row ?? null;
    },

    async remove(key: string): Promise<boolean> {
      const rows = await db.delete(variable).where(owned(key)).returning({ id: variable.id });
      return rows.length > 0;
    },

    /**
     * Workflows whose draft or published graph reads this variable: $vars.key, $vars["key"],
     * or $vars['key']. A text search of the saved graph, so it can find a few extra matches.
     */
    async usedBy(key: string): Promise<{ id: string; name: string }[]> {
      const patterns = [`$vars.${key}`, `$vars[\\"${key}\\"]`, `$vars['${key}']`];
      const matches = (column: string) =>
        sql.join(
          patterns.map((p) => sql`strpos(${sql.raw(column)}::text, ${p}) > 0`),
          sql` or `,
        );
      const rows = await db.execute(sql`
        select w.id, w.name from workflow w
        where w.organization_id = ${organizationId}
          and (
            (${matches("w.draft_graph")})
            or exists (
              select 1 from workflow_version v
              where v.id = w.published_version_id and (${matches("v.graph")})
            )
          )
        order by w.name
      `);
      return Array.from(rows as unknown as { id: string; name: string }[]);
    },
  };
}
