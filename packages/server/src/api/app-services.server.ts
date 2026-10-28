// SPDX-License-Identifier: AGPL-3.0-only
import { resolveMembership } from "@zerodot/db";
import { enqueueRun, publishWorkflowEvent } from "@zerodot/queue";
import { syncWorkflowSchedules } from "../schedules.server";
import { getServices } from "../services.server";
import { isAdmin } from "../session.server";
import type { ApiServices } from "./context.server";

/** The web app sends the project slug with a session, because a session names no project. */
export const PROJECT_HEADER = "x-zerodot-project";

let cached: Promise<ApiServices> | undefined;

async function build(): Promise<ApiServices> {
  const app = await getServices();
  return {
    db: app.db,
    secretKey: app.secretKey,
    tableMaxRows: app.config.ZERODOT_TABLE_MAX_ROWS,
    baseUrl: app.config.ZERODOT_BASE_URL,
    syncTimeoutMs: app.config.ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS,
    heldLimiter: app.heldLimiter,
    rateLimitPerMinute: app.config.ZERODOT_API_RATE_LIMIT_PER_MINUTE,
    enqueue: (input) => enqueueRun(app.queue, input),
    async hit(key) {
      const windowKey = `rl:api:${key}:${Math.floor(Date.now() / 60_000)}`;
      const hits = await app.redis.incr(windowKey);
      if (hits === 1) await app.redis.expire(windowKey, 120);
      return hits;
    },
    async session(request) {
      const slug = request.headers.get(PROJECT_HEADER);
      if (!slug) return null;
      const session = await app.auth.api.getSession({ headers: request.headers });
      if (!session) return null;
      const project = await resolveMembership(app.db, session.user.id, slug);
      if (!project) return null;
      return {
        organizationId: project.organizationId,
        role: isAdmin(project.role) ? "admin" : "member",
        userId: session.user.id,
        apiKeyId: null,
      };
    },
    syncSchedules: syncWorkflowSchedules,
    draftChanged: (organizationId, workflowId) =>
      publishWorkflowEvent(app.redis, organizationId, { type: "workflow.draft", workflowId }),
    reader: app.readerConnection,
  };
}

/** The services for the public API, built once from the app services. */
export function getApiServices(): Promise<ApiServices> {
  cached ??= build();
  return cached;
}
