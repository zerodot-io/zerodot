// SPDX-License-Identifier: AGPL-3.0-only

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import type { forOrganization } from "@zerodot/db";
import { type CodeLog, type Graph, GraphError, graphSchema, validateGraph } from "@zerodot/engine";
import { z } from "zod";

type OrgDb = Parameters<typeof forOrganization>[0];

import { asJson } from "../lib/json";

const slugInput = z.object({ projectSlug: z.string().min(1) });

/** Nodes and credential types that the server added at start-up (for example loaded node packages). */
export const getExtraCatalogFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireSession } = await import("./session.server");
  const { session } = await requireSession();
  if (!session) return { nodes: [], credentialTypes: [] };
  const { getServices } = await import("@zerodot/server/services.server");
  await getServices();
  const { addedCatalog, addedCredentialTypeCatalog } = await import("@zerodot/nodes");
  return { nodes: asJson(addedCatalog), credentialTypes: asJson(addedCredentialTypeCatalog) };
});

export const getHomeFn = createServerFn({ method: "GET" }).handler(async () => {
  const { requireSession, projectsFor } = await import("./session.server");
  const { session } = await requireSession();
  if (!session) return { signedIn: false as const };
  const projects = await projectsFor(session.user.id);
  return { signedIn: true as const, slug: projects[0]?.slug ?? null, projects };
});

export const getProjectFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const { requireProject, projectsFor } = await import("./session.server");
    const ctx = await requireProject(data.projectSlug);
    if (!ctx) return null;
    const projects = await projectsFor(ctx.user.id);
    return {
      user: { id: ctx.user.id, name: ctx.user.name, email: ctx.user.email },
      project: ctx.project,
      projects,
    };
  });

export const listWorkflowsFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const { requireProject } = await import("./session.server");
    const ctx = await requireProject(data.projectSlug);
    if (!ctx) throw new Error("Not found");
    const page = await (await orgScope(ctx)).workflows.list();
    return page.items.map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
      published: w.publishedVersionId !== null,
      description: w.description,
      tags: w.tags,
    }));
  });

export const createWorkflowFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ name: z.string().trim().min(1).max(120) }))
  .handler(async ({ data }) => {
    const { requireProject } = await import("./session.server");
    const ctx = await requireProject(data.projectSlug);
    if (!ctx) throw new Error("Not found");
    const row = await (await orgScope(ctx)).workflows.create({
      name: data.name,
    });
    return { id: row.id };
  });

/** An IANA time zone. The runtime must know it. */
const timezoneSchema = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}, "Unknown time zone");

const workflowInput = slugInput.extend({ workflowId: z.string().uuid() });

export const renameWorkflowFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ name: z.string().trim().min(1).max(120) }))
  .handler(async ({ data }) => {
    const { requireProject } = await import("./session.server");
    const ctx = await requireProject(data.projectSlug);
    if (!ctx) throw new Error("Not found");
    const row = await (await orgScope(ctx)).workflows.rename(data.workflowId, data.name);
    if (!row) throw new Error("Not found");
    return { name: row.name };
  });

export const setWorkflowTimezoneFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ timezone: timezoneSchema.nullable() }))
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const row = await (await orgScope(ctx)).workflows.setTimezone(data.workflowId, data.timezone);
    if (!row) throw new Error("Not found");
    const { syncWorkflowSchedules } = await import("@zerodot/server/schedules.server");
    await syncWorkflowSchedules(ctx.project.organizationId, data.workflowId);
    return { timezone: row.timezone };
  });

