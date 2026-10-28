// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { apiKeys } from "./api-keys";
import type { BlobSetup } from "./blob-setup";
import type { Db } from "./client";
import {
  invitation,
  member,
  organization,
  projectSettings,
  run,
  trigger,
  workflow,
} from "./schema";
import { credentials } from "./scoped-credentials";
import { runs } from "./scoped-runs";
import { settings } from "./scoped-settings";
import { stats } from "./scoped-stats";
import { tables } from "./scoped-tables";
import { variables } from "./scoped-variables";
import { workflows } from "./scoped-workflows";

export type { NewRun, NodeResultInput, RunListItem, RunNodeResultRow, RunRow } from "./scoped-runs";
export type {
  ErrorGroup,
  NodeAggregate,
  RunAggregate,
  StatsFilter,
  TimeseriesPoint,
  WorkflowStatsRow,
} from "./scoped-stats";
export type {
  GraphTriggerNode,
  TriggerRow,
  WorkflowRow,
  WorkflowVersionRow,
} from "./scoped-workflows";

/**
 * The only way route handlers read or write zerodot data.
 * Every query carries `organizationId`.
 */
export function forOrganization(
  db: Db,
  organizationId: string,
  options: {
    secretKey?: Buffer;
    tableMaxRows?: number;
    /** Blob store for large and binary node data. Not set: use `setBlobSetup`. Null: none. */
    blobs?: BlobSetup | null;
  } = {},
) {
  if (!organizationId) throw new Error("organizationId is required");
  return {
    organizationId,
    workflows: workflows(db, organizationId),
    apiKeys: apiKeys(db, organizationId),
    runs: runs(db, organizationId, options.blobs),
    credentials: credentials(db, organizationId, options.secretKey),
    variables: variables(db, organizationId),
    settings: settings(db, organizationId),
    stats: stats(db, organizationId),
    tables: tables(db, organizationId, { maxRows: options.tableMaxRows }),
  };
}

export type OrganizationScope = ReturnType<typeof forOrganization>;

/**
 * Webhook lookup. The caller has no session, so the organization comes from the trigger.
 * The token is the path of the trigger node when it has one, or its generated token.
 * Returns null when the token is unknown. The caller checks `active` and `publishedVersionId`.
 */
export async function findWebhookTrigger(db: Db, token: string) {
  const [row] = await db
    .select({
      triggerId: trigger.id,
      organizationId: trigger.organizationId,
      workflowId: trigger.workflowId,
      config: trigger.config,
      active: workflow.active,
      publishedVersionId: workflow.publishedVersionId,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .where(
      and(
        eq(trigger.type, "webhook"),
        sql`coalesce(nullif(${trigger.config}->>'path', ''), ${trigger.config}->>'token') = ${token}`,
      ),
    )
    .limit(1);
  if (!row) return null;
  const config = row.config as Record<string, unknown>;
  return { ...row, nodeId: String(config.nodeId ?? ""), nodeType: String(config.nodeType ?? "") };
}

/** Resolve a project slug to an organization the user belongs to. Null if not a member. */
export async function resolveMembership(db: Db, userId: string, slug: string) {
  const [row] = await db
    .select({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), eq(organization.slug, slug)))
    .limit(1);
  return row ?? null;
}

/** All projects a user belongs to. One query. */
export async function listMemberships(db: Db, userId: string) {
  return db
    .select({
      organizationId: organization.id,
      name: organization.name,
      slug: organization.slug,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt));
}

export async function hasPendingInvitation(db: Db, email: string): Promise<boolean> {
  const rows = await db
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(eq(invitation.email, email.toLowerCase()), eq(invitation.status, "pending")))
    .limit(1);
  return rows.length > 0;
}

/** Oldest project the user belongs to. Used as the default active project. */
export async function firstOrganizationId(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt))
    .limit(1);
  return row?.organizationId ?? null;
}

export type CronScheduleRow = {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  nodeId: string;
  expression: string;
  timezone: string;
};

function toSchedule(row: {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  config: unknown;
  workflowTimezone: string | null;
  projectTimezone: string | null;
}): CronScheduleRow {
  const config = row.config as { nodeId?: string; expression?: string; timezone?: string };
  return {
    triggerId: row.triggerId,
    workflowId: row.workflowId,
    organizationId: row.organizationId,
    nodeId: config.nodeId ?? "",
    expression: config.expression ?? "",
    // The node, then the workflow, then the project. An empty value falls through.
    timezone: config.timezone || row.workflowTimezone || row.projectTimezone || "UTC",
  };
}

