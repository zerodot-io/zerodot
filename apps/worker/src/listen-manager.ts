// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import {
  type Db,
  forOrganization,
  type ListenTriggerRow,
  listActiveListenTriggers,
} from "@zerodot/db";
import {
  type GraphNode,
  graphSchema,
  type ListenHandle,
  type NodeRegistry,
  type ResolvedCredential,
} from "@zerodot/engine";
import { openCredential } from "@zerodot/nodes";
import { log } from "./log";

/** How often the manager compares the running listeners with the active triggers. */
export const LISTEN_TICK_MS = 10_000;
/** A lock that is not renewed in this time goes to another worker. */
export const LISTEN_LOCK_TTL_MS = 30_000;
/** A trigger that failed to start waits this long before the next try. */
const RETRY_MS = 60_000;

export type ListenLock = {
  /** False when the lock was lost. */
  renew(): Promise<boolean>;
  release(): Promise<void>;
};

export type ListenDeps = {
  db: Db;
  registry: NodeRegistry;
  secretKey: Buffer;
  enqueueRun: (input: { runId: string; organizationId: string }) => Promise<void>;
  /** Takes a lock for `key`. Returns null when another worker has it. */
  acquire: (key: string, ttlMs: number) => Promise<ListenLock | null>;
  signal: AbortSignal;
  /** Most triggers this worker keeps open. Default 100. */
  maxTriggers?: number;
  /** Random source for the order of lock tries. A test can fix it. */
  random?: () => number;
};

/** The default cap of open listen triggers for one worker. */
export const DEFAULT_MAX_LISTEN_TRIGGERS = 100;

type Running = { versionId: string; nodeType: string; handle: ListenHandle; lock: ListenLock };

/** What to do so the running listeners match the active triggers. */
export function planListeners(
  running: ReadonlyMap<string, string>,
  wanted: Pick<ListenTriggerRow, "triggerId" | "versionId">[],
): { stop: string[]; start: string[] } {
  const wantedVersion = new Map(wanted.map((t) => [t.triggerId, t.versionId]));
  const stop = [...running].filter(([id, v]) => wantedVersion.get(id) !== v).map(([id]) => id);
  const kept = new Set([...running.keys()].filter((id) => !stop.includes(id)));
  const start = wanted.filter((t) => !kept.has(t.triggerId)).map((t) => t.triggerId);
  return { stop, start };
}

/** A random order (Fisher-Yates). Workers then try the triggers in different orders and share them. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const lockKey = (triggerId: string) => `zerodot:listen-lock:${triggerId}`;

/** The run key of an event. A long key is shortened, so the key stays a fixed size. */
export const listenRunKey = (triggerId: string, itemKey: string) =>
  `listen:${triggerId}:${
    itemKey.length > 120 ? createHash("sha256").update(itemKey).digest("hex").slice(0, 32) : itemKey
  }`;

/**
 * Keeps one open connection for each active listen trigger. A lock in Valkey makes sure that one
 * worker only listens for one trigger. Events start production runs, one run for each event.
 */
