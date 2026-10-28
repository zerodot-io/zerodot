// SPDX-License-Identifier: AGPL-3.0-only
import { findWebhookTrigger, type RunRow, webhookToken } from "@zerodot/db";
import {
  buildExport,
  type ExecuteTarget,
  type Graph,
  GraphError,
  graphSchema,
  isTriggerType,
  parseImport,
  rootNodes,
  validateGraph,
} from "@zerodot/engine";
import { openCredential, registry, validateCron, validateGraphNodes } from "@zerodot/nodes";
import { ZodError } from "zod";
import type { ApiContext } from "./context.server";
import { ApiError, badRequest, conflict, notFound } from "./errors";

/**
 * The operations behind the REST routes, the MCP tools, and the editor server functions.
 * They throw `ApiError`. A caller maps it to a response.
 */

const TERMINAL = new Set<RunRow["status"]>(["succeeded", "failed", "cancelled"]);
const POLL_MS = 250;

/** Structure checks. With `nodes: true` it also checks node types, configs, and edge ports. */
export function checkedGraph(graph: Graph, options: { nodes: boolean }): Graph {
  try {
    validateGraph(graph);
  } catch (error) {
    if (error instanceof GraphError) throw badRequest(error.message);
    throw error;
  }
  if (options.nodes) {
    const problems = validateGraphNodes(graph);
    if (problems.length > 0) {
      throw badRequest(`The graph is not valid: ${problems[0]}`, { problems });
    }
  }
  return graph;
}

/**
 * Each credential in the graph must exist in this project and fit the node. A node with a
 * `credentialExpression` is not checked: the credential is only known at run time.
 */
async function checkCredentials(ctx: ApiContext, graph: Graph) {
  const used = graph.nodes.filter((n) => n.credentialId && !n.credentialExpression);
  if (used.length === 0) return;
  const known = new Map((await ctx.scope.credentials.list()).map((c) => [c.id, c]));
  for (const node of used) {
    const found = node.credentialId ? known.get(node.credentialId) : undefined;
    if (!found) throw badRequest(`"${node.name}": the credential does not exist`);
    if (!registry.get(node.type)?.credentialTypes?.includes(found.type)) {
      throw badRequest(
        `"${node.name}": this node does not accept a credential of type ${found.type}`,
      );
    }
  }
}

export async function requireWorkflow(ctx: ApiContext, id: string) {
  const wf = await ctx.scope.workflows.get(id);
  if (!wf) throw notFound("Workflow");
  return wf;
}

export async function saveDraft(
  ctx: ApiContext,
  workflowId: string,
  graph: Graph,
  options: { nodes: boolean },
) {
  const row = await ctx.scope.workflows.saveDraft(workflowId, checkedGraph(graph, options));
  if (!row) throw notFound("Workflow");
  await ctx.services.draftChanged(ctx.principal.organizationId, workflowId);
  return row;
}

/** Publish `graph`, or the saved draft when `graph` is missing. */
export async function publishWorkflow(
  ctx: ApiContext,
  workflowId: string,
  input: { graph?: Graph; nodes: boolean },
) {
  const wf = await requireWorkflow(ctx, workflowId);
  const graph = checkedGraph(input.graph ?? graphSchema.parse(wf.draftGraph), {
    nodes: input.nodes,
  });
  await checkCredentials(ctx, graph);
  const triggerNodes = graph.nodes
    .filter((n) => isTriggerType(n.type))
    .map((n) => ({
      ...n,
      poll: Boolean(registry.get(n.type)?.poll),
      listen: Boolean(registry.get(n.type)?.listen),
      webhook: Boolean(registry.get(n.type)?.webhook),
    }));
  // A workflow with no trigger is valid: another workflow starts it with Execute Workflow.
  for (const node of triggerNodes.filter((n) => n.poll)) {
    // The poller reads the interval from the saved config, so it cannot be an expression.
    const { intervalSeconds } = node.config;
    if (
      intervalSeconds !== undefined &&
      !(typeof intervalSeconds === "number" && intervalSeconds > 0)
    ) {
      throw badRequest(`"${node.name}": the poll interval must be a fixed number of seconds`);
    }
  }
  for (const node of triggerNodes.filter((n) => n.type === "trigger.webhook")) {
    const { authentication, path } = node.config;
    if (authentication && authentication !== "none" && !node.credentialId) {
      throw badRequest(`"${node.name}": pick a credential for the authentication`);
    }
    // A path is the address of one trigger. Another trigger must not have it.
    if (typeof path === "string" && path !== "") {
      const owner = await findWebhookTrigger(ctx.services.db, path);
      if (owner && (owner.workflowId !== workflowId || owner.nodeId !== node.id)) {
        throw badRequest(`"${node.name}": the path "${path}" is already in use`);
      }
    }
  }
  for (const node of triggerNodes.filter((n) => n.type === "trigger.cron")) {
    const { expression, timezone } = node.config;
    if (typeof expression !== "string" || expression.includes("{{")) {
      throw badRequest(`"${node.name}": the schedule must be a fixed cron expression`);
    }
    const problem = validateCron(expression, typeof timezone === "string" ? timezone : "UTC");
    if (problem) throw badRequest(`"${node.name}": ${problem}`);
  }
  // A service keeps a webhook until we remove it. Remember the triggers that this publish replaces.
  const previousHooks = wf.active
    ? await nodeWebhookTargets(ctx, workflowId, wf.publishedVersionId)
    : [];
  const version = await ctx.scope.workflows.publish(workflowId, {
    graph,
    triggerNodes,
    userId: ctx.principal.userId,
    newToken: (nodeId) => webhookToken(ctx.services.secretKey, workflowId, nodeId),
  });
  if (!version) throw notFound("Workflow");
  await ctx.services.syncSchedules(ctx.principal.organizationId, workflowId);
  if (wf.active) {
    await removeStaleNodeWebhooks(ctx, workflowId, previousHooks, graph.nodes);
    await syncNodeWebhooks(ctx, workflowId, true);
  }
  return version;
}

