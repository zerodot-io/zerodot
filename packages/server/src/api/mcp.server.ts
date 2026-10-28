// SPDX-License-Identifier: AGPL-3.0-only
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  type ApiContext,
  type ApiServices,
  authenticate,
  createContext,
  enforceRateLimit,
  requireAdmin,
} from "./context.server";
import { ApiError, errorResponse, notFound, toErrorBody } from "./errors";
import { type RawInput, Reply, type Route } from "./route";
import { routes } from "./routes.server";
import * as s from "./schemas";

/**
 * zerodot as a tool for AI agents. Each tool calls one REST route through the same route table,
 * so input checks, roles, and results are the same as in the REST API.
 * Destructive tools (delete workflow, delete run, delete rows or tables) are off in v1.
 * An agent cannot create credentials in v1.
 */

type Query = Record<string, string | string[]>;
type Call = { params?: Record<string, string>; query?: Query; body?: unknown };

function routeFor(method: Route["method"], path: string): Route {
  const found = routes.find((r) => r.method === method && r.path === path);
  if (!found) throw new Error(`MCP tool maps to a missing route: ${method} ${path}`);
  return found;
}

/** Calls a route the way the REST router does, without HTTP. */
async function invoke(ctx: ApiContext, method: Route["method"], path: string, call: Call = {}) {
  const route = routeFor(method, path);
  if (route.role === "admin") requireAdmin(ctx);
  const raw: RawInput = {
    params: call.params ?? {},
    query: call.query ?? {},
    body: call.body,
    request: new Request("http://zerodot.invalid/mcp"),
  };
  const result = await route.run(ctx, raw);
  if (result instanceof Reply) return result.body;
  if (result instanceof Response) throw new ApiError(400, "bad_request", "Not a JSON route");
  return result;
}

/** Query strings carry text. Drop the keys with no value. */
function toQuery(values: Record<string, unknown>): Query {
  const out: Query = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    out[key] = Array.isArray(value) ? value.map(String) : String(value);
  }
  return out;
}

type Tool = {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  /** Needs the `admin` role. Other keys do not see the tool. */
  admin: boolean;
  readOnly: boolean;
  call(ctx: ApiContext, args: unknown): Promise<unknown>;
};

function tool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  shape: S;
  admin?: boolean;
  readOnly?: boolean;
  call(ctx: ApiContext, args: z.output<z.ZodObject<S>>): Promise<unknown>;
}): Tool {
  const schema = z.object(def.shape);
  return {
    name: def.name,
    description: def.description,
    shape: def.shape,
    admin: def.admin ?? false,
    readOnly: def.readOnly ?? false,
    call: (ctx, args) => def.call(ctx, schema.parse(args)),
  };
}

const idShape = { id: z.uuid().describe("Workflow id") };
const waitShape = {
  wait: z
    .boolean()
    .default(false)
    .describe(
      "Hold until the run ends, up to the server timeout. Then the output is in the answer.",
    ),
};
const tableShape = { table: z.string().min(1).describe("Table id or name") };

