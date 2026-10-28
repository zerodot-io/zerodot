// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import type { DbHandle } from "./client";
import { runMigrations } from "./migrate";
import { organization } from "./schema";

/** Test helpers. Not for production code. */
export async function resetDatabase(handle: DbHandle) {
  await handle.db.execute(sql`drop schema if exists public cascade`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`create schema public`);
  await runMigrations(handle);
}

export async function seedOrganization(handle: DbHandle, id: string) {
  await handle.db.insert(organization).values({ id, name: id, slug: id, createdAt: new Date() });
}
