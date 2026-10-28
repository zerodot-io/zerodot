// SPDX-License-Identifier: AGPL-3.0-only
import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * One row for each change an instance admin makes on the System page.
 * `details` holds ids and counts only, never node data. The user id has no foreign key,
 * so the row stays when the user is deleted.
 */
export const adminAudit = pgTable(
  "admin_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: text("actor_user_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details").$type<Record<string, string | number | boolean | null>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("admin_audit_created_idx").on(t.createdAt.desc())],
);