export const updateWorkflowSettingsFn = createServerFn({ method: "POST" })
  .validator(
    workflowInput.extend({
      description: z.string().trim().max(500).nullable().optional(),
      tags: z
        .array(z.string().trim().min(1).max(32))
        .max(10)
        .transform((tags) => [...new Set(tags)])
        .optional(),
      timeoutSeconds: z.number().int().min(1).max(86_400).nullable().optional(),
      saveSuccessData: z.boolean().optional(),
      saveFailureData: z.boolean().optional(),
      errorWorkflowId: z.string().uuid().nullable().optional(),
      autoRetryMax: z.number().int().min(0).max(10).optional(),
      autoRetryBackoffMs: z.number().int().min(0).max(3_600_000).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const { projectSlug: _slug, workflowId, description, ...rest } = data;
    if (rest.errorWorkflowId) {
      if (rest.errorWorkflowId === workflowId) {
        throw new Error("A workflow cannot be its own error workflow");
      }
      const target = await (await orgScope(ctx)).workflows.get(rest.errorWorkflowId);
      if (!target) throw new Error("Error workflow not found");
    }
    const row = await (await orgScope(ctx)).workflows.updateSettings(workflowId, {
      ...rest,
      ...(description === undefined ? {} : { description: description || null }),
    });
    if (!row) throw new Error("Not found");
    return {
      description: row.description,
      tags: row.tags,
      timeoutSeconds: row.timeoutSeconds,
      saveSuccessData: row.saveSuccessData,
      saveFailureData: row.saveFailureData,
      errorWorkflowId: row.errorWorkflowId,
      autoRetryMax: row.autoRetryMax,
      autoRetryBackoffMs: row.autoRetryBackoffMs,
    };
  });

function checkedGraph(graph: Graph): Graph {
  try {
    validateGraph(graph);
  } catch (error) {
    if (error instanceof GraphError) throw new Error(error.message);
    throw error;
  }
  return graph;
}

// @zerodot/db loads on demand. A static import would put it in the browser bundle.
async function orgScope(ctx: { db: OrgDb; project: { organizationId: string } }) {
  const { forOrganization } = await import("@zerodot/db");
  return forOrganization(ctx.db, ctx.project.organizationId);
}

async function projectOrThrow(slug: string) {
  const { requireProject } = await import("./session.server");
  const ctx = await requireProject(slug);
  if (!ctx) throw new Error("Not found");
  return { ...ctx, scope: await orgScope(ctx) };
}

/** The shared service layer, with the signed-in user as the caller. */
async function serviceContext(slug: string) {
  const { requireProject, isAdmin } = await import("./session.server");
  const ctx = await requireProject(slug);
  if (!ctx) throw new Error("Not found");
  const [{ getApiServices }, { createContext }] = await Promise.all([
    import("@zerodot/server/api/app-services.server"),
    import("@zerodot/server/api/context.server"),
  ]);
  return createContext(await getApiServices(), {
    organizationId: ctx.project.organizationId,
    role: isAdmin(ctx.project.role) ? "admin" : "member",
    userId: ctx.user.id,
    apiKeyId: null,
  });
}

/** The browser gets a plain error with the message. */
async function plain<T>(work: Promise<T>): Promise<T> {
  const { ApiError } = await import("@zerodot/server/api/errors");
  try {
    return await work;
  } catch (error) {
    if (error instanceof ApiError) throw new Error(error.message);
    throw error;
  }
}

export const getWorkflowFn = createServerFn({ method: "GET" })
  .validator(workflowInput)
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const wf = await (await orgScope(ctx)).workflows.get(data.workflowId);
    if (!wf) throw new Error("Not found");
    const { getServices } = await import("@zerodot/server/services.server");
    const { config } = await getServices();
    const publishedVersion = wf.publishedVersionId
      ? await (await orgScope(ctx)).workflows.getVersion(wf.publishedVersionId)
      : null;
    const triggers = (await (await orgScope(ctx)).workflows.triggers([wf.id])).map((t) => {
      const c = t.config as { nodeId?: string; token?: string; path?: string };
      const segment = c.path || c.token;
      return {
        nodeId: c.nodeId ?? "",
        type: t.type,
        url: t.type === "webhook" && segment ? `${config.ZERODOT_BASE_URL}/hooks/${segment}` : null,
      };
    });
    return {
      id: wf.id,
      name: wf.name,
      active: wf.active,
      published: wf.publishedVersionId !== null,
      publishedGraph: publishedVersion ? asJson(graphSchema.parse(publishedVersion.graph)) : null,
      timezone: wf.timezone,
      description: wf.description,
      tags: wf.tags,
      timeoutSeconds: wf.timeoutSeconds,
      saveSuccessData: wf.saveSuccessData,
      saveFailureData: wf.saveFailureData,
      errorWorkflowId: wf.errorWorkflowId,
      autoRetryMax: wf.autoRetryMax,
      autoRetryBackoffMs: wf.autoRetryBackoffMs,
      projectTimezone: (await (await orgScope(ctx)).settings.get()).timezone,
      draftGraph: asJson(graphSchema.parse(wf.draftGraph)),
      triggers,
    };
  });

