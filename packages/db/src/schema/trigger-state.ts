// SPDX-License-Identifier: AGPL-3.0-only
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { trigger } from "./run";

/** What a polling trigger remembers between polls. */
export const triggerState = pgTable("trigger_state", {
  triggerId: uuid("trigger_id")
    .primaryKey()
    .references(() => trigger.id, { onDelete: "cascade" }),
  cursor: jsonb("cursor"),
  /** Keys of the latest items that started a run, newest last. */
  seenKeys: jsonb("seen_keys").notNull().default([]),
  /** Hash of the node config. A changed config starts again, like a first poll. */
  configHash: text("config_hash"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  /** Message of the last failed poll. Null after a poll that worked. */
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
