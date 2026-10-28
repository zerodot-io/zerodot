// SPDX-License-Identifier: AGPL-3.0-only

import { checkVariableValue, filterSchema, graphSchema, MAX_VARIABLES } from "@zerodot/engine";
import { catalog, credentialTypeCatalog, validateCredentialData } from "@zerodot/nodes";
import { runStreamKey } from "@zerodot/queue";
import { z } from "zod";
import { buildInsights } from "../insights.server";
import { streamEvents } from "../stream.server";
import type { ApiContext } from "./context.server";
import { badRequest, conflict, notFound } from "./errors";
import {
  presentCredential,
  presentRow,
  presentRun,
  presentRunDetail,
  presentTable,
  presentVariable,
  presentVersion,
  presentWorkflow,
} from "./present";
import { defineRoute, Reply, type Route } from "./route";
import * as s from "./schemas";
import {
  checkedGraph,
  exportWorkflow,
  getRunDetail,
  importWorkflow,
  publishWorkflow,
  requireWorkflow,
  restoreVersion,
  retryRun,
  saveDraft,
  setWorkflowActive,
  startAndMaybeWait,
  startProductionRun,
  startTestRun,
} from "./service.server";

const iso = (d: Date) => d.toISOString();

async function workflowDetail(ctx: ApiContext, id: string) {
  const wf = await requireWorkflow(ctx, id);
  const triggers = await ctx.scope.workflows.triggers([wf.id]);
  return {
    ...presentWorkflow(wf),
    draftGraph: graphSchema.parse(wf.draftGraph),
    triggers: triggers.map((t) => {
      const config = t.config as { nodeId?: string; token?: string };
      return {
        nodeId: config.nodeId ?? "",
        type: t.type,
        url:
          t.type === "webhook" && config.token
            ? `${ctx.services.baseUrl}/hooks/${config.token}`
            : null,
      };
    }),
  };
}

async function requireTable(ctx: ApiContext, ref: string) {
  const table = await ctx.scope.tables.get(ref);
  if (!table) throw notFound("Table");
  return table;
}

const idEquals = (id: string) => filterSchema.parse({ field: "id", op: "eq", value: id });

/** A run answers 202 until it ends, and 200 with the outcome when it has ended. */
async function runReply(
  ctx: ApiContext,
  run: Parameters<typeof startAndMaybeWait>[1],
  wait: boolean,
  request: Request,
) {
  const { done, outcome } = await startAndMaybeWait(ctx, run, wait, request.signal);
  return new Reply(done ? 200 : 202, outcome);
}

// ---- Workflows ----