const NODE_WEBHOOK_TIMEOUT_MS = 30_000;

type NodeWebhookTarget = {
  node: Graph["nodes"][number];
  token: string;
  state: unknown;
};

/**
 * The trigger nodes of a published version that register a webhook at another service
 * (node types with a `webhook` lifecycle, for example a GitHub or Telegram trigger), with the token
 * and the saved state of each trigger.
 */
async function nodeWebhookTargets(
  ctx: ApiContext,
  workflowId: string,
  versionId: string | null,
): Promise<NodeWebhookTarget[]> {
  if (!versionId) return [];
  const version = await ctx.scope.workflows.getVersion(versionId);
  const graph = graphSchema.safeParse(version?.graph);
  if (!graph.success) return [];
  const nodes = graph.data.nodes.filter((n) => registry.get(n.type)?.webhook);
  if (nodes.length === 0) return [];
  const rows = (await ctx.scope.workflows.triggers([workflowId])).map(
    (t) => t.config as { nodeId?: string; token?: string; nodeState?: unknown },
  );
  return nodes.flatMap((node) => {
    const row = rows.find((c) => c.nodeId === node.id);
    return row?.token ? [{ node, token: row.token, state: row.nodeState }] : [];
  });
}

async function runNodeWebhook(
  ctx: ApiContext,
  workflowId: string,
  target: NodeWebhookTarget,
  action: "activate" | "deactivate",
) {
  const { node, token, state } = target;
  const webhook = registry.get(node.type)?.webhook;
  const definition = registry.get(node.type);
  const run = webhook?.[action];
  if (!definition || !run) return;
  const wf = await requireWorkflow(ctx, workflowId);
  // An OAuth2 token that is near its end is refreshed first.
  const credential = node.credentialId
    ? await openCredential(ctx.scope.credentials, node.credentialId)
    : null;
  const next = await run.call(webhook, {
    config: definition.config.parse(node.config) as Record<string, unknown>,
    credential,
    url: `${ctx.services.baseUrl}/hooks/${token}`,
    workflow: { id: workflowId, name: wf.name },
    node: { id: node.id, name: node.name },
    state,
    signal: AbortSignal.timeout(NODE_WEBHOOK_TIMEOUT_MS),
  });
  if (next !== undefined) await ctx.scope.workflows.setTriggerState(workflowId, node.id, next);
}

/**
 * `on` registers the webhook of each trigger of the published version at its service. Off removes it.
 * A failed removal does not block a stop. A failed registration blocks the start.
 */