export const saveDraftFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ graph: graphSchema }))
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const row = await (await orgScope(ctx)).workflows.saveDraft(
      data.workflowId,
      checkedGraph(data.graph),
    );
    if (!row) throw new Error("Not found");
    return { savedAt: row.updatedAt };
  });

const testHookInput = workflowInput.extend({
  nodeId: z.string().min(1),
  /** The path and method of the Webhook node in the editor. They can be newer than the saved draft. */
  path: z.string().optional(),
  method: z.string().optional(),
  /** The response mode of the Webhook node. */
  mode: z.string().optional(),
  /** A Telegram trigger: its bot credential and the updates that it wants. */
  telegram: z
    .object({ credentialId: z.string().min(1), updates: z.array(z.string()).default(["message"]) })
    .optional(),
});

/** The workflow must exist in this project. Returns the token of the trigger node. */
async function testHookToken(data: z.infer<typeof testHookInput>): Promise<string> {
  const ctx = await projectOrThrow(data.projectSlug);
  const scope = await orgScope(ctx);
  const wf = await scope.workflows.get(data.workflowId);
  if (!wf) throw new Error("Not found");
  const rows = await scope.workflows.triggers([wf.id]);
  const existing = rows
    .map((t) => t.config as { nodeId?: string; token?: string })
    .find((c) => c.nodeId === data.nodeId);
  const { tokenOf } = await import("@zerodot/server/test-webhook.server");
  return tokenOf(existing, data.workflowId, data.nodeId, data.path);
}

/** A Telegram test run took the webhook of the bot. Give it back. */
async function restoreTelegram(data: z.infer<typeof testHookInput>) {
  if (!data.telegram) return;
  const ctx = await serviceContext(data.projectSlug);
  const { restoreTelegramWebhook } = await import("@zerodot/server/api/service.server");
  await plain(restoreTelegramWebhook(ctx, data.workflowId, data.telegram.credentialId));
}

export const testWebhookUrlFn = createServerFn({ method: "GET" })
  .validator(testHookInput)
  .handler(async ({ data }) => {
    const { testWebhookUrl } = await import("@zerodot/server/test-webhook.server");
    return { url: await testWebhookUrl(await testHookToken(data)) };
  });

export const listenForTestEventFn = createServerFn({ method: "POST" })
  .validator(testHookInput)
  .handler(async ({ data }) => {
    const { startListening, testWebhookUrl } = await import("@zerodot/server/test-webhook.server");
    const token = await testHookToken(data);
    if (data.telegram) {
      const ctx = await serviceContext(data.projectSlug);
      const { pointTelegramAtTestUrl } = await import("@zerodot/server/api/service.server");
      await plain(
        pointTelegramAtTestUrl(ctx, {
          ...data.telegram,
          token,
          url: await testWebhookUrl(token),
        }),
      );
    }
    await startListening(token, data.method ?? "POST", data.mode ?? "immediate", !!data.telegram);
    return { ok: true };
  });

export const stopListeningFn = createServerFn({ method: "POST" })
  .validator(testHookInput)
  .handler(async ({ data }) => {
    const { stopListening } = await import("@zerodot/server/test-webhook.server");
    await stopListening(await testHookToken(data));
    await restoreTelegram(data);
    return { ok: true };
  });

