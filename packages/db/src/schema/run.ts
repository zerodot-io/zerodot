// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { workflow, workflowVersion } from "./workflow";

export const trigger = pgTable(
  "trigger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["webhook", "cron", "poll", "listen", "manual"] }).notNull(),
    /** For webhook: nodeId, token, responseMode. */
    config: jsonb("config").notNull(),
  },
  (t) => [
    index("trigger_type_token_idx").on(t.type, sql`(${t.config}->>'token')`),
    index("trigger_workflow_idx").on(t.workflowId),
  ],
);

export const run = pgTable(
  "run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key"),
    /** Null for test runs. */
    versionId: uuid("version_id").references(() => workflowVersion.id, { onDelete: "set null" }),
    /** Only for test runs. */
    graphSnapshot: jsonb("graph_snapshot"),
    mode: text("mode", { enum: ["production", "test"] }).notNull(),
    status: text("status", {
      enum: ["queued", "running", "waiting", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("queued"),
    triggerType: text("trigger_type").notNull(),
    /** The trigger node that starts the run. */
    triggerNodeId: text("trigger_node_id"),
    triggerInput: jsonb("trigger_input"),
    /** Only for test runs that stop early: run to a node, or run one node. */
    testTarget: jsonb("test_target"),
    error: jsonb("error"),
    /** How many automatic retries came before this run. 0 for a run that is not an auto retry. */
    autoRetryAttempt: integer("auto_retry_attempt").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("run_idempotency_unique").on(t.workflowId, t.idempotencyKey),
    index("run_org_created_idx").on(t.organizationId, t.createdAt.desc(), t.id.desc()),
    index("run_workflow_created_idx").on(t.workflowId, t.createdAt.desc(), t.id.desc()),
    // The sweeper looks for runs that never finished. Few rows match, so the index stays small.
    index("run_unfinished_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} in ('queued', 'running')`),
    // Retention deletes the oldest finished runs of one mode, in batches.
    index("run_finished_retention_idx")
      .on(t.mode, t.createdAt)
      .where(sql`${t.status} in ('succeeded', 'failed', 'cancelled')`),
  ],
);

export const runNodeResult = pgTable(
  "run_node_result",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    nodeId: text("node_id").notNull(),
    attempt: integer("attempt").notNull(),
    status: text("status", {
      enum: ["running", "waiting", "succeeded", "failed", "skipped"],
    }).notNull(),
    /** The output port the node chose. */
    port: text("port"),
    input: jsonb("input"),
    output: jsonb("output"),
    /** Blob reference to the whole input, when it was too large for the row. `input` is then null. */
    inputRef: jsonb("input_ref"),
    /** Blob reference to the whole output, when it was too large for the row. `output` is then null. */
    outputRef: jsonb("output_ref"),
    error: jsonb("error"),
    /** The `console` calls of the node. */
    logs: jsonb("logs"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId, t.attempt] })],
);
