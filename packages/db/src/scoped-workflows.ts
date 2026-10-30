// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, lt, max, notInArray, or, sql } from "drizzle-orm";
import type { Db } from "./client";
import { decodeCursor, type Page, pageOf } from "./cursor";
import { trigger, triggerState, workflow, workflowShare, workflowVersion } from "./schema";

export type WorkflowRow = typeof workflow.$inferSelect;
export type WorkflowVersionRow = typeof workflowVersion.$inferSelect;
export type TriggerRow = typeof trigger.$inferSelect;
export type WorkflowShareRow = typeof workflowShare.$inferSelect;

export type WorkflowSettingsPatch = Partial<
  Pick<
    WorkflowRow,
    | "description"
    | "tags"
    | "timeoutSeconds"
    | "saveSuccessData"
    | "saveFailureData"
    | "errorWorkflowId"
    | "autoRetryMax"
    | "autoRetryBackoffMs"
  >
>;

/** A trigger node as the graph describes it. Only the fields that sync needs. */
export type GraphTriggerNode = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  /** True when the node type polls (its definition has `poll`). */
  poll?: boolean;
  /** True when the node type listens (its definition has `listen`). */
  listen?: boolean;
  /** True when the node type has a webhook lifecycle (its definition has `webhook`). */
  webhook?: boolean;
};

const TRIGGER_TYPES = {
  "trigger.webhook": "webhook",
  "trigger.cron": "cron",
  "trigger.manual": "manual",
} as const;

function triggerKind(
  nodeType: string,
  poll = false,
  listen = false,
  webhook = false,
): "webhook" | "cron" | "poll" | "listen" | "manual" | undefined {
  if (poll) return "poll";
  if (listen) return "listen";
  if (webhook) return "webhook";
  return TRIGGER_TYPES[nodeType as keyof typeof TRIGGER_TYPES];
}

const nodeStateOf = (config: unknown) => (config as { nodeState?: unknown } | undefined)?.nodeState;