export const linkTestRunFn = createServerFn({ method: "POST" })
  .validator(testHookInput.extend({ runId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const token = await testHookToken(data);
    const { linkRun } = await import("@zerodot/server/test-webhook.server");
    await linkRun(token, data.runId, ctx.project.organizationId);
    return { ok: true };
  });

export const takeTestEventFn = createServerFn({ method: "POST" })
  .validator(testHookInput)
  .handler(async ({ data }) => {
    const { takeEvent } = await import("@zerodot/server/test-webhook.server");
    const event = await takeEvent(await testHookToken(data));
    if (event !== null) await restoreTelegram(data);
    return { event: asJson(event) };
  });

export const publishFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ graph: graphSchema }))
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { publishWorkflow } = await import("@zerodot/server/api/service.server");
    const version = await plain(
      publishWorkflow(ctx, data.workflowId, { graph: data.graph, nodes: false }),
    );
    return { version: version.version };
  });

export const setActiveFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ active: z.boolean() }))
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { setWorkflowActive } = await import("@zerodot/server/api/service.server");
    return plain(setWorkflowActive(ctx, data.workflowId, data.active));
  });

const testTargetInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("to"), nodeId: z.string().min(1) }),
  z.object({
    kind: z.literal("only"),
    nodeId: z.string().min(1),
    input: z.unknown(),
    outputs: z.record(z.string(), z.object({ port: z.string(), data: z.unknown() })),
  }),
]);

export const exportWorkflowFn = createServerFn({ method: "GET" })
  .validator(workflowInput)
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { exportWorkflow } = await import("@zerodot/server/api/service.server");
    return asJson(await plain(exportWorkflow(ctx, data.workflowId)));
  });

export const importWorkflowFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ file: z.unknown() }))
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { importWorkflow } = await import("@zerodot/server/api/service.server");
    return plain(importWorkflow(ctx, data.file));
  });

