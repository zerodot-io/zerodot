// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from "node:crypto";
import { blobSetup } from "@zerodot/blob";
import {
  type BlobSetup,
  type Db,
  forOrganization,
  type NodeResultInput,
  type RunRow,
} from "@zerodot/db";
import {
  type ExecuteTarget,
  type ExecutionHooks,
  executeGraph,
  type Graph,
  graphSchema,
  resumeUrl,
  rootNodes,
  type SandboxClient,
  type StoredNodeResult,
  type SubWorkflowRunner,
} from "@zerodot/engine";
import { openCredential, registry } from "@zerodot/nodes";
import { publishRunEvent, runResponseKey } from "@zerodot/queue";
import type { Redis } from "ioredis";
import { log } from "./log";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most sub-workflows that one run may nest. It stops a workflow that calls itself. */
export const MAX_SUB_WORKFLOW_DEPTH = 10;

export type ProcessDeps = {
  db: Db;
  redis: Redis;
  runTimeoutMs: number;
  maxOutputBytes: number;
  /** The most node runs in one run. Default 1000. */
  maxNodeRuns?: number;
  envAllowlist: string[];
  /** Opens credentials. Comes from ZERODOT_SECRET_KEY. */
  secretKey: Buffer;
  /** Most rows one data table can hold. */
  tableMaxRows?: number;
  /** Runs code for code nodes. Not set when the worker has no sandbox. */
  sandbox?: SandboxClient;
  /** Public address of the web app. Without it, a node cannot ask a person to answer. */
  baseUrl?: string;
  /**
   * Where large and binary node data goes. Not set: read it from the environment
   * (`ZERODOT_BLOB_DIR` or `ZERODOT_BLOB_S3_*`). Null: no blob store, all data stays in Postgres.
   */
  blobs?: BlobSetup | null;
  /**
   * False: a production run does not keep the input and output of nodes that succeeded. It keeps
   * status and timing. Not set: read `ZERODOT_SAVE_SUCCESS_NODE_DATA` (default true). A workflow can
   * also turn this off for itself.
   */
  saveSuccessNodeData?: boolean;
  /** Queue a new run. Used to start the error workflow. Without it, no error workflow starts. */
  enqueueRun?: (input: { runId: string; organizationId: string }) => Promise<void>;
  /** Queue the run again after a delay. The run waits in the queue, not in this worker. */
  scheduleResume: (input: {
    runId: string;
    organizationId: string;
    delayMs: number;
  }) => Promise<void>;
};

