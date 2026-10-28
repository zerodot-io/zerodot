// SPDX-License-Identifier: AGPL-3.0-only
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { organization } from "./auth";

/** One row for each project. A project without a row uses the defaults. */
export const projectSettings = pgTable("project_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Finished production runs older than this are deleted. Null uses the server default. */
  runRetentionDays: integer("run_retention_days"),
  /** IANA time zone for the cron triggers of the project. Null uses UTC. */
  timezone: text("timezone"),
});
