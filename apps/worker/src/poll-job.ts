// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { type Db, forOrganization } from "@zerodot/db";
import {
  type GraphNode,
  graphSchema,
  type NodeRegistry,
  POLL_MAX_ITEMS,
  type PollItem,
  type ResolvedCredential,
} from "@zerodot/engine";
import { openCredential } from "@zerodot/nodes";
import type { PollJob } from "@zerodot/queue";
import { log } from "./log";

/** How many item keys a trigger remembers. Older items are not checked again. */
const SEEN_KEYS_KEPT = 500;
const LOCK_TTL_MS = 5 * 60_000;

export type PollState = { cursor: unknown; seenKeys: string[]; configHash: string | null };

export type PollOutcome = {
  /** Items that start a run. Empty on a first poll. */
  fresh: PollItem[];
  next: { cursor: unknown; seenKeys: string[]; configHash: string };
};

type PollFn = (ctx: {
  cursor: unknown;
  firstPoll: boolean;
}) => Promise<{ items: PollItem[]; cursor: unknown }>;

/**
 * One poll, without storage. A first poll (no state, or a changed config) only records where
 * the trigger is. Later polls return the items whose key was not seen before.
 */
export async function evaluatePoll(
  previous: PollState | null,
  configHash: string,
  poll: PollFn,
): Promise<PollOutcome> {
  const firstPoll = !previous || previous.configHash !== configHash;
  const result = await poll({ cursor: firstPoll ? null : previous.cursor, firstPoll });
  if (!Array.isArray(result?.items)) throw new Error("The poll did not return a list of items");
  if (result.items.length > POLL_MAX_ITEMS) {
    throw new Error(
      `The poll returned ${result.items.length} items. The limit is ${POLL_MAX_ITEMS}`,
    );
  }
  const keys = new Set<string>();
  const items: PollItem[] = [];
  for (const item of result.items) {
    if (typeof item?.key !== "string" || item.key === "") {
      throw new Error("A poll item needs a key that is text");
    }
    if (keys.has(item.key)) continue;
    keys.add(item.key);
    items.push(item);
  }
  const seen = firstPoll ? [] : (previous?.seenKeys ?? []);
  const known = new Set(seen);
  const fresh = firstPoll ? [] : items.filter((item) => !known.has(item.key));
  const seenKeys = [
    ...seen,
    ...items.filter((i) => firstPoll || !known.has(i.key)).map((i) => i.key),
  ];
  return {
    fresh,
    next: { cursor: result.cursor ?? null, seenKeys: seenKeys.slice(-SEEN_KEYS_KEPT), configHash },
  };
}

const hashOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);

/** The run key of an item. A long key is shortened, so the key stays a fixed size. */
export const pollRunKey = (triggerId: string, itemKey: string) =>
  `poll:${triggerId}:${itemKey.length > 120 ? hashOf(itemKey) : itemKey}`;

export type PollDeps = {
  db: Db;
  registry: NodeRegistry;
  secretKey: Buffer;
  enqueueRun: (input: { runId: string; organizationId: string }) => Promise<void>;
  /** Takes a lock for `key`. Returns a function that gives it back, or null when it is taken. */
  tryLock: (key: string, ttlMs: number) => Promise<(() => Promise<void>) | null>;
  signal: AbortSignal;
};

/**
 * A poller fired. Ask the trigger node for news and start one production run for each new item.
 * A poll that fails keeps the old cursor, so the next tick asks again.
 */
export async function handlePollJob(deps: PollDeps, data: PollJob): Promise<void> {
  const scope = forOrganization(deps.db, data.organizationId, { secretKey: deps.secretKey });
  const trigger = await scope.workflows.pollTrigger(data.triggerId);
  if (!trigger?.active || !trigger.publishedVersionId) {
    log("warn", "poll.skipped", { trigger: { id: data.triggerId }, reason: "not active" });
    return;
  }
  // A poll that takes longer than the interval must not overlap with the next one.
  const release = await deps.tryLock(`zerodot:poll-lock:${data.triggerId}`, LOCK_TTL_MS);
  if (!release) {
    log("warn", "poll.skipped", { trigger: { id: data.triggerId }, reason: "still running" });
    return;
  }
  try {
    const version = await scope.workflows.getVersion(trigger.publishedVersionId);
    const node: GraphNode | undefined = version
      ? graphSchema.parse(version.graph).nodes.find((n) => n.id === data.nodeId)
      : undefined;
    const definition = node ? deps.registry.get(node.type) : undefined;
    if (!node || !definition?.poll) {
      await scope.workflows.savePollState(data.triggerId, {
        error: "The trigger node is gone, or its node type cannot poll",
      });
      return;
    }
    try {
      const { intervalSeconds: _interval, ...fields } = node.config as Record<string, unknown>;
      const parsed = definition.config.safeParse(node.config);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid config");
      const credential: ResolvedCredential | null = node.credentialId
        ? await openCredential(scope.credentials, node.credentialId)
        : null;
      const previous = await scope.workflows.pollState(data.triggerId);
      const outcome = await evaluatePoll(
        previous,
        hashOf({ fields, credentialId: node.credentialId ?? null }),
        (state) =>
          definition.poll?.({
            config: parsed.data,
            credential,
            cursor: state.cursor,
            firstPoll: state.firstPoll,
            workflow: { id: trigger.workflowId, name: trigger.workflowName },
            node: { id: node.id, name: node.name },
            signal: deps.signal,
          }) as ReturnType<PollFn>,
      );
      // Runs first, state last. A crash in between polls again, and the run keys stop duplicates.
      for (const item of outcome.fresh) {
        const { run, created } = await scope.runs.create({
          workflowId: trigger.workflowId,
          mode: "production",
          versionId: trigger.publishedVersionId,
          triggerType: "poll",
          triggerNodeId: data.nodeId,
          triggerInput: item.data,
          idempotencyKey: pollRunKey(data.triggerId, item.key),
        });
        if (created) await deps.enqueueRun({ runId: run.id, organizationId: data.organizationId });
      }
      await scope.workflows.savePollState(data.triggerId, outcome.next);
      if (outcome.fresh.length > 0) {
        log("info", "poll.items", { trigger: { id: data.triggerId }, count: outcome.fresh.length });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "poll.failed", { trigger: { id: data.triggerId }, error: message });
      await scope.workflows.savePollState(data.triggerId, { error: message });
    }
  } finally {
    await release();
  }
}
