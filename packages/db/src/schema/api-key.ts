// SPDX-License-Identifier: AGPL-3.0-only
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

/** The better-auth key plugin does not fit: zerodot needs a project scope and a two-role model. */
export const apiKey = pgTable(
  "api_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** First characters of the key. The UI shows them so a user can tell keys apart. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the full key, hex. The full key is never stored. */
    keyHash: text("key_hash").notNull().unique(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_key_org_idx").on(t.organizationId, t.createdAt.desc())],
);
