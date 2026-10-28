// SPDX-License-Identifier: AGPL-3.0-only
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Settings of the whole instance that an instance admin changes on the System page. */
export const instanceSetting = pgTable("instance_setting", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
