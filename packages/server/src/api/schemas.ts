// SPDX-License-Identifier: AGPL-3.0-only
import {
  COLUMN_TYPES,
  filterSchema,
  graphSchema,
  MAX_INSERT_ROWS,
  rowQuerySchema,
  VARIABLE_TYPES,
  variableInputSchema,
  workflowExportSchema,
} from "@zerodot/engine";
import { z } from "zod";

/** Shapes shared by the REST routes, the OpenAPI document, and the MCP tools. */

export const idParam = z.object({ id: z.uuid() });
/** A data table by id or by name. */
export const tableParams = z.object({ id: z.string().min(1) });

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});

export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const iso = z.string().describe("ISO 8601 time, UTC");

// ---- Workflows ----

export const workflowSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  active: z.boolean(),
  published: z.boolean(),
  publishedVersionId: z.uuid().nullable(),
  minutesSavedPerRun: z.number().nullable(),
  description: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: iso,
  updatedAt: iso,
});

export const triggerInfo = z.object({
  nodeId: z.string(),
  type: z.string(),
  /** Production URL of a webhook trigger. Null for the other types. */
  url: z.string().nullable(),
});

export const workflowDetail = workflowSummary.extend({
  draftGraph: graphSchema,
  triggers: z.array(triggerInfo),
});

export const workflowCreate = z.object({
  name: z.string().trim().min(1).max(120),
  graph: graphSchema.optional(),
});

export const workflowPatch = z
  .object({ name: z.string().trim().min(1).max(120), graph: graphSchema })
  .partial()
  .refine((v) => v.name !== undefined || v.graph !== undefined, "Send a name, a graph, or both");

export const workflowExport = workflowExportSchema;

export const workflowImportBody = z
  .object({
    /** A `.zerodot.json` file. */
    file: z.unknown().optional().describe("A .zerodot.json file. Send this or `url`."),
    url: z
      .url()
      .optional()
      .describe("A share link, or any URL of a .zerodot.json file. Send this or `file`."),
    password: z.string().max(200).optional().describe("The password of a protected share link"),
    /** Replaces the name in the file. */
    name: z.string().trim().min(1).max(120).optional(),
  })
  .refine((v) => (v.file === undefined) !== (v.url === undefined), "Send `file` or `url`");

export const workflowImportResult = z.object({
  id: z.uuid(),
  name: z.string(),
  missingVariables: z.array(z.string()),
  clearedCredentials: z.array(z.string()),
  missingNodeTypes: z
    .array(z.string())
    .describe("Node types that are not installed. Those steps do not run until they are."),
});

export const importPreview = z.object({
  name: z.string().nullable(),
  nodeCount: z.number().int(),
  missingNodeTypes: z.array(z.string()),
  missingVariables: z.array(z.string()),
  clearedCredentials: z.array(z.string()),
  packages: z
    .array(
      z.object({
        name: z.string(),
        label: z.string(),
        version: z.string(),
        compatible: z.boolean(),
        types: z.array(z.string()),
      }),
    )
    .describe("Node packages that give the missing node types. An instance admin installs them."),
  unknownNodeTypes: z.array(z.string()).describe("Missing node types that no package gives"),
  catalogError: z.string().nullable(),
});

export const shareInput = z.object({
  label: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .optional()
    .describe("A name for you, for example the name of the buyer"),
  password: z
    .string()
    .min(8)
    .max(200)
    .nullable()
    .optional()
    .describe("Only people with this password can import. Null removes the password."),
  singleUse: z
    .boolean()
    .optional()
    .describe("The link works for one import. Then it stops working."),
});

export const shareUpdate = shareInput.extend({
  refresh: z.boolean().optional().describe("Put a copy of the current draft in the link"),
});

export const shareParam = z.object({ token: z.string().min(1).max(64) });

export const workflowShare = z.object({
  token: z.string(),
  url: z.string(),
  workflowId: z.uuid(),
  label: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso.describe("When the copy in the link was made"),
  protected: z.boolean(),
  singleUse: z.boolean(),
  usedAt: iso.nullable(),
});