export function createListenManager(deps: ListenDeps) {
  const running = new Map<string, Running>();
  const retryAt = new Map<string, number>();
  let busy = false;

  async function stop(triggerId: string, remove: boolean) {
    const entry = running.get(triggerId);
    if (!entry) return;
    running.delete(triggerId);
    try {
      await entry.handle.close({ remove });
    } catch (error) {
      log("error", "listen.close_failed", { trigger: { id: triggerId }, error: String(error) });
    }
    await entry.lock.release().catch(() => {});
  }

  async function start(row: ListenTriggerRow) {
    const lock = await deps.acquire(lockKey(row.triggerId), LISTEN_LOCK_TTL_MS);
    if (!lock) return;
    const scope = forOrganization(deps.db, row.organizationId, { secretKey: deps.secretKey });
    try {
      const trigger = await scope.workflows.pollTriggerOfType(row.triggerId, "listen");
      const version = await scope.workflows.getVersion(row.versionId);
      const node: GraphNode | undefined = version
        ? graphSchema.parse(version.graph).nodes.find((n) => n.id === row.nodeId)
        : undefined;
      const definition = node ? deps.registry.get(node.type) : undefined;
      if (!trigger || !node || !definition?.listen) {
        throw new Error("The trigger node is gone, or its node type cannot listen");
      }
      const parsed = definition.config.safeParse(node.config);
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Invalid config");
      const credential: ResolvedCredential | null = node.credentialId
        ? await openCredential(scope.credentials, node.credentialId)
        : null;
      const handle = await definition.listen({
        config: parsed.data,
        credential,
        workflow: { id: trigger.workflowId, name: trigger.workflowName },
        node: { id: node.id, name: node.name },
        signal: deps.signal,
        async emit(item) {
          const { run, created } = await scope.runs.create({
            workflowId: trigger.workflowId,
            mode: "production",
            versionId: row.versionId,
            triggerType: "listen",
            triggerNodeId: row.nodeId,
            triggerInput: item.data,
            idempotencyKey: listenRunKey(row.triggerId, item.key),
          });
          if (created) {
            await deps.enqueueRun({ runId: run.id, organizationId: row.organizationId });
          }
        },
        fail(error) {
          log("error", "listen.failed", { trigger: { id: row.triggerId }, error: error.message });
          void scope.workflows
            .savePollState(row.triggerId, { error: error.message })
            .catch(() => {});
        },
      });
      running.set(row.triggerId, { versionId: row.versionId, nodeType: node.type, handle, lock });
      retryAt.delete(row.triggerId);
      await scope.workflows.savePollState(row.triggerId, {
        cursor: null,
        seenKeys: [],
        configHash: row.versionId,
      });
      log("info", "listen.started", { trigger: { id: row.triggerId } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("error", "listen.start_failed", { trigger: { id: row.triggerId }, error: message });
      retryAt.set(row.triggerId, Date.now() + RETRY_MS);
      await scope.workflows.savePollState(row.triggerId, { error: message }).catch(() => {});
      await lock.release().catch(() => {});
    }
  }

  return {
    /** One pass: stop what is gone or changed, keep the locks, start what is new. */
    async reconcile() {
      if (busy || deps.signal.aborted) return;
      busy = true;
      try {
        const wanted = await listActiveListenTriggers(deps.db);
        const plan = planListeners(
          new Map([...running].map(([id, r]) => [id, r.versionId])),
          wanted,
        );
        // The workflow is off or changed: the node removes what it made in the other database.
        for (const id of plan.stop) await stop(id, true);
        for (const id of [...running.keys()]) {
          const entry = running.get(id);
          if (entry && !(await entry.lock.renew().catch(() => false))) {
            log("warn", "listen.lock_lost", { trigger: { id } });
            await stop(id, false);
          }
        }
        const max = deps.maxTriggers ?? DEFAULT_MAX_LISTEN_TRIGGERS;
        let warned = false;
        for (const row of shuffled(wanted, deps.random)) {
          if (running.has(row.triggerId)) continue;
          if (running.size >= max) {
            if (!warned) {
              log("warn", "listen.cap_reached", { max, wanted: wanted.length });
              warned = true;
            }
            break;
          }
          if ((retryAt.get(row.triggerId) ?? 0) > Date.now()) continue;
          await start(row);
        }
      } catch (error) {
        log("error", "listen.reconcile_failed", { error: String(error) });
      } finally {
        busy = false;
      }
    },
    /**
     * A node package goes away or changes: close the listeners of its node types. The triggers
     * stay in the other database, and the next pass starts them again with the new code.
     */
    async stopTypes(types: readonly string[]) {
      for (const [id, entry] of [...running]) {
        if (types.includes(entry.nodeType)) await stop(id, false);
      }
    },
    /** The worker stops. The connections close, and the triggers stay in the other database. */
    async closeAll() {
      for (const id of [...running.keys()]) await stop(id, false);
    },
  };
}