const workflows: Route[] = [
  defineRoute({
    method: "GET",
    path: "/workflows",
    summary: "List workflows",
    tag: "Workflows",
    query: s.pageQuery,
    response: s.page(s.workflowSummary),
    async handler(ctx, { query }) {
      const result = await ctx.scope.workflows.list(query);
      return { items: result.items.map(presentWorkflow), nextCursor: result.nextCursor };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows",
    summary: "Create a workflow",
    description:
      "The graph is checked against the node types: known types, config, and edge ports.",
    tag: "Workflows",
    status: 201,
    body: s.workflowCreate,
    response: s.workflowDetail,
    async handler(ctx, { body }) {
      const graph = body.graph ? checkedGraph(body.graph, { nodes: true }) : undefined;
      const row = await ctx.scope.workflows.create({ name: body.name });
      if (graph) await saveDraft(ctx, row.id, graph, { nodes: true });
      return new Reply(201, await workflowDetail(ctx, row.id));
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/import",
    summary: "Create a workflow from a .zerodot.json file",
    description:
      "The new workflow is a draft. A credential id that the project does not have is cleared. The answer lists the variable keys that the project lacks.",
    tag: "Workflows",
    status: 201,
    body: s.workflowImportBody,
    response: s.workflowImportResult,
    async handler(ctx, { body }) {
      return new Reply(201, await importWorkflow(ctx, body.file, body.name));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workflows/:id/export",
    summary: "Export the draft as a .zerodot.json file",
    description:
      "The file has no variable values and no credential data. It lists the variable keys that the workflow reads.",
    tag: "Workflows",
    params: s.idParam,
    response: s.workflowExport,
    handler: (ctx, { params }) => exportWorkflow(ctx, params.id),
  }),
  defineRoute({
    method: "GET",
    path: "/workflows/:id",
    summary: "Get a workflow with its draft graph",
    tag: "Workflows",
    params: s.idParam,
    response: s.workflowDetail,
    handler: (ctx, { params }) => workflowDetail(ctx, params.id),
  }),
  defineRoute({
    method: "PATCH",
    path: "/workflows/:id",
    summary: "Rename a workflow or replace its draft graph",
    tag: "Workflows",
    params: s.idParam,
    body: s.workflowPatch,
    response: s.workflowDetail,
    async handler(ctx, { params, body }) {
      await requireWorkflow(ctx, params.id);
      if (body.graph) await saveDraft(ctx, params.id, body.graph, { nodes: true });
      if (body.name) await ctx.scope.workflows.rename(params.id, body.name);
      return workflowDetail(ctx, params.id);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workflows/:id/versions",
    summary: "List published versions",
    tag: "Workflows",
    params: s.idParam,
    query: s.pageQuery,
    response: s.page(s.versionSummary),
    async handler(ctx, { params, query }) {
      await requireWorkflow(ctx, params.id);
      const result = await ctx.scope.workflows.listVersions(params.id, query);
      return { items: result.items.map(presentVersion), nextCursor: result.nextCursor };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/workflows/:id/versions/:version",
    summary: "Get one version with its graph",
    tag: "Workflows",
    params: s.versionParams,
    response: s.versionDetail,
    async handler(ctx, { params }) {
      await requireWorkflow(ctx, params.id);
      const row = await ctx.scope.workflows.versionByNumber(params.id, params.version);
      if (!row) throw notFound("Version");
      return { ...presentVersion(row), graph: graphSchema.parse(row.graph) };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/:id/versions/:version/restore",
    summary: "Copy a version into the draft",
    description:
      "The draft is replaced by the graph of the version. The published version does not change. Publish the draft to make it live.",
    tag: "Workflows",
    params: s.versionParams,
    response: s.workflowDetail,
    async handler(ctx, { params }) {
      await restoreVersion(ctx, params.id, params.version);
      return workflowDetail(ctx, params.id);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/:id/publish",
    summary: "Publish the draft, or a graph in the body, as a new version",
    tag: "Workflows",
    params: s.idParam,
    body: s.publishBody,
    response: s.publishResult,
    async handler(ctx, { params, body }) {
      const version = await publishWorkflow(ctx, params.id, { graph: body.graph, nodes: true });
      return { version: version.version, versionId: version.id };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/:id/activate",
    summary: "Turn triggers on or off",
    description: "A workflow needs a published version to be active.",
    tag: "Workflows",
    params: s.idParam,
    body: s.activateBody,
    response: s.activateResult,
    handler: (ctx, { params, body }) => setWorkflowActive(ctx, params.id, body.active),
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/:id/run",
    summary: "Run the published version",
    description:
      "Returns 202 with the run id. With `wait=true` the request holds until the run ends " +
      "and returns 200 with the output of the last node. If the run is still going after " +
      "the timeout, the answer is 202 with the current status. The header `Idempotency-Key` " +
      "makes a repeated call return the first run.",
    tag: "Runs",
    alsoStatus: [202],
    params: s.idParam,
    query: s.waitQuery,
    body: s.runBody,
    response: s.runOutcome,
    async handler(ctx, { params, query, body, request }) {
      const run = await startProductionRun(ctx, params.id, {
        input: body.input,
        nodeId: body.nodeId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
      });
      return runReply(ctx, run, query.wait, request);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/workflows/:id/test",
    summary: "Test run of the draft in test mode",
    description:
      "Test runs use real credentials and write real data. They are deleted after the test run retention.",
    tag: "Runs",
    alsoStatus: [202],
    params: s.idParam,
    query: s.waitQuery,
    body: s.testBody,
    response: s.runOutcome,
    async handler(ctx, { params, query, body, request }) {
      const run = await startTestRun(ctx, params.id, {
        graph: body.graph,
        input: body.input,
        nodes: true,
        target: body.toNodeId ? { kind: "to", nodeId: body.toNodeId } : undefined,
      });
      return runReply(ctx, run, query.wait, request);
    },
  }),
];

// ---- Runs ----

const runs: Route[] = [
  defineRoute({
    method: "GET",
    path: "/runs",
    summary: "List runs, newest first",
    tag: "Runs",
    query: s.runsQuery,
    response: s.page(s.runSummary),
    async handler(ctx, { query }) {
      const result = await ctx.scope.runs.list(query);
      return { items: result.items.map(presentRun), nextCursor: result.nextCursor };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/runs/:id",
    summary: "Get a run with the result of each node",
    tag: "Runs",
    params: s.idParam,
    response: s.runDetail,
    async handler(ctx, { params }) {
      const detail = await getRunDetail(ctx, params.id);
      return presentRunDetail(detail.run, detail.workflowName, detail.results, detail.names);
    },
  }),
  defineRoute({
    method: "POST",
    path: "/runs/:id/retry",
    summary: "Retry a failed run from the failed node",
    description:
      "Makes a new run with the same version and trigger input. The new run reuses the saved " +
      "results of the nodes that succeeded, so only the failed node and the nodes after it " +
      "run. Only a failed run can be retried. Returns 202 with the new run id. With " +
      "`wait=true` the request holds until the new run ends, like the run route.",
    tag: "Runs",
    alsoStatus: [202],
    params: s.idParam,
    query: s.waitQuery,
    response: s.runOutcome,
    async handler(ctx, { params, query, request }) {
      return runReply(ctx, await retryRun(ctx, params.id), query.wait, request);
    },
  }),
  defineRoute({
    method: "GET",
    path: "/runs/:id/events",
    summary: "Server-sent events of a run",
    description:
      "Send `Last-Event-ID` to continue after a break. The stream ends after `run.finished`. " +
      "Use a client that can send the `Authorization` header (not the browser EventSource).",
    tag: "Runs",
    stream: true,
    params: s.idParam,
    response: z.string(),
    async handler(ctx, { params, request }) {
      const run = await ctx.scope.runs.get(params.id);
      if (!run) throw notFound("Run");
      return streamEvents(request, runStreamKey(run.id), true, ctx.services.reader);
    },
  }),
];

// ---- Credentials and node types ----

const credentials: Route[] = [
  defineRoute({
    method: "GET",
    path: "/credentials",
    summary: "List credential names and types",
    description: "No response holds a secret value.",
    tag: "Credentials",
    response: z.object({ items: z.array(s.credentialSummary) }),
    async handler(ctx) {
      return { items: (await ctx.scope.credentials.list()).map(presentCredential) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/credential-types",
    summary: "List credential types and the fields of each",
    tag: "Credentials",
    response: z.object({ items: z.array(s.credentialType) }),
    async handler() {
      return { items: credentialTypeCatalog };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/credentials",
    summary: "Create a credential",
    tag: "Credentials",
    role: "admin",
    status: 201,
    body: s.credentialCreate,
    response: s.credentialSummary,
    async handler(ctx, { body }) {
      const problem = validateCredentialData(body.type, body.fields);
      if (problem) throw badRequest(problem);
      const row = await ctx.scope.credentials.create({
        name: body.name,
        type: body.type,
        data: body.fields,
      });
      return new Reply(201, presentCredential(row));
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/credentials/:id",
    summary: "Rename a credential or change fields",
    tag: "Credentials",
    role: "admin",
    params: s.idParam,
    body: s.credentialPatch,
    response: s.credentialSummary,
    async handler(ctx, { params, body }) {
      const patch = Object.fromEntries(
        Object.entries(body.fields ?? {}).filter(([, v]) => v !== ""),
      );
      const current = (await ctx.scope.credentials.list()).find((c) => c.id === params.id);
      if (!current) throw notFound("Credential");
      const problem = validateCredentialData(current.type, patch, { partial: true });
      if (problem) throw badRequest(problem);
      const row = await ctx.scope.credentials.update(params.id, { name: body.name, patch });
      if (!row) throw notFound("Credential");
      return presentCredential(row);
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/credentials/:id",
    summary: "Delete a credential that no workflow uses",
    tag: "Credentials",
    role: "admin",
    params: s.idParam,
    response: s.deleted,
    async handler(ctx, { params }) {
      const users = await ctx.scope.credentials.usedBy(params.id);
      if (users.length > 0) {
        throw conflict(`In use by: ${users.map((w) => w.name).join(", ")}`);
      }
      return { deleted: await ctx.scope.credentials.remove(params.id) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/node-types",
    summary: "List node types",
    tag: "Node types",
    response: z.object({ items: z.array(s.nodeType) }),
    async handler() {
      return { items: catalog };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/node-types/:type",
    summary: "Get a node type with the JSON Schema of its config",
    tag: "Node types",
    params: s.typeParams,
    response: s.nodeType,
    async handler(_ctx, { params }) {
      const entry = catalog.find((n) => n.type === params.type);
      if (!entry) throw notFound("Node type");
      return entry;
    },
  }),
];

// ---- Variables ----

const variables: Route[] = [
  defineRoute({
    method: "GET",
    path: "/variables",
    summary: "List variables",
    tag: "Variables",
    response: z.object({ items: z.array(s.variableOut) }),
    async handler(ctx) {
      return { items: (await ctx.scope.variables.list()).map(presentVariable) };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/variables",
    summary: "Create a variable",
    tag: "Variables",
    role: "admin",
    status: 201,
    body: s.variableCreate,
    response: s.variableOut,
    async handler(ctx, { body }) {
      if ((await ctx.scope.variables.count()) >= MAX_VARIABLES) {
        throw badRequest(`A project can have ${MAX_VARIABLES} variables`);
      }
      const row = await ctx.scope.variables.create(
        {
          key: body.key,
          type: body.type,
          value: body.value,
          description: body.description,
        },
        ctx.principal.userId,
      );
      return new Reply(201, presentVariable(row));
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/variables/:key",
    summary: "Change a variable",
    tag: "Variables",
    role: "admin",
    params: s.keyParams,
    body: s.variablePatch,
    response: s.variableOut,
    async handler(ctx, { params, body }) {
      const problem = checkVariableValue(body.type, body.value);
      if (problem) throw badRequest(problem);
      const row = await ctx.scope.variables.update(
        params.key,
        { type: body.type, value: body.value, description: body.description },
        ctx.principal.userId,
      );
      if (!row) throw notFound("Variable");
      return presentVariable(row);
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/variables/:key",
    summary: "Delete a variable",
    tag: "Variables",
    role: "admin",
    params: s.keyParams,
    response: s.deleted,
    async handler(ctx, { params }) {
      return { deleted: await ctx.scope.variables.remove(params.key) };
    },
  }),
];

// ---- Data tables ----

const tables: Route[] = [
  defineRoute({
    method: "GET",
    path: "/tables",
    summary: "List data tables",
    tag: "Data tables",
    response: z.object({ items: z.array(s.tableOut) }),
    async handler(ctx) {
      return { items: (await ctx.scope.tables.list()).map(presentTable) };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/tables",
    summary: "Create a data table",
    tag: "Data tables",
    role: "admin",
    status: 201,
    body: s.tableCreate,
    response: s.tableOut,
    async handler(ctx, { body }) {
      return new Reply(201, presentTable(await ctx.scope.tables.create(body)));
    },
  }),
  defineRoute({
    method: "GET",
    path: "/tables/:id",
    summary: "Get a data table by id or name",
    tag: "Data tables",
    params: s.tableParams,
    response: s.tableOut,
    async handler(ctx, { params }) {
      return presentTable(await requireTable(ctx, params.id));
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/tables/:id",
    summary: "Rename a table, or add, rename, retype, or drop columns",
    tag: "Data tables",
    role: "admin",
    params: s.tableParams,
    body: s.tablePatch,
    response: s.tableOut,
    async handler(ctx, { params, body }) {
      let table = await requireTable(ctx, params.id);
      if (body.ops) table = await ctx.scope.tables.alter(table.id, body.ops);
      if (body.name !== undefined || body.description !== undefined) {
        const updated = await ctx.scope.tables.update(table.id, {
          name: body.name,
          description: body.description,
        });
        if (!updated) throw notFound("Table");
        table = updated;
      }
      return presentTable(table);
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/tables/:id",
    summary: "Delete a data table and its rows",
    tag: "Data tables",
    role: "admin",
    params: s.tableParams,
    response: s.deleted,
    async handler(ctx, { params }) {
      const table = await requireTable(ctx, params.id);
      return { deleted: await ctx.scope.tables.remove(table.id) };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/tables/:id/rows",
    summary: "List rows in insert order",
    tag: "Data tables",
    params: s.tableParams,
    query: s.rowsListQuery,
    response: s.rowsPage,
    async handler(ctx, { params, query }) {
      const page = await ctx.scope.tables.queryRows(params.id, query);
      return { rows: page.rows.map(presentRow), nextCursor: page.nextCursor };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/tables/:id/rows/query",
    summary: "Find rows with a filter and a sort",
    tag: "Data tables",
    params: s.tableParams,
    body: s.rowsQueryBody,
    response: s.rowsPage,
    async handler(ctx, { params, body }) {
      const page = await ctx.scope.tables.queryRows(params.id, body);
      return { rows: page.rows.map(presentRow), nextCursor: page.nextCursor };
    },
  }),
  defineRoute({
    method: "POST",
    path: "/tables/:id/rows",
    summary: "Insert rows",
    description: "Each row is checked against the column schema.",
    tag: "Data tables",
    status: 201,
    params: s.tableParams,
    body: s.rowsInsert,
    response: s.rowsInserted,
    async handler(ctx, { params, body }) {
      const rows = await ctx.scope.tables.insertRows(params.id, body.rows);
      return new Reply(201, { count: rows.length, rows: rows.map(presentRow) });
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/tables/:id/rows",
    summary: "Update the rows that match a filter",
    description: "Without a filter, send `all: true`.",
    tag: "Data tables",
    params: s.tableParams,
    body: s.rowsUpdate,
    response: s.rowsUpdated,
    async handler(ctx, { params, body }) {
      const result = await ctx.scope.tables.updateRows(params.id, body);
      return { count: result.count, rows: result.rows.map(presentRow) };
    },
  }),
  defineRoute({
    method: "PATCH",
    path: "/tables/:id/rows/:rowId",
    summary: "Update one row",
    tag: "Data tables",
    params: s.rowParams,
    body: s.rowPatch,
    response: s.rowOut,
    async handler(ctx, { params, body }) {
      const result = await ctx.scope.tables.updateRows(params.id, {
        filter: idEquals(params.rowId),
        set: body.set,
      });
      const row = result.rows[0];
      if (!row) throw notFound("Row");
      return presentRow(row);
    },
  }),
  defineRoute({
    method: "DELETE",
    path: "/tables/:id/rows/:rowId",
    summary: "Delete one row",
    tag: "Data tables",
    params: s.rowParams,
    response: s.deleted,
    async handler(ctx, { params }) {
      const result = await ctx.scope.tables.deleteRows(params.id, {
        filter: idEquals(params.rowId),
      });
      return { deleted: result.count > 0 };
    },
  }),
];

// ---- Insights ----

function insightsFor(ctx: ApiContext, query: z.output<typeof s.insightsQuery>) {
  const ids = query.workflowId === undefined ? [] : [query.workflowId].flat();
  return buildInsights(ctx.scope, {
    range: query.range,
    workflowIds: ids,
    triggerType: query.triggerType,
    includeTest: query.includeTest,
  });
}

const insights: Route[] = [
  defineRoute({
    method: "GET",
    path: "/insights/summary",
    summary: "KPIs for the range, and for the range before it",
    tag: "Insights",
    query: s.insightsQuery,
    response: s.insightsSummary,
    async handler(ctx, { query }) {
      const data = await insightsFor(ctx, query);
      return { from: iso(data.from), to: iso(data.to), ...data.kpis };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/insights/timeseries",
    summary: "KPIs for each time bucket",
    tag: "Insights",
    query: s.insightsQuery,
    response: s.insightsTimeseries,
    async handler(ctx, { query }) {
      const data = await insightsFor(ctx, query);
      return {
        from: iso(data.from),
        to: iso(data.to),
        granularity: data.granularity,
        points: data.series.map((p) => ({ ...p, bucket: iso(p.bucket) })),
      };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/insights/workflows",
    summary: "KPIs for each workflow",
    tag: "Insights",
    query: s.insightsQuery,
    response: s.insightsWorkflows,
    async handler(ctx, { query }) {
      const data = await insightsFor(ctx, query);
      return {
        workflows: data.table.map(({ trend: _trend, ...w }) => ({
          ...w,
          lastRunAt: w.lastRunAt ? iso(w.lastRunAt) : null,
          lastFailureAt: w.lastFailureAt ? iso(w.lastFailureAt) : null,
        })),
      };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/insights/nodes",
    summary: "Runs, failures, and duration for each node",
    tag: "Insights",
    query: s.insightsQuery,
    response: s.insightsNodes,
    async handler(ctx, { query }) {
      return { nodes: (await insightsFor(ctx, query)).allNodes };
    },
  }),
  defineRoute({
    method: "GET",
    path: "/insights/errors",
    summary: "Top errors, grouped by a normalized message",
    tag: "Insights",
    query: s.insightsQuery,
    response: s.insightsErrors,
    async handler(ctx, { query }) {
      const data = await insightsFor(ctx, query);
      return {
        errors: data.errors.map((e) => ({
          ...e,
          firstSeenAt: iso(e.firstSeenAt),
          lastSeenAt: iso(e.lastSeenAt),
        })),
      };
    },
  }),
];

export const routes: Route[] = [
  ...workflows,
  ...runs,
  ...credentials,
  ...variables,
  ...tables,
  ...insights,
];