export function workflows(db: Db, organizationId: string) {
  const owned = (id: string) =>
    and(eq(workflow.organizationId, organizationId), eq(workflow.id, id));

  async function triggerOfType(triggerId: string, type: "poll" | "listen") {
    const [row] = await db
      .select({
        workflowId: trigger.workflowId,
        workflowName: workflow.name,
        config: trigger.config,
        active: workflow.active,
        publishedVersionId: workflow.publishedVersionId,
      })
      .from(trigger)
      .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
      .where(
        and(
          eq(trigger.organizationId, organizationId),
          eq(trigger.id, triggerId),
          eq(trigger.type, type),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  return {
    async list({
      limit = 50,
      cursor,
    }: {
      limit?: number;
      cursor?: string;
    } = {}): Promise<Page<WorkflowRow>> {
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await db
        .select()
        .from(workflow)
        .where(
          and(
            eq(workflow.organizationId, organizationId),
            after
              ? or(
                  lt(workflow.createdAt, after.createdAt),
                  and(eq(workflow.createdAt, after.createdAt), lt(workflow.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(workflow.createdAt), desc(workflow.id))
        .limit(limit + 1);
      return pageOf(rows, limit);
    },

    /** Names of the workflows that are the name, or the name with a number after it. */
    async namesLike(name: string): Promise<string[]> {
      const rows = await db
        .select({ name: workflow.name })
        .from(workflow)
        .where(
          and(
            eq(workflow.organizationId, organizationId),
            or(eq(workflow.name, name), sql`starts_with(${workflow.name}, ${`${name} `})`),
          ),
        );
      return rows.map((row) => row.name);
    },

    async get(id: string): Promise<WorkflowRow | null> {
      const [row] = await db.select().from(workflow).where(owned(id)).limit(1);
      return row ?? null;
    },

    async create(input: { name: string }): Promise<WorkflowRow> {
      const [row] = await db
        .insert(workflow)
        .values({ organizationId, name: input.name })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    async rename(id: string, name: string): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ name, updatedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /** Minutes one succeeded run saves. Null clears the value. Insights use it for time saved. */
    async setMinutesSaved(id: string, minutes: number | null): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ minutesSavedPerRun: minutes, updatedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /** IANA time zone of the cron triggers. Null uses the project time zone. */
    async setTimezone(id: string, timezone: string | null): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ timezone, updatedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /** Fields of the workflow settings. A missing field stays as it is. */
    async updateSettings(id: string, patch: WorkflowSettingsPatch): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ ...patch, updatedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /**
     * With `ifUpdatedAt`, the draft is saved only when the row did not change since then. Null when
     * the workflow does not exist, or it changed.
     */
    async saveDraft(
      id: string,
      draftGraph: unknown,
      options: { ifUpdatedAt?: Date } = {},
    ): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ draftGraph, updatedAt: new Date() })
        .where(
          options.ifUpdatedAt
            ? and(
                owned(id),
                // A JS date has milliseconds. Postgres can keep microseconds (defaultNow).
                sql`date_trunc('milliseconds', ${workflow.updatedAt}) = ${options.ifUpdatedAt.toISOString()}`,
              )
            : owned(id),
        )
        .returning();
      return row ?? null;
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db.delete(workflow).where(owned(id)).returning({ id: workflow.id });
      return rows.length > 0;
    },

    /** The share links of a workflow, newest first. */
    async listShares(workflowId: string): Promise<WorkflowShareRow[]> {
      return db
        .select()
        .from(workflowShare)
        .where(
          and(
            eq(workflowShare.organizationId, organizationId),
            eq(workflowShare.workflowId, workflowId),
          ),
        )
        .orderBy(desc(workflowShare.createdAt));
    },

    /** One share link by its token, or null. */
    async getShare(token: string): Promise<WorkflowShareRow | null> {
      const [row] = await db
        .select()
        .from(workflowShare)
        .where(and(eq(workflowShare.organizationId, organizationId), eq(workflowShare.id, token)))
        .limit(1);
      return row ?? null;
    },

    /** Makes a new share link with a new token. */
    async createShare(input: {
      workflowId: string;
      file: unknown;
      createdBy: string | null;
      label?: string | null;
      passwordHash?: string | null;
      singleUse?: boolean;
    }): Promise<WorkflowShareRow> {
      const [row] = await db
        .insert(workflowShare)
        .values({ id: randomBytes(18).toString("base64url"), organizationId, ...input })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return row;
    },

    /** Changes a share link. A field that is not sent stays as it is. */
    async updateShare(
      token: string,
      patch: {
        label?: string | null;
        file?: unknown;
        passwordHash?: string | null;
        singleUse?: boolean;
      },
    ): Promise<WorkflowShareRow | null> {
      const [row] = await db
        .update(workflowShare)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(workflowShare.organizationId, organizationId), eq(workflowShare.id, token)))
        .returning();
      return row ?? null;
    },

    /** Removes a share link. It stops working. */
    async removeShare(token: string): Promise<boolean> {
      const rows = await db
        .delete(workflowShare)
        .where(and(eq(workflowShare.organizationId, organizationId), eq(workflowShare.id, token)))
        .returning({ id: workflowShare.id });
      return rows.length > 0;
    },

    /** A version row. Checked through its workflow, so it must belong to this organization. */
    async getVersion(versionId: string): Promise<WorkflowVersionRow | null> {
      const [row] = await db
        .select({ version: workflowVersion })
        .from(workflowVersion)
        .innerJoin(workflow, eq(workflowVersion.workflowId, workflow.id))
        .where(and(eq(workflowVersion.id, versionId), eq(workflow.organizationId, organizationId)))
        .limit(1);
      return row?.version ?? null;
    },

    /** Versions of one workflow, newest first. Checked through the workflow row. */
    async listVersions(
      workflowId: string,
      { limit = 50, cursor }: { limit?: number; cursor?: string } = {},
    ): Promise<Page<WorkflowVersionRow>> {
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await db
        .select({ version: workflowVersion })
        .from(workflowVersion)
        .innerJoin(workflow, eq(workflowVersion.workflowId, workflow.id))
        .where(
          and(
            eq(workflow.organizationId, organizationId),
            eq(workflowVersion.workflowId, workflowId),
            after
              ? or(
                  lt(workflowVersion.createdAt, after.createdAt),
                  and(
                    eq(workflowVersion.createdAt, after.createdAt),
                    lt(workflowVersion.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(workflowVersion.createdAt), desc(workflowVersion.id))
        .limit(limit + 1);
      return pageOf(
        rows.map((r) => r.version),
        limit,
      );
    },

    async versionByNumber(workflowId: string, version: number): Promise<WorkflowVersionRow | null> {
      const [row] = await db
        .select({ version: workflowVersion })
        .from(workflowVersion)
        .innerJoin(workflow, eq(workflowVersion.workflowId, workflow.id))
        .where(
          and(
            eq(workflow.organizationId, organizationId),
            eq(workflowVersion.workflowId, workflowId),
            eq(workflowVersion.version, version),
          ),
        )
        .limit(1);
      return row?.version ?? null;
    },

    /**
     * Save the draft as a new immutable version, make it the published one,
     * and sync trigger rows. Webhook tokens stay the same for a node across versions.
     */
    async publish(
      id: string,
      options: {
        graph: unknown;
        triggerNodes: GraphTriggerNode[];
        userId: string | null;
        /** The token of a new webhook trigger. The default is random. */
        newToken?: (nodeId: string) => string;
      },
    ): Promise<WorkflowVersionRow | null> {
      return db.transaction(async (tx) => {
        const [wf] = await tx.select().from(workflow).where(owned(id)).for("update").limit(1);
        if (!wf) return null;
        const [latest] = await tx
          .select({ value: max(workflowVersion.version) })
          .from(workflowVersion)
          .where(eq(workflowVersion.workflowId, id));
        const [version] = await tx
          .insert(workflowVersion)
          .values({
            workflowId: id,
            version: (latest?.value ?? 0) + 1,
            graph: options.graph,
            createdBy: options.userId,
          })
          .returning();
        if (!version) throw new Error("insert returned no row");
        await tx
          .update(workflow)
          .set({ publishedVersionId: version.id, draftGraph: options.graph, updatedAt: new Date() })
          .where(owned(id));

        const existing = await tx.select().from(trigger).where(eq(trigger.workflowId, id));
        const tokenByNode = new Map(
          existing.map((t) => [String((t.config as { nodeId?: string }).nodeId), t]),
        );
        const keep: string[] = [];
        for (const node of options.triggerNodes) {
          const type = triggerKind(node.type, node.poll, node.listen, node.webhook);
          if (!type) continue;
          const previous = tokenByNode.get(node.id);
          const config =
            type === "webhook"
              ? {
                  ...node.config,
                  nodeId: node.id,
                  nodeType: node.type,
                  // Data that the trigger node kept at another service (see `NodeWebhook`).
                  ...(nodeStateOf(previous?.config) !== undefined
                    ? { nodeState: nodeStateOf(previous?.config) }
                    : {}),
                  token:
                    (previous?.config as { token?: string } | undefined)?.token ??
                    options.newToken?.(node.id) ??
                    randomBytes(24).toString("base64url"),
                }
              : type === "poll" || type === "listen"
                ? { ...node.config, nodeId: node.id, nodeType: node.type }
                : { ...node.config, nodeId: node.id };
          if (previous) {
            await tx.update(trigger).set({ type, config }).where(eq(trigger.id, previous.id));
            keep.push(previous.id);
          } else {
            const [row] = await tx
              .insert(trigger)
              .values({ workflowId: id, organizationId, type, config })
              .returning({ id: trigger.id });
            if (row) keep.push(row.id);
          }
        }
        await tx
          .delete(trigger)
          .where(
            and(
              eq(trigger.workflowId, id),
              keep.length > 0 ? notInArray(trigger.id, keep) : undefined,
            ),
          );
        return version;
      });
    },

    async setActive(id: string, active: boolean): Promise<WorkflowRow | null> {
      const [row] = await db
        .update(workflow)
        .set({ active, updatedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /** A cron trigger with the state of its workflow. Used when a scheduler job fires. */
    async cronTrigger(triggerId: string) {
      const [row] = await db
        .select({
          workflowId: trigger.workflowId,
          config: trigger.config,
          active: workflow.active,
          publishedVersionId: workflow.publishedVersionId,
        })
        .from(trigger)
        .innerJoin(workflow, eq(trigger.workflowId, workflow.id))
        .where(
          and(
            eq(trigger.organizationId, organizationId),
            eq(trigger.id, triggerId),
            eq(trigger.type, "cron"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    /** A poll trigger with the state of its workflow. Used when a poll job fires. */
    pollTrigger: (triggerId: string) => triggerOfType(triggerId, "poll"),

    /** A poll or listen trigger with the state of its workflow. */
    pollTriggerOfType: triggerOfType,

    /** What a poll trigger remembers. Null before its first poll. */
    async pollState(triggerId: string) {
      const [row] = await db
        .select({
          cursor: triggerState.cursor,
          seenKeys: triggerState.seenKeys,
          configHash: triggerState.configHash,
        })
        .from(triggerState)
        .innerJoin(trigger, eq(trigger.id, triggerState.triggerId))
        .where(
          and(eq(trigger.organizationId, organizationId), eq(triggerState.triggerId, triggerId)),
        )
        .limit(1);
      return row ? { ...row, seenKeys: (row.seenKeys as string[] | null) ?? [] } : null;
    },

    /** Saves the result of a poll. `error` keeps the old cursor and keys. */
    async savePollState(
      triggerId: string,
      next: { cursor: unknown; seenKeys: string[]; configHash: string } | { error: string },
    ): Promise<void> {
      const now = new Date();
      if ("error" in next) {
        await db
          .insert(triggerState)
          .values({ triggerId, lastPolledAt: now, lastError: next.error })
          .onConflictDoUpdate({
            target: triggerState.triggerId,
            set: { lastPolledAt: now, lastError: next.error, updatedAt: now },
          });
        return;
      }
      const values = {
        cursor: next.cursor ?? null,
        seenKeys: next.seenKeys,
        configHash: next.configHash,
        lastPolledAt: now,
        lastError: null,
        updatedAt: now,
      };
      await db
        .insert(triggerState)
        .values({ triggerId, ...values })
        .onConflictDoUpdate({ target: triggerState.triggerId, set: values });
    },

    /**
     * Forgets the state of the poll triggers of a workflow, except those in `keep`. A workflow
     * that is turned off and on again starts with a first poll.
     */
    async resetPollState(workflowId: string, keep: string[]): Promise<void> {
      const triggers = db
        .select({ id: trigger.id })
        .from(trigger)
        .where(
          and(
            eq(trigger.organizationId, organizationId),
            eq(trigger.workflowId, workflowId),
            keep.length > 0 ? notInArray(trigger.id, keep) : undefined,
          ),
        );
      await db.delete(triggerState).where(inArray(triggerState.triggerId, triggers));
    },

    /** Saves the data that a webhook trigger node keeps at another service. */
    async setTriggerState(workflowId: string, nodeId: string, state: unknown): Promise<void> {
      await db
        .update(trigger)
        .set({
          config: sql`${trigger.config} || ${JSON.stringify({ nodeState: state ?? null })}::jsonb`,
        })
        .where(
          and(
            eq(trigger.organizationId, organizationId),
            eq(trigger.workflowId, workflowId),
            sql`${trigger.config}->>'nodeId' = ${nodeId}`,
          ),
        );
    },

    async triggers(workflowIds: string[]): Promise<TriggerRow[]> {
      if (workflowIds.length === 0) return [];
      return db
        .select()
        .from(trigger)
        .where(
          and(eq(trigger.organizationId, organizationId), inArray(trigger.workflowId, workflowIds)),
        );
    },
  };
}

/**
 * The webhook token of a trigger node that has none yet. The editor shows the test URL before a
 * publish, and a publish uses the same token, so the test URL and the production URL differ only
 * in the path prefix.
 */
export function webhookToken(secretKey: Buffer, workflowId: string, nodeId: string): string {
  return createHmac("sha256", secretKey)
    .update(`webhook:${workflowId}:${nodeId}`)
    .digest()
    .subarray(0, 24)
    .toString("base64url");
}
