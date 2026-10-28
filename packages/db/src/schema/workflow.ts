// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

export const workflow = pgTable(
  "workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    active: boolean("active").notNull().default(false),
    draftGraph: jsonb("draft_graph")
      .notNull()
      .default(sql`'{"schema":1,"nodes":[],"edges":[]}'::jsonb`),
    publishedVersionId: uuid("published_version_id"),
    errorWorkflowId: uuid("error_workflow_id"),
    maxConcurrency: integer("max_concurrency"),
    minutesSavedPerRun: integer("minutes_saved_per_run"),
    /** IANA time zone for the cron triggers of the workflow. Null uses the project time zone. */
    timezone: text("timezone"),
    description: text("description"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Longest time one pass of a run may take, in seconds. Null uses the worker default. */
    timeoutSeconds: integer("timeout_seconds"),
    /** Keep the node data of production runs that succeed. */
    saveSuccessData: boolean("save_success_data").notNull().default(true),
    /** Keep the node data of production runs that fail. */
    saveFailureData: boolean("save_failure_data").notNull().default(true),
    /** Most automatic retries of a failed production run. 0 turns auto retry off. */
    autoRetryMax: integer("auto_retry_max").notNull().default(0),
    /** Wait before each automatic retry, in milliseconds. */
    autoRetryBackoffMs: integer("auto_retry_backoff_ms").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_org_created_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc())],
);

export const workflowVersion = pgTable(
  "workflow_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    graph: jsonb("graph").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("workflow_version_unique").on(t.workflowId, t.version)],
);

/**
 * A public link to a copy of a workflow. The copy is a `.zerodot.json` file, made when the link
 * is made or updated. It has no variable values and no credential data. A workflow can have many
 * links, for example one for each buyer.
 */
export const workflowShare = pgTable(
  "workflow_share",
  {
    /** The random token in the link. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    /** A name for the owner, for example the name of the buyer. */
    label: text("label"),
    file: jsonb("file").notNull(),
    /** Scrypt hash of the password, as `salt:hash` in hex. Null: anyone with the link can read it. */
    passwordHash: text("password_hash"),
    /** The link works for one read. Then `usedAt` is set and the link stops working. */
    singleUse: boolean("single_use").notNull().default(false),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workflow_share_workflow_idx").on(t.organizationId, t.workflowId, t.createdAt)],
);