export const tools: Tool[] = [
  tool({
    name: "list_workflows",
    description: "List workflows of the project, newest first. Use `cursor` for the next page.",
    shape: s.pageQuery.shape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/workflows", { query: toQuery(args) }),
  }),
  tool({
    name: "get_workflow",
    description: "Get a workflow with its draft graph and its trigger URLs.",
    shape: idShape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/workflows/:id", { params: { id: args.id } }),
  }),
  tool({
    name: "create_workflow",
    description:
      "Create a workflow. Send a `graph` to set the draft. The graph is checked against " +
      "the node types (use list_node_types and get_node_type to build a valid one).",
    shape: s.workflowCreate.shape,
    call: (ctx, args) => invoke(ctx, "POST", "/workflows", { body: args }),
  }),
  tool({
    name: "update_workflow_draft",
    description:
      "Replace the draft graph of a workflow. The graph is checked against the node types.",
    shape: { ...idShape, graph: s.workflowCreate.shape.graph.unwrap() },
    call: (ctx, args) =>
      invoke(ctx, "PATCH", "/workflows/:id", {
        params: { id: args.id },
        body: { graph: args.graph },
      }),
  }),
  tool({
    name: "publish_workflow",
    description: "Publish the draft (or a graph you send) as a new immutable version.",
    shape: { ...idShape, graph: s.publishBody.shape.graph },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/workflows/:id/publish", {
        params: { id: args.id },
        body: { graph: args.graph },
      }),
  }),
  tool({
    name: "set_workflow_active",
    description: "Turn the triggers of a workflow on or off. It needs a published version.",
    shape: { ...idShape, active: z.boolean() },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/workflows/:id/activate", {
        params: { id: args.id },
        body: { active: args.active },
      }),
  }),
  tool({
    name: "export_workflow",
    description:
      "Get the draft as a .zerodot.json file. It has no variable values and no credential data.",
    shape: idShape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/workflows/:id/export", { params: { id: args.id } }),
  }),
  tool({
    name: "preview_import",
    description:
      "Check a .zerodot.json file or a share link before import_workflow. Nothing changes. " +
      "It lists node types that are not installed and the node packages that give them. " +
      "A single-use link is used by this read: preview its file, or import it at once.",
    shape: s.workflowImportBody.shape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "POST", "/workflows/import/preview", { body: args }),
  }),
  tool({
    name: "import_workflow",
    description:
      "Create a draft workflow from a .zerodot.json `file`, or from a share `url` of any " +
      "zerodot. A protected link needs `password`. A name that is taken gets a number.",
    shape: s.workflowImportBody.shape,
    call: (ctx, args) => invoke(ctx, "POST", "/workflows/import", { body: args }),
  }),
  tool({
    name: "list_workflow_shares",
    description: "List the share links of a workflow, newest first, with when each was used.",
    shape: idShape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/workflows/:id/shares", { params: { id: args.id } }),
  }),
  tool({
    name: "create_workflow_share",
    description:
      "Share a copy of the draft at a new public link. Make one link for each buyer: set " +
      "`label` to the buyer, `password` so only they can import, and `singleUse` so the link " +
      "stops working after one import.",
    shape: { ...idShape, ...s.shareInput.shape },
    call: (ctx, args) => {
      const { id, ...body } = args;
      return invoke(ctx, "POST", "/workflows/:id/shares", { params: { id }, body });
    },
  }),
  tool({
    name: "update_workflow_share",
    description:
      "Change the label, password, or single use of a share link. With `refresh`, the link " +
      "gets a copy of the current draft.",
    shape: { ...s.shareParam.shape, ...s.shareUpdate.shape },
    call: (ctx, args) => {
      const { token, ...body } = args;
      return invoke(ctx, "PATCH", "/shares/:token", { params: { token }, body });
    },
  }),
  tool({
    name: "run_workflow",
    description:
      "Run the published version of a workflow. With `wait` the answer holds the output of " +
      "the last node. Without it, use get_run to read the result.",
    shape: {
      ...idShape,
      ...waitShape,
      input: z.unknown().optional(),
      nodeId: s.runBody.shape.nodeId,
    },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/workflows/:id/run", {
        params: { id: args.id },
        query: { wait: String(args.wait) },
        body: { input: args.input, nodeId: args.nodeId },
      }),
  }),
  tool({
    name: "test_workflow",
    description:
      "Run the draft (or a graph you send) in test mode. Test runs use real credentials and " +
      "write real data. Read the result with get_run, which shows every node.",
    shape: {
      ...idShape,
      ...waitShape,
      input: z.unknown().optional(),
      graph: s.testBody.shape.graph,
    },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/workflows/:id/test", {
        params: { id: args.id },
        query: { wait: String(args.wait) },
        body: { input: args.input, graph: args.graph },
      }),
  }),
  tool({
    name: "list_runs",
    description: "List runs, newest first. Filter by workflow with `workflowId`.",
    shape: s.runsQuery.shape,
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/runs", { query: toQuery(args) }),
  }),
  tool({
    name: "get_run",
    description: "Get a run with the input, output, and error of each node.",
    shape: { id: z.uuid().describe("Run id") },
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/runs/:id", { params: { id: args.id } }),
  }),
  tool({
    name: "retry_run",
    description:
      "Retry a failed run from the failed node. The new run reuses the saved results of the " +
      "nodes that succeeded. Read the result with get_run.",
    shape: { id: z.uuid().describe("Id of the failed run"), ...waitShape },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/runs/:id/retry", {
        params: { id: args.id },
        query: { wait: String(args.wait) },
      }),
  }),
  tool({
    name: "list_workflow_versions",
    description: "List the published versions of a workflow, newest first.",
    shape: { ...idShape, ...s.pageQuery.shape },
    readOnly: true,
    call: (ctx, args) =>
      invoke(ctx, "GET", "/workflows/:id/versions", {
        params: { id: args.id },
        query: toQuery({ limit: args.limit, cursor: args.cursor }),
      }),
  }),
  tool({
    name: "restore_workflow_version",
    description:
      "Copy a published version into the draft. The published version does not change. " +
      "Use publish_workflow to make the draft live.",
    shape: { ...idShape, version: z.number().int().min(1).describe("Version number") },
    call: (ctx, args) =>
      invoke(ctx, "POST", "/workflows/:id/versions/:version/restore", {
        params: { id: args.id, version: String(args.version) },
      }),
  }),
  tool({
    name: "list_node_types",
    description: "List the node types: label, category, and ports.",
    shape: {},
    readOnly: true,
    async call(ctx) {
      const result = (await invoke(ctx, "GET", "/node-types")) as {
        items: { type: string; label: string; category: string; ports: unknown }[];
      };
      return result.items.map(({ type, label, category, ports }) => ({
        type,
        label,
        category,
        ports,
      }));
    },
  }),
  tool({
    name: "get_node_type",
    description: "Get one node type with the JSON Schema of its config and a default config.",
    shape: { type: z.string().min(1).describe("For example http.request") },
    readOnly: true,
    call: (ctx, args) => invoke(ctx, "GET", "/node-types/:type", { params: { type: args.type } }),
  }),
  tool({
    name: "list_credentials",
    description:
      "List credential names, ids, and types. Values are never returned. Put a credential id " +
      "in `credentialId` of a node.",
    shape: {},
    readOnly: true,
    call: (ctx) => invoke(ctx, "GET", "/credentials"),
  }),
  tool({
    name: "get_insights",
    description:
      "Run statistics of production runs. `view`: summary (KPIs and the change against the " +
      "range before), timeseries, workflows (one row for each workflow), nodes, or errors.",
    shape: {
      view: z.enum(["summary", "timeseries", "workflows", "nodes", "errors"]).default("summary"),
      range: z.enum(["24h", "7d", "30d", "90d"]).default("7d"),
      workflowId: z.array(z.uuid()).optional(),
      triggerType: z.string().min(1).optional(),
      includeTest: z.boolean().default(false),
    },
    readOnly: true,
    call: (ctx, args) =>
      invoke(ctx, "GET", `/insights/${args.view}`, {
        query: toQuery({
          range: args.range,
          workflowId: args.workflowId,
          triggerType: args.triggerType,
          includeTest: args.includeTest,
        }),
      }),
  }),
  tool({
    name: "list_variables",
    description: "List project variables. Workflows read them as $vars.",
    shape: {},
    readOnly: true,
    call: (ctx) => invoke(ctx, "GET", "/variables"),
  }),
  tool({
    name: "set_variable",
    description:
      "Create a variable, or change it when the key exists. Variables are not for secrets.",
    shape: {
      key: z.string().min(1),
      type: s.variablePatch.shape.type,
      value: z.unknown(),
      description: z.string().max(500).default(""),
    },
    admin: true,
    async call(ctx, args) {
      const existing = (await invoke(ctx, "GET", "/variables")) as { items: { key: string }[] };
      if (existing.items.some((v) => v.key === args.key)) {
        return invoke(ctx, "PATCH", "/variables/:key", {
          params: { key: args.key },
          body: { type: args.type, value: args.value, description: args.description },
        });
      }
      return invoke(ctx, "POST", "/variables", { body: args });
    },
  }),
  tool({
    name: "list_tables",
    description: "List data tables with their columns and row counts.",
    shape: {},
    readOnly: true,
    call: (ctx) => invoke(ctx, "GET", "/tables"),
  }),
  tool({
    name: "query_rows",
    description:
      "Find rows of a data table. A filter is a condition `{ field, op, value }` " +
      "(ops: eq, neq, gt, gte, lt, lte, in, contains, isNull) or `{ and: [...] }` / `{ or: [...] }`.",
    shape: { ...tableShape, ...s.rowsQueryBody.shape },
    readOnly: true,
    call: (ctx, { table, ...query }) =>
      invoke(ctx, "POST", "/tables/:id/rows/query", { params: { id: table }, body: query }),
  }),
  tool({
    name: "insert_rows",
    description: "Insert rows into a data table. Each row is checked against the column schema.",
    shape: { ...tableShape, ...s.rowsInsert.shape },
    call: (ctx, { table, rows }) =>
      invoke(ctx, "POST", "/tables/:id/rows", { params: { id: table }, body: { rows } }),
  }),
  tool({
    name: "update_rows",
    description:
      "Update the rows that match a filter. Without a filter, send `all: true`. " +
      "`set` replaces values. `increment` adds to number columns.",
    shape: { ...tableShape, ...s.rowsUpdate.shape },
    call: (ctx, { table, ...update }) =>
      invoke(ctx, "PATCH", "/tables/:id/rows", { params: { id: table }, body: update }),
  }),
];