async function syncNodeWebhooks(ctx: ApiContext, workflowId: string, on: boolean) {
  const wf = await requireWorkflow(ctx, workflowId);
  for (const target of await nodeWebhookTargets(ctx, workflowId, wf.publishedVersionId)) {
    try {
      await runNodeWebhook(ctx, workflowId, target, on ? "activate" : "deactivate");
    } catch (error) {
      if (on) {
        throw badRequest(
          `"${target.node.name}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.error(JSON.stringify({ msg: "node.webhook_cleanup_failed", error: String(error) }));
    }
  }
}

/** A trigger that left the graph, or got another credential, must not keep its webhook. */
async function removeStaleNodeWebhooks(
  ctx: ApiContext,
  workflowId: string,
  previous: NodeWebhookTarget[],
  nodes: Graph["nodes"],
) {
  const kept = new Map(nodes.map((n) => [n.id, n.credentialId ?? null]));
  for (const old of previous) {
    if (kept.has(old.node.id) && kept.get(old.node.id) === (old.node.credentialId ?? null))
      continue;
    try {
      await runNodeWebhook(ctx, workflowId, old, "deactivate");
    } catch (error) {
      console.error(JSON.stringify({ msg: "node.webhook_cleanup_failed", error: String(error) }));
    }
  }
}

type TestRunTarget = {
  workflowId: string;
  nodeId: string;
  nodeType: string;
  credentialId: string | null;
  /** The config of the node in the editor. It can be newer than the saved draft. */
  config: Record<string, unknown>;
};

/** The definition of a trigger that registers its test address at a service, or a 400 error. */
function testableTrigger(nodeType: string) {
  const definition = registry.get(nodeType);
  if (!definition?.webhookTest || !definition.webhook?.activate) {
    throw badRequest("This node cannot register a test address");
  }
  return { definition, webhook: definition.webhook };
}

/**
 * A test run of a trigger with `webhookTest`: the service sends its events to the test address
 * until the editor stops listening. A service can have one address for an account, so a
 * published workflow with the same account loses its address meanwhile.
 */
export async function pointNodeAtTestUrl(ctx: ApiContext, input: TestRunTarget & { url: string }) {
  const { definition, webhook } = testableTrigger(input.nodeType);
  const wf = await requireWorkflow(ctx, input.workflowId);
  const credential = input.credentialId
    ? await openCredential(ctx.scope.credentials, input.credentialId)
    : null;
  try {
    await webhook.activate?.({
      config: definition.config.parse(input.config) as Record<string, unknown>,
      credential,
      url: input.url,
      workflow: { id: wf.id, name: wf.name },
      node: { id: input.nodeId, name: "" },
      state: undefined,
      signal: AbortSignal.timeout(NODE_WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Ends a test run. An active workflow gets its production address back. Else the trigger
 * removes the address that the test run set.
 */
export async function restoreNodeAfterTest(
  ctx: ApiContext,
  input: TestRunTarget & { productionUrl: string },
) {
  const wf = await requireWorkflow(ctx, input.workflowId);
  try {
    if (wf.active) return await syncNodeWebhooks(ctx, input.workflowId, true);
    const { definition, webhook } = testableTrigger(input.nodeType);
    const credential = input.credentialId
      ? await openCredential(ctx.scope.credentials, input.credentialId)
      : null;
    await webhook.deactivate?.({
      config: definition.config.parse(input.config) as Record<string, unknown>,
      credential,
      url: input.productionUrl,
      workflow: { id: wf.id, name: wf.name },
      node: { id: input.nodeId, name: "" },
      state: undefined,
      signal: AbortSignal.timeout(NODE_WEBHOOK_TIMEOUT_MS),
    });
  } catch (error) {
    console.error(JSON.stringify({ msg: "node.webhook_restore_failed", error: String(error) }));
  }
}

/** The saved draft as a `.zerodot.json` file. It has no variable values and no credential data. */
export async function exportWorkflow(ctx: ApiContext, workflowId: string) {
  const wf = await requireWorkflow(ctx, workflowId);
  return buildExport(wf.name, graphSchema.parse(wf.draftGraph));
}

/**
 * Make a workflow from a `.zerodot.json` file. The new workflow is a draft. A credential that
 * this project does not have is cleared, and the result lists the variable keys it lacks.
 */
export async function importWorkflow(ctx: ApiContext, file: unknown, name?: string) {
  const [credentials, variables] = await Promise.all([
    ctx.scope.credentials.list(),
    ctx.scope.variables.list(),
  ]);
  let parsed: ReturnType<typeof parseImport>;
  try {
    parsed = parseImport(file, {
      credentialIds: credentials.map((c) => c.id),
      variableKeys: variables.map((v) => v.key),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const issue = error.issues[0];
      const where = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
      throw badRequest(
        `This is not a zerodot workflow file: ${issue?.message ?? "invalid"}${where}`,
      );
    }
    throw error;
  }
  const graph = checkedGraph(parsed.graph, { nodes: false });
  const row = await ctx.scope.workflows.create({
    name: (name ?? parsed.name ?? "Imported workflow").slice(0, 120),
  });
  await ctx.scope.workflows.saveDraft(row.id, graph);
  return {
    id: row.id,
    name: row.name,
    missingVariables: parsed.missingVariables,
    clearedCredentials: parsed.clearedCredentials,
  };
}

export async function setWorkflowActive(ctx: ApiContext, workflowId: string, active: boolean) {
  const wf = await requireWorkflow(ctx, workflowId);
  if (active && !wf.publishedVersionId) throw conflict("Publish the workflow first");
  // Set the webhooks first. When a service refuses the address, the workflow stays off.
  if (active) await syncNodeWebhooks(ctx, workflowId, true);
  await ctx.scope.workflows.setActive(workflowId, active);
  await ctx.services.syncSchedules(ctx.principal.organizationId, workflowId);
  if (!active) await syncNodeWebhooks(ctx, workflowId, false);
  return { active };
}

/** Removes the workflow with its versions and runs. Webhooks and schedules go first. */
export async function deleteWorkflow(ctx: ApiContext, workflowId: string) {
  await requireWorkflow(ctx, workflowId);
  await setWorkflowActive(ctx, workflowId, false);
  return { deleted: await ctx.scope.workflows.remove(workflowId) };
}

async function enqueueOrFail(ctx: ApiContext, run: RunRow, mode: "production" | "test") {
  try {
    await ctx.services.enqueue({
      runId: run.id,
      organizationId: ctx.principal.organizationId,
      mode,
    });
  } catch (error) {
    await ctx.scope.runs.finish(run.id, {
      status: "failed",
      error: { message: "Could not queue the run" },
    });
    console.error(JSON.stringify({ msg: "api.enqueue_failed", error: String(error) }));
    throw new ApiError(503, "unavailable", "Could not queue the run");
  }
}

/** A test run of `graph`, or of the saved draft. Uses real credentials. */
export async function startTestRun(
  ctx: ApiContext,
  workflowId: string,
  input: { graph?: Graph; input?: unknown; nodes: boolean; target?: ExecuteTarget },
) {
  const wf = await requireWorkflow(ctx, workflowId);
  const graph = checkedGraph(input.graph ?? graphSchema.parse(wf.draftGraph), {
    nodes: input.nodes,
  });
  await checkCredentials(ctx, graph);
  const { target } = input;
  if (target && !graph.nodes.some((n) => n.id === target.nodeId)) {
    throw badRequest(`The node "${target.nodeId}" does not exist`);
  }
  // One node runs alone: it needs no trigger.
  const trigger =
    target?.kind === "only"
      ? graph.nodes.find((n) => n.id === target.nodeId)
      : (graph.nodes.find((n) => isTriggerType(n.type)) ?? rootNodes(graph)[0]);
  if (!trigger) throw badRequest("Add a node first");
  const { run } = await ctx.scope.runs.create({
    workflowId: wf.id,
    mode: "test",
    graphSnapshot: graph,
    triggerType: isTriggerType(trigger.type) ? trigger.type.slice("trigger.".length) : "manual",
    triggerNodeId: trigger.id,
    triggerInput: input.input ?? {},
    testTarget: target,
  });
  await enqueueOrFail(ctx, run, "test");
  return run;
}

/**
 * A production run of the published version. The workflow does not need to be active:
 * a client that calls the API runs it on purpose. A repeated idempotency key returns the first run.
 */
export async function startProductionRun(
  ctx: ApiContext,
  workflowId: string,
  input: { input?: unknown; nodeId?: string; idempotencyKey?: string },
) {
  const wf = await requireWorkflow(ctx, workflowId);
  if (!wf.publishedVersionId) throw conflict("Publish the workflow first");
  const version = await ctx.scope.workflows.getVersion(wf.publishedVersionId);
  if (!version) throw notFound("Published version");
  const graph = graphSchema.parse(version.graph);
  const triggers = graph.nodes.filter((n) => isTriggerType(n.type));
  const trigger = input.nodeId
    ? triggers.find((n) => n.id === input.nodeId)
    : (triggers[0] ?? rootNodes(graph)[0]);
  if (!trigger) {
    throw badRequest(
      input.nodeId ? `The trigger node "${input.nodeId}" does not exist` : "No node to start at",
    );
  }
  const { run, created } = await ctx.scope.runs.create({
    workflowId: wf.id,
    mode: "production",
    versionId: version.id,
    triggerType: "api",
    triggerNodeId: trigger.id,
    triggerInput: input.input ?? {},
    idempotencyKey: input.idempotencyKey,
  });
  if (created) await enqueueOrFail(ctx, run, "production");
  return run;
}

/**
 * Go on from the failed node of a failed run. The new run uses the same version (or test graph)
 * and the same trigger input. It reuses the saved results of the nodes that succeeded, so only
 * the failed node and the nodes after it run. The old run stays as it is.
 */
export async function retryRun(ctx: ApiContext, runId: string) {
  const source = await ctx.scope.runs.get(runId);
  if (!source) throw notFound("Run");
  if (source.status !== "failed") throw conflict("Only a failed run can be retried");
  if (!source.versionId && !source.graphSnapshot) {
    throw conflict("The workflow version of this run does not exist any more");
  }
  // The workflow can keep no data of a failed run (a setting). Then there is nothing to go on from.
  if (source.triggerInput === null && (await ctx.scope.runs.results(source.id)).length === 0) {
    throw conflict("The data of this run was deleted. Run the workflow again");
  }
  const run = await ctx.scope.runs.createRetry(source.id);
  if (!run) throw notFound("Run");
  await enqueueOrFail(ctx, run, run.mode);
  return run;
}

/**
 * Copy a version into the draft. The published version and the triggers do not change.
 * The restored graph needs only a valid structure: a node type or a credential can be gone.
 */
export async function restoreVersion(ctx: ApiContext, workflowId: string, version: number) {
  await requireWorkflow(ctx, workflowId);
  const row = await ctx.scope.workflows.versionByNumber(workflowId, version);
  if (!row) throw notFound("Version");
  return saveDraft(ctx, workflowId, graphSchema.parse(row.graph), { nodes: false });
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Holds until the run ends or the timeout passes. Returns the last row read. */
export async function waitForRun(ctx: ApiContext, runId: string, signal?: AbortSignal) {
  const deadline = Date.now() + ctx.services.syncTimeoutMs;
  for (;;) {
    const run = await ctx.scope.runs.get(runId);
    if (!run) throw notFound("Run");
    if (TERMINAL.has(run.status) || Date.now() >= deadline || signal?.aborted) return run;
    await sleep(Math.min(POLL_MS, deadline - Date.now()), signal);
  }
}

/** The answer of `run` and `test` calls. The output is the output of the last node that succeeded. */
export async function runOutcome(ctx: ApiContext, run: RunRow) {
  if (!TERMINAL.has(run.status)) {
    return { runId: run.id, status: run.status, output: null, error: null };
  }
  const results = await ctx.scope.runs.results(run.id);
  const last = results
    .filter((r) => r.status === "succeeded" && r.finishedAt)
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
  return {
    runId: run.id,
    status: run.status,
    output: last?.output ?? null,
    error: run.error ?? null,
  };
}

/** Start a run and, with `wait`, hold until it ends. `done` is false when the timeout came first. */
export async function startAndMaybeWait(
  ctx: ApiContext,
  run: RunRow,
  wait: boolean,
  signal?: AbortSignal,
) {
  let latest = run;
  // The run exists already, so a full cap must not fail the call. The caller gets the run id
  // with `done: false` (the same answer as a timeout) and reads the run later.
  const limiter = ctx.services.heldLimiter;
  const release = wait ? (limiter ? limiter.acquire() : () => {}) : null;
  if (release) {
    try {
      latest = await waitForRun(ctx, run.id, signal);
    } finally {
      release();
    }
  }
  return { done: TERMINAL.has(latest.status), outcome: await runOutcome(ctx, latest) };
}

export async function getRunDetail(ctx: ApiContext, runId: string) {
  const run = await ctx.scope.runs.get(runId);
  if (!run) throw notFound("Run");
  const [wf, results, version] = await Promise.all([
    ctx.scope.workflows.get(run.workflowId),
    ctx.scope.runs.results(run.id),
    run.versionId ? ctx.scope.workflows.getVersion(run.versionId) : null,
  ]);
  const parsed = graphSchema.safeParse(version?.graph ?? run.graphSnapshot);
  const names = new Map(parsed.success ? parsed.data.nodes.map((n) => [n.id, n.name]) : []);
  return { run, workflowName: wf?.name ?? "", results, names };
}
