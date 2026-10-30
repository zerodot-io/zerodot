// SPDX-License-Identifier: AGPL-3.0-only
import type { Redis } from "ioredis";

/** Events go to a Valkey stream. The stream entry id is the SSE id. */
export type RunEvent =
  | { type: "run.started"; runId: string }
  | { type: "node.started"; runId: string; nodeId: string; attempt: number }
  | {
      type: "node.succeeded";
      runId: string;
      nodeId: string;
      attempt: number;
      port: string | null;
      output: unknown;
      pinned: boolean;
    }
  | {
      type: "node.failed";
      runId: string;
      nodeId: string;
      attempt: number;
      error: { message: string; path?: string };
    }
  | { type: "node.skipped"; runId: string; nodeId: string }
  /** A supply node or a tool is in use by the node it supplies. It is no step and has no row. */
  | {
      type: "supply.used";
      runId: string;
      nodeId: string;
      status: "running" | "succeeded" | "failed";
    }
  | { type: "node.waiting"; runId: string; nodeId: string; attempt: number; resumeAt: number }
  | { type: "run.waiting"; runId: string; resumeAt: number }
  | {
      type: "run.finished";
      runId: string;
      status: "succeeded" | "failed" | "cancelled";
      error: { message: string; nodeId?: string } | null;
    };

/** The draft of a workflow changed through the API. The editor loads the new draft. */
export type WorkflowEvent = { type: "workflow.draft"; workflowId: string };

export type StreamEvent = { id: string; event: RunEvent | WorkflowEvent };

const STREAM_MAXLEN = 1000;
const STREAM_TTL_AFTER_END_SECONDS = 3600;

export const runStreamKey = (runId: string) => `run:${runId}:events`;
export const projectStreamKey = (organizationId: string) => `project:${organizationId}:runs`;

async function append(redis: Redis, key: string, event: RunEvent) {
  await redis.xadd(key, "MAXLEN", "~", STREAM_MAXLEN, "*", "event", JSON.stringify(event));
}

/** Publish to the run stream. A finished run also goes to the project stream. */
export async function publishRunEvent(redis: Redis, organizationId: string, event: RunEvent) {
  const key = runStreamKey(event.runId);
  await append(redis, key, event);
  if (
    event.type === "run.started" ||
    event.type === "run.waiting" ||
    event.type === "run.finished"
  ) {
    await append(redis, projectStreamKey(organizationId), event);
  }
  if (event.type === "run.finished") await redis.expire(key, STREAM_TTL_AFTER_END_SECONDS);
}

/** Publish to the project stream. */
export async function publishWorkflowEvent(
  redis: Redis,
  organizationId: string,
  event: WorkflowEvent,
) {
  await redis.xadd(
    projectStreamKey(organizationId),
    "MAXLEN",
    "~",
    STREAM_MAXLEN,
    "*",
    "event",
    JSON.stringify(event),
  );
}

function parseEntries(raw: unknown): StreamEvent[] {
  // XREAD reply: [[key, [[id, [field, value, ...]], ...]]]
  const out: StreamEvent[] = [];
  if (!Array.isArray(raw)) return out;
  for (const stream of raw as [string, [string, string[]][]][]) {
    for (const [id, fields] of stream[1]) {
      const index = fields.indexOf("event");
      const value = index >= 0 ? fields[index + 1] : undefined;
      if (value) out.push({ id, event: JSON.parse(value) as RunEvent | WorkflowEvent });
    }
  }
  return out;
}

/**
 * Read entries after `lastId`. Waits up to `blockMs`. Use a dedicated connection per reader,
 * because XREAD BLOCK holds the connection.
 */
export async function readStream(
  redis: Redis,
  key: string,
  lastId: string,
  blockMs: number,
): Promise<StreamEvent[]> {
  const raw = await redis.xread("COUNT", 100, "BLOCK", blockMs, "STREAMS", key, lastId);
  return parseEntries(raw);
}
