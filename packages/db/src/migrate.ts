// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { DbHandle } from "./client";

// Arbitrary constant key. Serializes concurrent starters (web replicas).
const MIGRATION_LOCK_KEY = 7_340_001;

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

export async function runMigrations({ db, client }: DbHandle, folder = MIGRATIONS_FOLDER) {
  const lockConn = await client.reserve();
  try {
    await lockConn`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(db, { migrationsFolder: folder });
  } finally {
    await lockConn`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    lockConn.release();
  }
}