export const startTestRunFn = createServerFn({ method: "POST" })
  .validator(
    workflowInput.extend({
      graph: graphSchema,
      input: z.unknown(),
      target: testTargetInput.optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { startTestRun } = await import("@zerodot/server/api/service.server");
    const run = await plain(
      startTestRun(ctx, data.workflowId, {
        graph: data.graph,
        input: data.input,
        nodes: false,
        target: data.target,
      }),
    );
    return { runId: run.id };
  });

export const listRunsFn = createServerFn({ method: "GET" })
  .validator(
    slugInput.extend({
      workflowId: z.string().uuid().optional(),
      status: z
        .enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"])
        .optional(),
      triggerType: z.string().optional(),
      mode: z.enum(["production", "test"]).optional(),
      cursor: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const page = await ctx.scope.runs.list({
      workflowId: data.workflowId,
      status: data.status,
      triggerType: data.triggerType,
      mode: data.mode,
      cursor: data.cursor,
    });
    const orgWorkflows = (await orgScope(ctx)).workflows;
    const versionIds = [...new Set(page.items.flatMap((r) => (r.versionId ? [r.versionId] : [])))];
    const versions = new Map(
      await Promise.all(
        versionIds.map(async (id) => [id, await orgWorkflows.getVersion(id)] as const),
      ),
    );
    /** The name of the trigger node of a run, so a Telegram run does not show as "webhook". */
    const triggerNameOf = (r: (typeof page.items)[number]): string | null => {
      const graphJson = r.versionId ? versions.get(r.versionId)?.graph : r.graphSnapshot;
      const parsed = graphSchema.safeParse(graphJson);
      if (!parsed.success) return null;
      return parsed.data.nodes.find((n) => n.id === r.triggerNodeId)?.name ?? null;
    };
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((r) => ({
        triggerName: triggerNameOf(r),
        id: r.id,
        workflowId: r.workflowId,
        workflowName: r.workflowName,
        mode: r.mode,
        status: r.status,
        triggerType: r.triggerType,
        createdAt: r.createdAt,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
    };
  });

export const getRunFn = createServerFn({ method: "GET" })
  .validator(slugInput.extend({ runId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const run = await ctx.scope.runs.get(data.runId);
    if (!run) throw new Error("Not found");
    const [wf, results, version] = await Promise.all([
      (await orgScope(ctx)).workflows.get(run.workflowId),
      ctx.scope.runs.results(run.id),
      run.versionId ? (await orgScope(ctx)).workflows.getVersion(run.versionId) : null,
    ]);
    const graph = graphSchema.parse(version?.graph ?? run.graphSnapshot);
    return {
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: wf?.name ?? "",
        mode: run.mode,
        status: run.status,
        triggerType: run.triggerType,
        triggerName: graph.nodes.find((n) => n.id === run.triggerNodeId)?.name ?? null,
        triggerInput: asJson(run.triggerInput),
        error: run.error as { message: string; nodeId?: string } | null,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
      nodes: graph.nodes.map((n) => ({ id: n.id, name: n.name, type: n.type })),
      graph: asJson(graph),
      results: results.map((r) => ({
        nodeId: r.nodeId,
        attempt: r.attempt,
        status: r.status,
        port: r.port,
        input: asJson(r.input),
        output: asJson(r.output),
        error: r.error as { message: string; path?: string } | null,
        logs: (r.logs ?? []) as CodeLog[],
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
      })),
    };
  });

export const retryRunFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ runId: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { retryRun } = await import("@zerodot/server/api/service.server");
    const run = await plain(retryRun(ctx, data.runId));
    return { runId: run.id };
  });

/** Published versions of a workflow, newest first. */
export const listVersionsFn = createServerFn({ method: "GET" })
  .validator(workflowInput)
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const wf = await ctx.scope.workflows.get(data.workflowId);
    if (!wf) throw new Error("Not found");
    const page = await ctx.scope.workflows.listVersions(wf.id, { limit: 100 });
    return page.items.map((v) => ({
      version: v.version,
      createdAt: v.createdAt,
      published: v.id === wf.publishedVersionId,
    }));
  });

/** One version, and what restoring it changes in the draft. */
export const getVersionFn = createServerFn({ method: "GET" })
  .validator(workflowInput.extend({ version: z.number().int().min(1) }))
  .handler(async ({ data }) => {
    const ctx = await projectOrThrow(data.projectSlug);
    const wf = await ctx.scope.workflows.get(data.workflowId);
    const row = wf ? await ctx.scope.workflows.versionByNumber(wf.id, data.version) : null;
    if (!wf || !row) throw new Error("Not found");
    const { diffGraphs } = await import("@zerodot/engine");
    const draft = graphSchema.parse(wf.draftGraph);
    const graph = graphSchema.parse(row.graph);
    return {
      version: row.version,
      nodeCount: graph.nodes.length,
      // From the draft to the version: what the draft gets when you restore.
      diff: diffGraphs(draft, graph),
    };
  });

export const restoreVersionFn = createServerFn({ method: "POST" })
  .validator(workflowInput.extend({ version: z.number().int().min(1) }))
  .handler(async ({ data }) => {
    const ctx = await serviceContext(data.projectSlug);
    const { restoreVersion } = await import("@zerodot/server/api/service.server");
    const row = await plain(restoreVersion(ctx, data.workflowId, data.version));
    return { draftGraph: asJson(graphSchema.parse(row.draftGraph)) };
  });

// ---- System page (instance admin) ----

const queueNameSchema = z.enum(["runs", "system"]);
const queueInput = z.object({ queue: queueNameSchema });
const jobInput = queueInput.extend({ jobId: z.string().min(1).max(200) });

/** The request headers. The admin functions in @zerodot/server check the session from them. */
const adminHeaders = createServerOnlyFn(async () => {
  const { getRequestHeaders } = await import("@tanstack/react-start/server");
  return getRequestHeaders();
});

const adminServer = createServerOnlyFn(() => import("@zerodot/server/admin.server"));

/** True for an instance admin. Safe for any signed-in user. Used to show the System link. */
export const getIsInstanceAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { requireSession } = await import("./session.server");
  const { session } = await requireSession();
  if (!session) return false;
  const { isInstanceAdmin } = await adminServer();
  return isInstanceAdmin({ id: session.user.id, email: session.user.email });
});