export const versionSummary = z.object({
  id: z.uuid(),
  workflowId: z.uuid(),
  version: z.number().int(),
  createdBy: z.string().nullable(),
  createdAt: iso,
});

export const versionDetail = versionSummary.extend({ graph: graphSchema });

export const versionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });

export const publishBody = z.object({
  /** The graph to publish. The saved draft when you leave it out. */
  graph: graphSchema.optional(),
});

export const publishResult = z.object({ version: z.number().int(), versionId: z.uuid() });

export const activateBody = z.object({ active: z.boolean() });
export const activateResult = z.object({ active: z.boolean() });

// ---- Runs ----

const runStatus = z.enum(["queued", "running", "waiting", "succeeded", "failed", "cancelled"]);

export const runSummary = z.object({
  id: z.uuid(),
  workflowId: z.uuid(),
  workflowName: z.string(),
  mode: z.enum(["production", "test"]),
  status: runStatus,
  triggerType: z.string(),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

export const nodeResult = z.object({
  nodeId: z.string(),
  nodeName: z.string().nullable(),
  attempt: z.number().int(),
  status: z.enum(["running", "waiting", "succeeded", "failed", "skipped"]),
  port: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.unknown(),
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});

export const runDetail = runSummary.extend({
  triggerInput: z.unknown(),
  error: z.unknown(),
  results: z.array(nodeResult),
});

export const runsQuery = pageQuery.extend({ workflowId: z.uuid().optional() });

export const waitQuery = z.object({
  wait: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const runBody = z.object({
  input: z.unknown().optional(),
  /** The trigger node to start from. The first trigger node when you leave it out. */
  nodeId: z.string().min(1).optional(),
});

export const testBody = z.object({
  input: z.unknown().optional(),
  /** The graph to test. The saved draft when you leave it out. */
  graph: graphSchema.optional(),
  /** Run only the path from the trigger to this node, and stop after it. */
  toNodeId: z.string().min(1).optional(),
});

/** `wait=true` answers with the outcome. A run that is still going after the timeout gets 202. */
export const runOutcome = z.object({
  runId: z.uuid(),
  status: runStatus,
  /** Output of the last node that succeeded. Null while the run goes on. */
  output: z.unknown(),
  error: z.unknown(),
});

// ---- Credentials ----

export const credentialSummary = z.object({
  id: z.uuid(),
  name: z.string(),
  type: z.string(),
  createdAt: iso,
  updatedAt: iso,
});

export const credentialCreate = z.object({
  name: z.string().trim().min(1).max(80),
  type: z.string().min(1),
  /** Write only. No response holds these values. */
  fields: z.record(z.string(), z.string()),
});

export const credentialPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** A field left empty keeps its saved value. */
  fields: z.record(z.string(), z.string()).optional(),
});

export const credentialType = z.object({
  type: z.string(),
  label: z.string(),
  secretFields: z.array(z.string()),
  serverFields: z.array(z.string()),
  oauth2: z.boolean(),
  fieldsSchema: z.unknown(),
});

export const deleted = z.object({ deleted: z.boolean() });

// ---- Node types ----

export const nodeType = z.object({
  type: z.string(),
  label: z.string(),
  category: z.string(),
  ports: z.object({ in: z.array(z.string()), out: z.array(z.string()) }),
  defaultConfig: z.unknown(),
  credentialTypes: z.array(z.string()),
  credentialRules: z.record(z.string(), z.unknown()),
  /** JSON Schema of the node config. */
  configSchema: z.unknown(),
});

export const typeParams = z.object({ type: z.string().min(1) });

// ---- API keys ----

export const apiKeyOut = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  role: z.enum(["admin", "member"]),
  expiresAt: iso.nullable(),
  lastUsedAt: iso.nullable(),
  createdAt: iso,
});

export const apiKeyCreate = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(["admin", "member"]).default("member"),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

/** The full key shows once, in the answer to the create call. */
export const apiKeyCreated = apiKeyOut.extend({ key: z.string() });

// ---- Variables ----

export const variableOut = z.object({
  key: z.string(),
  type: z.enum(VARIABLE_TYPES),
  value: z.unknown(),
  description: z.string(),
  updatedAt: iso,
});

