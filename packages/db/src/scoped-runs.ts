// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from "node:crypto";
import { containsBlobRef, hydrate, storeValue } from "@zerodot/engine";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { type BlobSetup, getBlobSetup } from "./blob-setup";
import type { Db } from "./client";
import { decodeCursor, type Page, pageOf } from "./cursor";
import { copyBlobsToRun, deleteBlobsForRuns } from "./run-blobs";
import { run, runNodeResult, workflow } from "./schema";

export type RunRow = typeof run.$inferSelect;
export type RunNodeResultRow = typeof runNodeResult.$inferSelect;
export type RunListItem = RunRow & { workflowName: string };

export type NewRun = {
  workflowId: string;
  mode: "production" | "test";
  versionId?: string;
  graphSnapshot?: unknown;
  triggerType: string;
  triggerNodeId?: string;
  triggerInput: unknown;
  testTarget?: unknown;
  idempotencyKey?: string;
};

export type NodeResultInput = {
  nodeId: string;
  attempt: number;
  status: RunNodeResultRow["status"];
  port?: string | null;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  /** The `console` calls of the node. Nothing is stored when empty. */
  logs?: unknown[] | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
};

/**
 * `blobs` is the blob setup, or a function that gives it. Without it the process setting is used
 * (`setBlobSetup`). With no setup at all, all node data stays in the rows.
 */
