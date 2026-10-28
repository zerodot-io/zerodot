// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import {
  customType,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const credential = pgTable(
  "credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    /** AES-256-GCM, see crypto.ts. The data never leaves the server. */
    dataEncrypted: bytea("data_encrypted").notNull(),
    /** `needs_reconnect`: the provider refused the refresh token. The user must connect again. */
    status: text("status", { enum: ["ok", "needs_reconnect"] })
      .notNull()
      .default("ok"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("credential_name_unique").on(t.organizationId, t.name)],
);

export const variable = pgTable(
  "variable",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    type: text("type", { enum: ["string", "number", "boolean", "json"] }).notNull(),
    value: jsonb("value").notNull().default(sql`'null'::jsonb`),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    unique("variable_key_unique").on(t.organizationId, t.key),
    index("variable_org_idx").on(t.organizationId),
  ],
);