export const variableCreate = variableInputSchema;
export const keyParams = z.object({ key: z.string().min(1) });
export const variablePatch = z.object({
  type: z.enum(VARIABLE_TYPES),
  value: z.unknown(),
  description: z.string().max(500).default(""),
});

// ---- Data tables ----

export const columnOut = z.object({
  key: z.string(),
  type: z.enum(COLUMN_TYPES),
  required: z.boolean(),
  unique: z.boolean(),
  default: z.unknown().optional(),
});

export const tableOut = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  columns: z.array(columnOut),
  rowCount: z.number().int(),
});

export const tableCreate = z.object({
  name: z.string(),
  description: z.string().max(500).default(""),
  columns: z.array(z.unknown()),
});

const alterOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), column: z.unknown() }),
  z.object({ op: z.literal("rename"), key: z.string(), to: z.string() }),
  z.object({ op: z.literal("retype"), key: z.string(), type: z.enum(COLUMN_TYPES) }),
  z.object({ op: z.literal("drop"), key: z.string() }),
]);

export const tablePatch = z.object({
  name: z.string().optional(),
  description: z.string().max(500).optional(),
  ops: z.array(alterOp).min(1).max(20).optional(),
});

export const rowOut = z
  .object({ id: z.uuid(), createdAt: iso, updatedAt: iso })
  .catchall(z.unknown());

export const rowsPage = z.object({ rows: z.array(rowOut), nextCursor: z.string().nullable() });
export const rowsQueryBody = rowQuerySchema;
export const rowsListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  cursor: z.string().max(512).optional(),
});
export const rowsInsert = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_INSERT_ROWS),
});
export const rowsInserted = z.object({ count: z.number().int(), rows: z.array(rowOut) });
export const rowParams = z.object({ id: z.string().min(1), rowId: z.uuid() });
export const rowPatch = z.object({ set: z.record(z.string(), z.unknown()) });
export const rowsUpdate = z.object({
  filter: filterSchema.optional(),
  all: z.boolean().optional(),
  set: z.record(z.string(), z.unknown()).optional(),
  increment: z.record(z.string(), z.number()).optional(),
});
export const rowsUpdated = z.object({ count: z.number().int(), rows: z.array(rowOut) });

// ---- Insights ----

const kpis = z.object({
  runs: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  failureRate: z.number().nullable(),
  avgMs: z.number().nullable(),
  p95Ms: z.number().nullable(),
  timeSavedMinutes: z.number().nullable(),
});

export const insightsQuery = z.object({
  range: z.enum(["24h", "7d", "30d", "90d"]).default("7d"),
  workflowId: z
    .union([z.uuid(), z.array(z.uuid())])
    .optional()
    .describe("Repeat the parameter to filter by more than one workflow"),
  triggerType: z.string().min(1).optional(),
  includeTest: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export const insightsSummary = z.object({
  from: iso,
  to: iso,
  current: kpis,
  previous: kpis,
});

export const insightsTimeseries = z.object({
  from: iso,
  to: iso,
  granularity: z.string(),
  points: z.array(kpis.extend({ bucket: iso })),
});

export const insightsWorkflows = z.object({
  workflows: z.array(
    kpis.extend({
      workflowId: z.uuid(),
      workflowName: z.string(),
      lastRunAt: iso.nullable(),
      lastFailureAt: iso.nullable(),
    }),
  ),
});

export const insightsNodes = z.object({
  nodes: z.array(
    z.object({
      workflowId: z.uuid(),
      workflowName: z.string(),
      nodeType: z.string(),
      nodeId: z.string(),
      nodeName: z.string().nullable(),
      runs: z.number(),
      failed: z.number(),
      avgMs: z.number().nullable(),
      p95Ms: z.number().nullable(),
    }),
  ),
});

export const insightsErrors = z.object({
  errors: z.array(
    z.object({
      fingerprint: z.string(),
      sampleMessage: z.string(),
      count: z.number(),
      firstSeenAt: iso,
      lastSeenAt: iso,
      workflowId: z.uuid(),
      workflowName: z.string(),
      lastRunId: z.uuid(),
    }),
  ),
});
