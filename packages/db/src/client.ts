// SPDX-License-Identifier: AGPL-3.0-only
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end() };
}

export type DbHandle = ReturnType<typeof createDb>;
export type Db = DbHandle["db"];
