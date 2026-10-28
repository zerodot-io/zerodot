// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import { projectSettings } from "./schema";

export type ProjectSettings = {
  runRetentionDays: number | null;
  /** IANA time zone. Null uses UTC. */
  timezone: string | null;
};

export function settings(db: Db, organizationId: string) {
  return {
    async get(): Promise<ProjectSettings> {
      const [row] = await db
        .select()
        .from(projectSettings)
        .where(eq(projectSettings.organizationId, organizationId))
        .limit(1);
      return {
        runRetentionDays: row?.runRetentionDays ?? null,
        timezone: row?.timezone ?? null,
      };
    },

    async set(patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
      const values = { organizationId, ...patch };
      await db
        .insert(projectSettings)
        .values(values)
        .onConflictDoUpdate({ target: projectSettings.organizationId, set: patch });
      return this.get();
    },
  };
}