const text = (value: unknown) => JSON.stringify(value, null, 2);

function log(ctx: ApiContext, name: string, startedAt: number, ok: boolean, code?: string) {
  console.log(
    JSON.stringify({
      level: "info",
      msg: "mcp.call",
      apiKey: { id: ctx.principal.apiKeyId },
      organization: { id: ctx.principal.organizationId },
      mcp: { tool: name },
      ok,
      error: code,
      durationMs: Date.now() - startedAt,
    }),
  );
}

/** One MCP server for one request. The server keeps no session. */
export function createMcpServer(ctx: ApiContext): McpServer {
  const server = new McpServer({ name: "zerodot", version: "1" });
  for (const def of tools) {
    if (def.admin && ctx.principal.role !== "admin") continue;
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.shape,
        annotations: { readOnlyHint: def.readOnly, destructiveHint: false },
      },
      async (args) => {
        const startedAt = Date.now();
        try {
          const result = await def.call(ctx, args);
          log(ctx, def.name, startedAt, true);
          return { content: [{ type: "text" as const, text: text(result) }] };
        } catch (error) {
          const { body } = toErrorBody(error);
          log(ctx, def.name, startedAt, false, body.error.code);
          return {
            isError: true,
            content: [{ type: "text" as const, text: text(body.error) }],
          };
        }
      },
    );
  }

  server.registerResource(
    "workflow-graph",
    new ResourceTemplate("zerodot://workflows/{id}/graph", {
      list: async () => {
        const page = await ctx.scope.workflows.list({ limit: 100 });
        return {
          resources: page.items.map((w) => ({
            uri: `zerodot://workflows/${w.id}/graph`,
            name: w.name,
            mimeType: "application/json",
          })),
        };
      },
    }),
    { description: "The draft graph of a workflow", mimeType: "application/json" },
    async (uri, variables) => {
      const id = [variables.id].flat()[0] ?? "";
      const wf = await ctx.scope.workflows.get(id);
      if (!wf) throw notFound("Workflow");
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: text(wf.draftGraph) }],
      };
    },
  );

  server.registerResource(
    "run-result",
    new ResourceTemplate("zerodot://runs/{id}", {
      list: async () => {
        const page = await ctx.scope.runs.list({ limit: 50 });
        return {
          resources: page.items.map((r) => ({
            uri: `zerodot://runs/${r.id}`,
            name: `${r.workflowName} (${r.status})`,
            mimeType: "application/json",
          })),
        };
      },
    }),
    { description: "A run with the result of each node", mimeType: "application/json" },
    async (uri, variables) => {
      const id = [variables.id].flat()[0] ?? "";
      const result = await invoke(ctx, "GET", "/runs/:id", { params: { id } });
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: text(result) }] };
    },
  );
  return server;
}

/** `POST /mcp`: Streamable HTTP, JSON answers, no session. Same API keys as the REST API. */
export async function handleMcp(services: ApiServices, request: Request): Promise<Response> {
  let ctx: ApiContext;
  try {
    const principal = await authenticate(services, request);
    await enforceRateLimit(services, principal);
    ctx = createContext(services, principal);
  } catch (error) {
    const headers: Record<string, string> = {};
    if (error instanceof ApiError && error.status === 401) {
      headers["www-authenticate"] = 'Bearer realm="zerodot"';
    }
    if (error instanceof ApiError && error.status === 429) headers["retry-after"] = "60";
    return errorResponse(error, headers);
  }
  const server = createMcpServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // The answer is complete in JSON mode, so the server can close.
    void server.close();
  }
}