export function runs(
  db: Db,
  organizationId: string,
  blobs: BlobSetup | null | (() => BlobSetup | null) = getBlobSetup,
) {
  const blobSetup = (): BlobSetup | null => (typeof blobs === "function" ? blobs() : blobs);

  const owned = (id: string) => and(eq(run.organizationId, organizationId), eq(run.id, id));

  return {
    /** A repeated idempotency key returns the first run with `created: false`. */
    async create(input: NewRun): Promise<{ run: RunRow; created: boolean }> {
      const [row] = await db
        .insert(run)
        .values({
          organizationId,
          workflowId: input.workflowId,
          mode: input.mode,
          versionId: input.versionId,
          graphSnapshot: input.graphSnapshot,
          triggerType: input.triggerType,
          triggerNodeId: input.triggerNodeId,
          triggerInput: input.triggerInput,
          testTarget: input.testTarget,
          idempotencyKey: input.idempotencyKey,
        })
        .onConflictDoNothing({ target: [run.workflowId, run.idempotencyKey] })
        .returning();
      if (row) return { run: row, created: true };
      const [existing] = await db
        .select()
        .from(run)
        .where(
          and(
            eq(run.organizationId, organizationId),
            eq(run.workflowId, input.workflowId),
            eq(run.idempotencyKey, input.idempotencyKey ?? ""),
          ),
        )
        .limit(1);
      if (!existing) throw new Error("run insert conflict without an existing run");
      return { run: existing, created: false };
    },

    /**
     * A new queued run that goes on from the failed node of a run. It uses the same version (or
     * graph snapshot), trigger, and input. It copies the succeeded results of the old run, so the
     * worker skips those nodes. Failed and skipped results are not copied. Returns null when the
     * old run does not exist in this project.
     */
    async createRetry(
      sourceId: string,
      options: { autoRetryAttempt?: number; idempotencyKey?: string } = {},
    ): Promise<RunRow | null> {
      const retry = await db.transaction(async (tx) => {
        const [source] = await tx.select().from(run).where(owned(sourceId)).limit(1);
        if (!source) return null;
        const [created] = await tx
          .insert(run)
          .values({
            organizationId,
            workflowId: source.workflowId,
            mode: source.mode,
            versionId: source.versionId,
            graphSnapshot: source.graphSnapshot,
            triggerType: source.triggerType,
            triggerNodeId: source.triggerNodeId,
            triggerInput: source.triggerInput,
            testTarget: source.testTarget,
            idempotencyKey: options.idempotencyKey ?? `retry:${source.id}:${randomUUID()}`,
            autoRetryAttempt: options.autoRetryAttempt ?? 0,
          })
          .returning();
        if (!created) throw new Error("insert returned no row");
        await tx.execute(sql`
          insert into run_node_result
            (run_id, node_id, attempt, status, port, input, output, input_ref, output_ref, error, logs, started_at, finished_at)
          select ${created.id}, node_id, attempt, status, port, input, output, input_ref, output_ref, error, logs, started_at, finished_at
          from run_node_result
          where run_id = ${source.id} and status = 'succeeded'
        `);
        return created;
      });
      // The copied results point to blobs of the old run. Give the new run its own blobs.
      const setup = blobSetup();
      if (retry && setup) await copyBlobsToRun(db, setup.store, sourceId, retry.id);
      return retry;
    },

    async get(id: string): Promise<RunRow | null> {
      const [row] = await db.select().from(run).where(owned(id)).limit(1);
      return row ?? null;
    },

    async list({
      workflowId,
      status,
      triggerType,
      mode,
      limit = 50,
      cursor,
    }: {
      workflowId?: string;
      status?: RunRow["status"];
      triggerType?: string;
      mode?: RunRow["mode"];
      limit?: number;
      cursor?: string;
    } = {}): Promise<Page<RunListItem>> {
      const after = cursor ? decodeCursor(cursor) : null;
      const rows = await db
        .select({ run, workflowName: workflow.name })
        .from(run)
        .innerJoin(workflow, eq(run.workflowId, workflow.id))
        .where(
          and(
            eq(run.organizationId, organizationId),
            workflowId ? eq(run.workflowId, workflowId) : undefined,
            status ? eq(run.status, status) : undefined,
            triggerType ? eq(run.triggerType, triggerType) : undefined,
            mode ? eq(run.mode, mode) : undefined,
            after
              ? or(
                  lt(run.createdAt, after.createdAt),
                  and(eq(run.createdAt, after.createdAt), lt(run.id, after.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(run.createdAt), desc(run.id))
        .limit(limit + 1);
      return pageOf(
        rows.map((r) => ({ ...r.run, workflowName: r.workflowName })),
        limit,
      );
    },

    /**
     * The node results of a run. Blobs are read back, so `input` and `output` hold the full data
     * (files as base64). With `lazy`, a large value stays a blob reference in `input` or
     * `output`, and files inside stay references. The engine reads them when a node needs them.
     */
    async results(runId: string, options: { lazy?: boolean } = {}): Promise<RunNodeResultRow[]> {
      const rows = await db
        .select({ result: runNodeResult })
        .from(runNodeResult)
        .innerJoin(run, eq(runNodeResult.runId, run.id))
        .where(and(eq(run.organizationId, organizationId), eq(run.id, runId)));
      const setup = blobSetup();
      const results = rows.map((r) => r.result);
      if (!setup) return results;
      const read = async (inline: unknown, ref: unknown) => {
        const value = ref ?? inline;
        if (options.lazy || !containsBlobRef(value)) return value;
        return hydrate(value, setup.store);
      };
      return Promise.all(
        results.map(async (r) => ({
          ...r,
          input: await read(r.input, r.inputRef),
          output: await read(r.output, r.outputRef),
        })),
      );
    },

    /** Move a queued run to running. A resumed run keeps its first start time. */
    async start(id: string): Promise<RunRow | null> {
      const [row] = await db
        .update(run)
        .set({ status: "running", startedAt: sql`coalesce(${run.startedAt}, now())` })
        .where(
          and(
            owned(id),
            or(eq(run.status, "queued"), eq(run.status, "running"), eq(run.status, "waiting")),
          ),
        )
        .returning();
      return row ?? null;
    },

    /**
     * A person answers a node that waits. The wait ends now, and `data` is the node output.
     * Returns false when the node does not wait, or when someone answered before.
     */
    async answerWait(runId: string, nodeId: string, data: unknown): Promise<boolean> {
      const [owner] = await db
        .select({ id: run.id })
        .from(run)
        .where(and(owned(runId), eq(run.status, "waiting")))
        .limit(1);
      if (!owner) return false;
      const rows = await db
        .update(runNodeResult)
        .set({ output: { resumeAt: Date.now(), data } })
        .where(
          and(
            eq(runNodeResult.runId, runId),
            eq(runNodeResult.nodeId, nodeId),
            eq(runNodeResult.status, "waiting"),
            sql`(${runNodeResult.output}->>'resumeAt')::bigint > ${Date.now()}`,
          ),
        )
        .returning({ nodeId: runNodeResult.nodeId });
      return rows.length > 0;
    },

    /** The node result that waits for an answer, with its input. Used to show a form. */
    async waitingNode(runId: string, nodeId: string) {
      const [row] = await db
        .select({
          output: runNodeResult.output,
          workflowId: run.workflowId,
          versionId: run.versionId,
        })
        .from(runNodeResult)
        .innerJoin(run, eq(runNodeResult.runId, run.id))
        .where(
          and(owned(runId), eq(runNodeResult.nodeId, nodeId), eq(runNodeResult.status, "waiting")),
        )
        .limit(1);
      return row ?? null;
    },

    /** The run stopped for a wait. It has no finish time. A resume job starts it again. */
    async setWaiting(id: string): Promise<RunRow | null> {
      const [row] = await db
        .update(run)
        .set({ status: "waiting" })
        .where(and(owned(id), or(eq(run.status, "running"), eq(run.status, "waiting"))))
        .returning();
      return row ?? null;
    },

    async finish(
      id: string,
      outcome: { status: "succeeded" | "failed" | "cancelled"; error?: unknown },
    ): Promise<RunRow | null> {
      const [row] = await db
        .update(run)
        .set({ status: outcome.status, error: outcome.error ?? null, finishedAt: new Date() })
        .where(owned(id))
        .returning();
      return row ?? null;
    },

    /** Delete the node data of a finished run. The run row stays, so lists and stats still count it. */
    async clearData(id: string): Promise<void> {
      await db.execute(sql`
        DELETE FROM run_node_result
        WHERE run_id = ${id}
          AND EXISTS (SELECT 1 FROM run WHERE id = ${id} AND organization_id = ${organizationId})
      `);
      const [owner] = await db.select({ id: run.id }).from(run).where(owned(id)).limit(1);
      if (owner) await deleteBlobsForRuns([id], blobSetup()?.store);
      await db.update(run).set({ triggerInput: null }).where(owned(id));
    },

    /** Upsert. The insert only happens when the run belongs to this organization. */
    async saveNodeResult(runId: string, r: NodeResultInput): Promise<void> {
      // With a blob store, files and large values go there. The row keeps small references.
      const setup = blobSetup();
      const store = (value: unknown, keepInline = false) =>
        setup
          ? storeValue(value ?? null, setup.store, {
              runId,
              inlineBytes: setup.inlineBytes,
              keepInline,
            })
          : { inline: value ?? null, ref: null };
      const input = await store(r.input);
      // A waiting result has its resume time in the row (`answerWait` reads it), so it stays inline.
      const output = await store(r.output, r.status === "waiting");
      await db.execute(sql`
        insert into run_node_result
          (run_id, node_id, attempt, status, port, input, output, input_ref, output_ref, error, logs, started_at, finished_at)
        select ${run.id}, ${r.nodeId}::text, ${r.attempt}::int, ${r.status}::text, ${r.port ?? null}::text,
          ${JSON.stringify(input.inline)}::jsonb, ${JSON.stringify(output.inline)}::jsonb,
          ${input.ref ? JSON.stringify(input.ref) : null}::jsonb,
          ${output.ref ? JSON.stringify(output.ref) : null}::jsonb,
          ${JSON.stringify(r.error ?? null)}::jsonb,
          ${r.logs && r.logs.length > 0 ? JSON.stringify(r.logs) : null}::jsonb,
          ${r.startedAt?.toISOString() ?? null}::timestamptz,
          ${r.finishedAt?.toISOString() ?? null}::timestamptz
        from ${run}
        where ${run.id} = ${runId} and ${run.organizationId} = ${organizationId}
        on conflict (run_id, node_id, attempt) do update set
          status = excluded.status, port = excluded.port, input = excluded.input,
          output = excluded.output, input_ref = excluded.input_ref,
          output_ref = excluded.output_ref, error = excluded.error, logs = excluded.logs,
          started_at = coalesce(run_node_result.started_at, excluded.started_at),
          finished_at = excluded.finished_at
      `);
    },
  };
}