/** Cron triggers of the active workflows that have a published version. Used at worker start. */
export async function listActiveCronSchedules(db: Db): Promise<CronScheduleRow[]> {
  const rows = await db
    .select({
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      organizationId: trigger.organizationId,
      config: trigger.config,
      workflowTimezone: workflow.timezone,
      projectTimezone: projectSettings.timezone,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .leftJoin(projectSettings, eq(projectSettings.organizationId, trigger.organizationId))
    .where(
      and(
        eq(trigger.type, "cron"),
        eq(workflow.active, true),
        isNotNull(workflow.publishedVersionId),
      ),
    );
  return rows.map(toSchedule);
}

/** The schedules one workflow needs now. Empty when it is not active or not published. */
export async function listWorkflowCronSchedules(
  db: Db,
  organizationId: string,
  workflowId: string,
): Promise<CronScheduleRow[]> {
  const rows = await db
    .select({
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      organizationId: trigger.organizationId,
      config: trigger.config,
      workflowTimezone: workflow.timezone,
      projectTimezone: projectSettings.timezone,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .leftJoin(projectSettings, eq(projectSettings.organizationId, trigger.organizationId))
    .where(
      and(
        eq(trigger.organizationId, organizationId),
        eq(trigger.workflowId, workflowId),
        eq(trigger.type, "cron"),
        eq(workflow.active, true),
        isNotNull(workflow.publishedVersionId),
      ),
    );
  return rows.map(toSchedule);
}

/** The workflows of a project that have a cron trigger. A time zone change syncs each of them. */
export async function listCronWorkflowIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workflowId: trigger.workflowId })
    .from(trigger)
    .where(and(eq(trigger.organizationId, organizationId), eq(trigger.type, "cron")));
  return rows.map((r) => r.workflowId);
}

/** The project of a run. The resume page has a signed link and no session, so it starts here. */
export async function findRunOrganization(db: Db, runId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: run.organizationId })
    .from(run)
    .where(eq(run.id, runId))
    .limit(1);
  return row?.organizationId ?? null;
}

export type PollScheduleRow = {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  nodeId: string;
  nodeType: string;
  intervalSeconds: number;
};

/** Poll interval in seconds when the node sets none. */
export const DEFAULT_POLL_INTERVAL_SECONDS = 300;
/** A shorter interval is raised to this. */
export const MIN_POLL_INTERVAL_SECONDS = 15;

function toPollSchedule(row: {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  config: unknown;
}): PollScheduleRow {
  const config = row.config as { nodeId?: string; nodeType?: string; intervalSeconds?: unknown };
  const given = Number(config.intervalSeconds);
  const seconds = Number.isFinite(given) && given > 0 ? given : DEFAULT_POLL_INTERVAL_SECONDS;
  return {
    triggerId: row.triggerId,
    workflowId: row.workflowId,
    organizationId: row.organizationId,
    nodeId: config.nodeId ?? "",
    nodeType: config.nodeType ?? "",
    intervalSeconds: Math.max(MIN_POLL_INTERVAL_SECONDS, Math.floor(seconds)),
  };
}

/** Poll triggers of the active workflows that have a published version. Used at worker start. */
export async function listActivePollSchedules(db: Db): Promise<PollScheduleRow[]> {
  const rows = await db
    .select({
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      organizationId: trigger.organizationId,
      config: trigger.config,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .where(
      and(
        eq(trigger.type, "poll"),
        eq(workflow.active, true),
        isNotNull(workflow.publishedVersionId),
      ),
    );
  return rows.map(toPollSchedule);
}

export type ListenTriggerRow = {
  triggerId: string;
  workflowId: string;
  organizationId: string;
  versionId: string;
  nodeId: string;
};

/** Listen triggers of the active workflows that have a published version. The worker keeps them open. */
export async function listActiveListenTriggers(db: Db): Promise<ListenTriggerRow[]> {
  const rows = await db
    .select({
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      organizationId: trigger.organizationId,
      versionId: workflow.publishedVersionId,
      config: trigger.config,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .where(
      and(
        eq(trigger.type, "listen"),
        eq(workflow.active, true),
        isNotNull(workflow.publishedVersionId),
      ),
    );
  return rows.flatMap((row) =>
    row.versionId
      ? [
          {
            triggerId: row.triggerId,
            workflowId: row.workflowId,
            organizationId: row.organizationId,
            versionId: row.versionId,
            nodeId: (row.config as { nodeId?: string }).nodeId ?? "",
          },
        ]
      : [],
  );
}

/** The poll triggers one workflow needs now. Empty when it is not active or not published. */
export async function listWorkflowPollSchedules(
  db: Db,
  organizationId: string,
  workflowId: string,
): Promise<PollScheduleRow[]> {
  const rows = await db
    .select({
      triggerId: trigger.id,
      workflowId: trigger.workflowId,
      organizationId: trigger.organizationId,
      config: trigger.config,
    })
    .from(trigger)
    .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
    .where(
      and(
        eq(trigger.organizationId, organizationId),
        eq(trigger.workflowId, workflowId),
        eq(trigger.type, "poll"),
        eq(workflow.active, true),
        isNotNull(workflow.publishedVersionId),
      ),
    );
  return rows.map(toPollSchedule);
}