function allowedEnv(names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

type Scope = ReturnType<typeof forOrganization>;

/**
 * A live run failed. Queue a run of the error workflow of its workflow.
 * The run id is the idempotency key, so a retried job does not start a second run.
 * The error workflow runs in its published version. A run of an error workflow does not start one.
 */
async function startErrorWorkflow(
  deps: ProcessDeps,
  scope: Scope,
  failed: RunRow,
  error: unknown,
): Promise<void> {
  if (!deps.enqueueRun || failed.triggerType === "error") return;
  const source = await scope.workflows.get(failed.workflowId);
  const targetId = source?.errorWorkflowId;
  if (!targetId || targetId === failed.workflowId) return;
  const target = await scope.workflows.get(targetId);
  if (!target?.publishedVersionId) {
    log("warn", "error_workflow.skipped", { run: { id: failed.id }, reason: "not published" });
    return;
  }
  const version = await scope.workflows.getVersion(target.publishedVersionId);
  const graph = graphSchema.safeParse(version?.graph);
  const start = graph.success
    ? graph.data.nodes.find((n) => n.type === "trigger.error" && !n.disabled)
    : undefined;
  if (!start) {
    log("warn", "error_workflow.skipped", { run: { id: failed.id }, reason: "no error trigger" });
    return;
  }
  const failedNode = (await scope.runs.results(failed.id)).find((r) => r.status === "failed");
  const { run: created, created: isNew } = await scope.runs.create({
    workflowId: target.id,
    mode: "production",
    versionId: target.publishedVersionId,
    triggerType: "error",
    triggerNodeId: start.id,
    triggerInput: {
      workflowId: failed.workflowId,
      workflowName: source.name,
      runId: failed.id,
      error,
      failedNodeId: failedNode?.nodeId ?? null,
    },
    idempotencyKey: `error:${failed.id}`,
  });
  if (isNew) await deps.enqueueRun({ runId: created.id, organizationId: failed.organizationId });
}

/** Longest wait before an automatic retry: 1 hour. */
export const MAX_AUTO_RETRY_BACKOFF_MS = 3_600_000;

/**
 * A live run failed. When the workflow has auto retry and the chain is not used up, queue a retry
 * from the failed node after the backoff and return true. The error workflow then waits for the
 * last attempt. Returns false when no retry was queued.
 * The retry has the key `autoretry:<failed run id>`, so a repeated job does not queue a second one.
 */
async function startAutoRetry(deps: ProcessDeps, scope: Scope, failed: RunRow): Promise<boolean> {
  if (failed.triggerType === "error" || (!failed.versionId && !failed.graphSnapshot)) return false;
  const source = await scope.workflows.get(failed.workflowId);
  const max = source?.autoRetryMax ?? 0;
  if (!source || failed.autoRetryAttempt >= max) return false;
  const created = await scope.runs.createRetry(failed.id, {
    autoRetryAttempt: failed.autoRetryAttempt + 1,
    idempotencyKey: `autoretry:${failed.id}`,
  });
  if (!created) return false;
  await deps.scheduleResume({
    runId: created.id,
    organizationId: failed.organizationId,
    delayMs: Math.min(source.autoRetryBackoffMs, MAX_AUTO_RETRY_BACKOFF_MS),
  });
  log("info", "run.auto_retry", {
    run: { id: failed.id },
    retry: { id: created.id, attempt: created.autoRetryAttempt, max },
  });
  return true;
}

/**
 * The output that a succeeded node row holds when the run does not keep node data. The engine
 * cannot replay it, so a resumed run runs that node again (see `previousResults`).
 */
export const OMITTED_OUTPUT = { $omitted: true };

const isOmitted = (output: unknown): boolean =>
  typeof output === "object" &&
  output !== null &&
  (output as { $omitted?: unknown }).$omitted === true;

/** Run one workflow run. Safe to call again for the same run: it resumes. */
export async function processRun(
  deps: ProcessDeps,
  job: { runId: string; organizationId: string },
  jobSignal?: AbortSignal,
  /** An admin cancelled the run. This ends the run as cancelled. It is not a shutdown. */
  cancelSignal?: AbortSignal,
): Promise<void> {
  const { db, redis } = deps;
  const blobs = deps.blobs === undefined ? blobSetup() : deps.blobs;
  const scope = forOrganization(db, job.organizationId, {
    blobs,
    secretKey: deps.secretKey,
    tableMaxRows: deps.tableMaxRows,
  });
  const publish = (event: Parameters<typeof publishRunEvent>[2]) =>
    publishRunEvent(redis, job.organizationId, event).catch((error) =>
      log("warn", "event.publish_failed", { run: { id: job.runId }, error: String(error) }),
    );

  // A failed rollup write is logged. It never fails the run.
  const rollup = async (kind: "run" | "node", write: () => Promise<void>) =>
    write().catch((error) =>
      log("error", "stats.rollup_failed", { run: { id: job.runId }, kind, error: String(error) }),
    );
  // Runs the rollup after the final status is known, so a timeout counts as failed.
  const rollupRun = (row: RunRow | null) => {
    if (!row?.finishedAt) return Promise.resolve();
    const { finishedAt } = row;
    const status = row.status;
    if (status !== "succeeded" && status !== "failed" && status !== "cancelled") {
      return Promise.resolve();
    }
    return rollup("run", () =>
      scope.stats.recordRunEnd({
        runId: row.id,
        workflowId: row.workflowId,
        mode: row.mode,
        triggerType: row.triggerType,
        status,
        startedAt: row.startedAt,
        finishedAt,
        error: row.error,
      }),
    );
  };

  const fail = async (message: string) => {
    await rollupRun(await scope.runs.finish(job.runId, { status: "failed", error: { message } }));
    await publish({ type: "run.finished", runId: job.runId, status: "failed", error: { message } });
  };

  const run = await scope.runs.get(job.runId);
  if (!run) {
    log("error", "run.not_found", {
      run: { id: job.runId },
      organization: { id: job.organizationId },
    });
    return;
  }
  if (run.status === "succeeded" || run.status === "failed" || run.status === "cancelled") return;

  let graph: Graph;
  try {
    const raw = run.versionId
      ? (await scope.workflows.getVersion(run.versionId))?.graph
      : run.graphSnapshot;
    if (!raw) throw new Error("The run has no graph");
    graph = graphSchema.parse(raw);
  } catch (error) {
    await scope.runs.start(job.runId);
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }

  /** How deep this run is nested. A child run has the idempotency key `sub:<parent run id>:...`. */
  const depthOf = async (row: RunRow): Promise<number> => {
    let depth = 0;
    let current: RunRow | null = row;
    while (current?.idempotencyKey?.startsWith("sub:") && depth <= MAX_SUB_WORKFLOW_DEPTH) {
      const parentId: string | undefined = current.idempotencyKey.split(":")[1];
      current = parentId ? await scope.runs.get(parentId) : null;
      depth++;
    }
    return depth;
  };

  /** Runs a workflow as a child run. Waits for it and returns its last node output, or not. */
  const runWorkflow: SubWorkflowRunner = async (source, input, options) => {
    if ((await depthOf(run)) + 1 > MAX_SUB_WORKFLOW_DEPTH) {
      throw new Error(`Sub-workflows are nested more than ${MAX_SUB_WORKFLOW_DEPTH} levels deep`);
    }
    let workflowId = run.workflowId;
    let name = "The workflow in the node";
    let versionId: string | undefined;
    let rawGraph: unknown;
    if (source.kind === "parameter") {
      rawGraph = source.graph;
    } else {
      const child = await scope.workflows.get(source.workflowId);
      if (!child) throw new Error(`Workflow "${source.workflowId}" does not exist`);
      workflowId = child.id;
      name = `Workflow "${child.name}"`;
      // A test run uses the draft, so a person can try a change. A live run needs a published one.
      if (run.mode === "production") {
        if (!child.publishedVersionId) throw new Error(`${name} is not published`);
        versionId = child.publishedVersionId;
        rawGraph = (await scope.workflows.getVersion(versionId))?.graph;
      } else {
        rawGraph = child.draftGraph;
      }
    }
    const parsed = graphSchema.safeParse(rawGraph);
    if (!parsed.success) throw new Error(`${name} has no valid graph`);
    const start =
      parsed.data.nodes.find((n) => n.type === "trigger.manual" && !n.disabled) ??
      parsed.data.nodes.find((n) => n.type.startsWith("trigger.") && !n.disabled) ??
      rootNodes(parsed.data)[0];
    if (!start) throw new Error(`${name} has no node to start at`);
    if (!options.wait && !deps.enqueueRun) {
      throw new Error("This worker cannot start a run without waiting");
    }
    const { run: created } = await scope.runs.create({
      workflowId,
      mode: run.mode,
      versionId,
      graphSnapshot: versionId ? undefined : parsed.data,
      triggerType: "subworkflow",
      triggerNodeId: start.id,
      triggerInput: input,
      idempotencyKey: `sub:${job.runId}:${randomUUID()}`,
    });
    if (!options.wait) {
      await deps.enqueueRun?.({ runId: created.id, organizationId: job.organizationId });
      return { runId: created.id };
    }
    await processRun(
      deps,
      { runId: created.id, organizationId: job.organizationId },
      signal,
      cancelSignal,
    );
    const done = await scope.runs.get(created.id);
    if (done?.status === "waiting") {
      throw new Error(`${name} waits for an answer. A sub-workflow cannot wait`);
    }
    if (done?.status !== "succeeded") {
      const message = (done?.error as { message?: string } | null)?.message;
      throw new Error(`${name} ${done?.status ?? "failed"}: ${message ?? "no error"}`);
    }
    const last = (await scope.runs.results(created.id))
      .filter((r) => r.status === "succeeded" && r.finishedAt)
      .sort((a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0))
      .at(-1);
    return last?.output ?? null;
  };

  const target = run.mode === "test" ? (run.testTarget as ExecuteTarget | null) : null;

  // Large values stay blob references here. The engine reads them when a node needs them.
  const previousResults: StoredNodeResult[] = (await scope.runs.results(job.runId, { lazy: true }))
    // A succeeded node with no saved output (the run keeps no node data) runs again.
    .filter((r) => !(r.status === "succeeded" && isOmitted(r.output)))
    .map((r) => ({
      nodeId: r.nodeId,
      attempt: r.attempt,
      status: r.status,
      port: r.port,
      output: r.output,
    }));

  // Variables are read once for each pass. A change during a pass does not change that pass.
  const variables = await scope.variables.asRecord();

  // A workflow can set its own time limit. It replaces the worker default.
  const settings = await scope.workflows.get(run.workflowId);
  const runTimeoutMs = settings?.timeoutSeconds
    ? settings.timeoutSeconds * 1000
    : deps.runTimeoutMs;
  const timeout = AbortSignal.timeout(runTimeoutMs);
  const signal = AbortSignal.any(
    [timeout, jobSignal, cancelSignal].filter((s): s is AbortSignal => s !== undefined),
  );
  const startedAtById = new Map<string, Date>();

  const saveSuccessNodeData =
    deps.saveSuccessNodeData ?? process.env.ZERODOT_SAVE_SUCCESS_NODE_DATA !== "false";
  // Production runs can skip the input and output of succeeded nodes (fewer and smaller writes).
  const skipSuccessData =
    run.mode === "production" &&
    (saveSuccessNodeData === false || settings?.saveSuccessData === false);
  // The full results of those nodes. They are written when the run waits or does not succeed,
  // because a resume or a retry needs them. In a run that succeeds, only the last one is written,
  // because it is the answer of the run (`wait=true`, response mode `lastNode`, sub-workflows).
  const held = new Map<string, NodeResultInput>();
  const flush = async (entries: NodeResultInput[]) => {
    for (const entry of entries) await scope.runs.saveNodeResult(job.runId, entry);
  };

  const persistence: ExecutionHooks = {
    async onRunStart() {
      const started = await scope.runs.start(job.runId);
      log("info", "run.started", {
        run: { id: job.runId, status: started?.status },
        organization: { id: job.organizationId },
      });
      await publish({ type: "run.started", runId: job.runId });
    },
    async beforeNode({ node, attempt }) {
      const startedAt = new Date();
      startedAtById.set(`${node.id}:${attempt}`, startedAt);
      // No "running" row. The live event is enough: a node that did not finish has no result,
      // so a resumed run starts it again. Rows are written when a node ends.
      void publish({ type: "node.started", runId: job.runId, nodeId: node.id, attempt });
    },
    async afterNode(e) {
      const result: NodeResultInput = {
        nodeId: e.node.id,
        attempt: e.attempt,
        status: e.status,
        port: e.port,
        input: e.input,
        output: e.output,
        error: e.error,
        logs: e.logs,
        startedAt: startedAtById.get(`${e.node.id}:${e.attempt}`) ?? null,
        finishedAt: new Date(),
      };
      if (skipSuccessData && e.status === "succeeded") {
        held.set(`${e.node.id}:${e.attempt}`, result);
        await scope.runs.saveNodeResult(job.runId, {
          ...result,
          input: null,
          output: OMITTED_OUTPUT,
        });
      } else {
        await scope.runs.saveNodeResult(job.runId, result);
      }
      if (e.status === "succeeded" && e.respond) {
        await redis.set(runResponseKey(job.runId), JSON.stringify(e.respond), "EX", 600);
      }
      // Events go out in order on one connection, so they need not be awaited. The event at the
      // end of the run is awaited, and it comes after all of them.
      if (e.status === "succeeded") {
        void publish({
          type: "node.succeeded",
          runId: job.runId,
          nodeId: e.node.id,
          attempt: e.attempt,
          port: e.port,
          output: e.output,
          pinned: e.pinned,
        });
      } else if (e.status === "failed" && e.error) {
        void publish({
          type: "node.failed",
          runId: job.runId,
          nodeId: e.node.id,
          attempt: e.attempt,
          error: e.error,
        });
      } else if (e.status === "waiting") {
        const stored = e.output as { resumeAt: number };
        void publish({
          type: "node.waiting",
          runId: job.runId,
          nodeId: e.node.id,
          attempt: e.attempt,
          resumeAt: stored.resumeAt,
        });
      } else if (e.status === "skipped") {
        void publish({ type: "node.skipped", runId: job.runId, nodeId: e.node.id });
      }
    },
  };

  persistence.onRunWait = async () => {
    await flush([...held.values()]);
    held.clear();
  };
  persistence.onRunEnd = async ({ status }) => {
    const entries = [...held.values()];
    held.clear();
    if (status === "succeeded") {
      // A workflow that keeps no success data clears the rows when the run ends.
      if (settings?.saveSuccessData === false) return;
      const last = entries.sort(
        (a, b) => (a.finishedAt?.getTime() ?? 0) - (b.finishedAt?.getTime() ?? 0),
      );
      await flush(last.slice(-1));
    } else if (settings?.saveFailureData !== false) {
      await flush(entries);
    }
  };

  // Node rollups are collected and written once when the run stops or waits (one write for
  // all nodes, not one for each node). A crash loses the rollups of that pass only.
  const pendingNodeStats: Parameters<typeof scope.stats.recordNodeEnds>[0] = [];
  const flushNodeStats = async () => {
    const batch = pendingNodeStats.splice(0);
    if (batch.length === 0) return;
    await rollup("node", () => scope.stats.recordNodeEnds(batch));
  };
  const rollups: ExecutionHooks = {
    async afterNode(e) {
      if (e.status !== "succeeded" && e.status !== "failed") return;
      pendingNodeStats.push({
        workflowId: run.workflowId,
        nodeType: e.node.type,
        nodeId: e.node.id,
        mode: run.mode,
        status: e.status,
        durationMs: e.durationMs,
        finishedAt: new Date(),
      });
    },
    onRunWait: flushNodeStats,
    onRunEnd: flushNodeStats,
  };

  try {
    const result = await executeGraph({
      graph,
      registry,
      triggerInput: run.triggerInput,
      mode: run.mode,
      signal,
      previousResults,
      startNodeId: run.triggerNodeId ?? undefined,
      target: target ?? undefined,
      hooks: [persistence, rollups],
      env: allowedEnv(deps.envAllowlist),
      variables,
      sandbox: deps.sandbox,
      tables: scope.tables.store(run.id),
      credentials: async (reference, by) => {
        let id: string | null = reference;
        if (by === "idOrName" && !UUID.test(reference))
          id = await scope.credentials.idByName(reference);
        if (!id) return null;
        const opened = await openCredential(scope.credentials, id);
        return opened ? { type: opened.type, data: opened.data } : null;
      },
      run: { id: run.id, startedAt: (run.startedAt ?? new Date()).toISOString() },
      runWorkflow,
      blobs: blobs?.store,
      maxOutputBytes: deps.maxOutputBytes,
      maxNodeRuns: deps.maxNodeRuns,
      resumeUrl: deps.baseUrl
        ? (nodeId) => resumeUrl(deps.baseUrl ?? "", deps.secretKey, job.runId, nodeId)
        : undefined,
    });
    if (result.status === "waiting") {
      // Queue the resume first. If this fails, BullMQ retries the job and the run starts again.
      await deps.scheduleResume({
        runId: job.runId,
        organizationId: job.organizationId,
        delayMs: result.resumeAt - Date.now(),
      });
      await scope.runs.setWaiting(job.runId);
      await publish({ type: "run.waiting", runId: job.runId, resumeAt: result.resumeAt });
      log("info", "run.waiting", { run: { id: job.runId }, resumeAt: result.resumeAt });
      return;
    }
    let { status, error } = result;
    const cancelled = status === "cancelled" && cancelSignal?.aborted === true;
    if (cancelled) {
      // A cancel wins over a shutdown or a timeout. A run that ended already stays as it is.
      const current = await scope.runs.get(job.runId);
      if (
        current &&
        (current.status === "succeeded" ||
          current.status === "failed" ||
          current.status === "cancelled")
      ) {
        return;
      }
    } else if (status === "cancelled" && timeout.aborted && !jobSignal?.aborted) {
      status = "failed";
      error = { message: `Run timed out after ${runTimeoutMs} ms` };
    }
    if (status === "cancelled" && !cancelled && jobSignal?.aborted) {
      // Worker is shutting down. Leave the run as running so another worker resumes it.
      log("warn", "run.interrupted", { run: { id: job.runId } });
      return;
    }
    await rollupRun(await scope.runs.finish(job.runId, { status, error }));
    await publish({ type: "run.finished", runId: job.runId, status, error });
    if (status === "failed" && run.mode === "production") {
      // The error workflow starts only when no retry is queued, so it sees the last failure.
      const retried = await startAutoRetry(deps, scope, run).catch((e) => {
        log("error", "run.auto_retry_failed", { run: { id: job.runId }, error: String(e) });
        return false;
      });
      if (!retried) {
        await startErrorWorkflow(deps, scope, run, error).catch((e) =>
          log("error", "error_workflow.failed", { run: { id: job.runId }, error: String(e) }),
        );
      }
    }
    // Test runs keep their data, so the editor can show it.
    const discard =
      run.mode === "production" &&
      ((status === "succeeded" && settings?.saveSuccessData === false) ||
        (status === "failed" && settings?.saveFailureData === false));
    if (discard) {
      await scope.runs
        .clearData(job.runId)
        .catch((e) =>
          log("error", "run.clear_failed", { run: { id: job.runId }, error: String(e) }),
        );
    }
    log("info", "run.finished", { run: { id: job.runId, status } });
  } catch (error) {
    log("error", "run.crashed", { run: { id: job.runId }, error: String(error) });
    // Keep the rollups of the nodes that did finish.
    await flushNodeStats();
    throw error;
  }
}