export const getAdminOverview = createServerFn({ method: "GET" }).handler(async () => {
  const { adminOverview } = await adminServer();
  return asJson(await adminOverview(await adminHeaders()));
});

export const getAdminJobs = createServerFn({ method: "GET" })
  .validator(
    queueInput.extend({
      state: z.enum(["waiting", "active", "delayed", "prioritized", "failed", "completed"]),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const { listQueueJobs } = await adminServer();
    return listQueueJobs(await adminHeaders(), data);
  });

export const adminCancelRun = createServerFn({ method: "POST" })
  .validator(z.object({ runId: z.string().min(1).max(100) }))
  .handler(async ({ data }) => {
    const { cancelRun } = await adminServer();
    return cancelRun(await adminHeaders(), data.runId);
  });

export const adminRetryJob = createServerFn({ method: "POST" })
  .validator(jobInput)
  .handler(async ({ data }) => {
    const { retryJob } = await adminServer();
    return retryJob(await adminHeaders(), data);
  });

export const adminRemoveJob = createServerFn({ method: "POST" })
  .validator(jobInput)
  .handler(async ({ data }) => {
    const { removeJob } = await adminServer();
    return removeJob(await adminHeaders(), data);
  });

export const adminCleanQueue = createServerFn({ method: "POST" })
  .validator(
    queueInput.extend({
      state: z.enum(["completed", "failed", "delayed", "waiting", "prioritized"]),
      olderThanMs: z.number().int().min(0),
    }),
  )
  .handler(async ({ data }) => {
    const { cleanQueue } = await adminServer();
    return cleanQueue(await adminHeaders(), data);
  });

export const adminPromoteJob = createServerFn({ method: "POST" })
  .validator(jobInput)
  .handler(async ({ data }) => {
    const { promoteDelayedJob } = await adminServer();
    return promoteDelayedJob(await adminHeaders(), data);
  });

export const adminPauseQueue = createServerFn({ method: "POST" })
  .validator(queueInput)
  .handler(async ({ data }) => {
    const { pauseQueue } = await adminServer();
    return pauseQueue(await adminHeaders(), data);
  });

export const adminResumeQueue = createServerFn({ method: "POST" })
  .validator(queueInput)
  .handler(async ({ data }) => {
    const { resumeQueue } = await adminServer();
    return resumeQueue(await adminHeaders(), data);
  });

export const getAdminSignup = createServerFn({ method: "GET" }).handler(async () => {
  const { getSignupSetting } = await adminServer();
  return getSignupSetting(await adminHeaders());
});

export const adminSetSignup = createServerFn({ method: "POST" })
  .validator(z.object({ disabled: z.boolean() }))
  .handler(async ({ data }) => {
    const { updateSignupSetting } = await adminServer();
    return updateSignupSetting(await adminHeaders(), data);
  });

// ---- Node packages ----

const nodePackageServer = createServerOnlyFn(() => import("@zerodot/server/node-packages.server"));

const packageNameInput = z.object({ name: z.string().min(1).max(214) });

/** Installed and available packages, for the System page. Instance admins only. */
export const getNodePackagesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { nodePackagesOverview } = await nodePackageServer();
  return nodePackagesOverview(await adminHeaders());
});

/** Packages that are not installed, for the Add node list. Any signed-in person. */
export const getAvailableNodePackagesFn = createServerFn({ method: "GET" }).handler(async () => {
  const { availableNodePackages } = await nodePackageServer();
  return availableNodePackages(await adminHeaders());
});

export const installNodePackageFn = createServerFn({ method: "POST" })
  .validator(packageNameInput)
  .handler(async ({ data }) => {
    const { installNodePackage } = await nodePackageServer();
    return installNodePackage(await adminHeaders(), data);
  });

export const uninstallNodePackageFn = createServerFn({ method: "POST" })
  .validator(packageNameInput)
  .handler(async ({ data }) => {
    const { uninstallNodePackage } = await nodePackageServer();
    return uninstallNodePackage(await adminHeaders(), data);
  });
