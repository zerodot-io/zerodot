// SPDX-License-Identifier: AGPL-3.0-only
import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { workflow } from "./workflow";

const organizationId = () =>
  text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });
const workflowId = () =>
  uuid("workflow_id")
    .notNull()
    .references(() => workflow.id, { onDelete: "cascade" });
const bucketStart = () => timestamp("bucket_start", { withTimezone: true }).notNull();
const mode = () => text("mode", { enum: ["production", "test"] }).notNull();
const durationBuckets = () => integer("duration_buckets").array().notNull();

/** Hourly (UTC) rollup of finished runs. Insights read this table, not `run`. */
export const runStats = pgTable(
  "run_stats",
  {
    organizationId: organizationId(),
    workflowId: workflowId(),
    bucketStart: bucketStart(),
    mode: mode(),
    triggerType: text("trigger_type").notNull(),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    cancelled: integer("cancelled").notNull().default(0),
    durationSumMs: bigint("duration_sum_ms", { mode: "number" }).notNull().default(0),
    /** Counts for a fixed log scale. See `stats-math.ts`. */
    durationBuckets: durationBuckets(),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.workflowId, t.bucketStart, t.mode, t.triggerType],
    }),
    index("run_stats_org_bucket_idx").on(t.organizationId, t.bucketStart),
  ],
);

export const nodeStats = pgTable(
  "node_stats",
  {
    organizationId: organizationId(),
    workflowId: workflowId(),
    nodeType: text("node_type").notNull(),
    nodeId: text("node_id").notNull(),
    bucketStart: bucketStart(),
    mode: mode(),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    durationSumMs: bigint("duration_sum_ms", { mode: "number" }).notNull().default(0),
    durationBuckets: durationBuckets(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.workflowId, t.nodeType, t.nodeId, t.bucketStart, t.mode],
    }),
    index("node_stats_org_bucket_idx").on(t.organizationId, t.bucketStart),
  ],
);

/** Failed runs grouped by a normalized error message. */
export const errorStats = pgTable(
  "error_stats",
  {
    organizationId: organizationId(),
    workflowId: workflowId(),
    fingerprint: text("fingerprint").notNull(),
    bucketStart: bucketStart(),
    mode: mode(),
    count: integer("count").notNull().default(0),
    sampleMessage: text("sample_message").notNull(),
    lastRunId: uuid("last_run_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({
      columns: [t.organizationId, t.workflowId, t.fingerprint, t.bucketStart, t.mode],
    }),
    index("error_stats_org_bucket_idx").on(t.organizationId, t.bucketStart),
  ],
);
