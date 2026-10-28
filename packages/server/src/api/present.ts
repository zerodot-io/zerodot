// SPDX-License-Identifier: AGPL-3.0-only
import type {
  RunListItem,
  RunNodeResultRow,
  RunRow,
  WorkflowRow,
  WorkflowVersionRow,
} from "@zerodot/db";
import type { Column } from "@zerodot/engine";
import type { z } from "zod";
import type {
  columnOut,
  credentialSummary,
  nodeResult,
  rowOut,
  runDetail,
  runSummary,
  tableOut,
  variableOut,
  versionSummary,
  workflowSummary,
} from "./schemas";

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);

export function presentWorkflow(w: WorkflowRow): z.input<typeof workflowSummary> {
  return {
    id: w.id,
    name: w.name,
    active: w.active,
    published: w.publishedVersionId !== null,
    publishedVersionId: w.publishedVersionId,
    minutesSavedPerRun: w.minutesSavedPerRun,
    description: w.description,
    tags: w.tags,
    createdAt: iso(w.createdAt),
    updatedAt: iso(w.updatedAt),
  };
}

export function presentVersion(v: WorkflowVersionRow): z.input<typeof versionSummary> {
  return {
    id: v.id,
    workflowId: v.workflowId,
    version: v.version,
    createdBy: v.createdBy,
    createdAt: iso(v.createdAt),
  };
}

export function presentRun(r: RunListItem): z.input<typeof runSummary> {
  return {
    id: r.id,
    workflowId: r.workflowId,
    workflowName: r.workflowName,
    mode: r.mode,
    status: r.status,
    triggerType: r.triggerType,
    createdAt: iso(r.createdAt),
    startedAt: isoOrNull(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
  };
}

export function presentResult(
  r: RunNodeResultRow,
  names: ReadonlyMap<string, string>,
): z.input<typeof nodeResult> {
  return {
    nodeId: r.nodeId,
    nodeName: names.get(r.nodeId) ?? null,
    attempt: r.attempt,
    status: r.status,
    port: r.port,
    input: r.input,
    output: r.output,
    error: r.error,
    startedAt: isoOrNull(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
  };
}

export function presentRunDetail(
  run: RunRow,
  workflowName: string,
  results: RunNodeResultRow[],
  names: ReadonlyMap<string, string>,
): z.input<typeof runDetail> {
  return {
    ...presentRun({ ...run, workflowName }),
    triggerInput: run.triggerInput,
    error: run.error,
    results: results.map((r) => presentResult(r, names)),
  };
}

export function presentCredential(c: {
  id: string;
  name: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
}): z.input<typeof credentialSummary> {
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    createdAt: iso(c.createdAt),
    updatedAt: iso(c.updatedAt),
  };
}

export function presentVariable(v: {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  value: unknown;
  description: string;
  updatedAt: Date;
}): z.input<typeof variableOut> {
  return {
    key: v.key,
    type: v.type,
    value: v.value,
    description: v.description,
    updatedAt: iso(v.updatedAt),
  };
}

export function presentTable(t: {
  id: string;
  name: string;
  description: string;
  columns: Column[];
  rowCount: number;
}): z.input<typeof tableOut> {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    columns: t.columns as z.input<typeof columnOut>[],
    rowCount: t.rowCount,
  };
}

export const presentRow = (row: {
  id: string;
  createdAt: string;
  updatedAt: string;
  [column: string]: unknown;
}): z.input<typeof rowOut> => row;
