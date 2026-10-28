// SPDX-License-Identifier: AGPL-3.0-only
import { projectStreamKey, runStreamKey } from "@zerodot/queue";
import { getServices } from "./services.server";
import { projectFor } from "./session.server";
import { streamEvents } from "./stream.server";

export async function runEventsResponse(request: Request, projectSlug: string, runId: string) {
  const ctx = await projectFor(request.headers, projectSlug);
  if (!ctx) return new Response("Not found", { status: 404 });
  const { forOrganization } = await import("@zerodot/db");
  const run = await forOrganization(ctx.db, ctx.project.organizationId).runs.get(runId);
  if (!run) return new Response("Not found", { status: 404 });
  const { readerConnection } = await getServices();
  return streamEvents(request, runStreamKey(runId), true, readerConnection);
}

export async function projectEventsResponse(request: Request, projectSlug: string) {
  const ctx = await projectFor(request.headers, projectSlug);
  if (!ctx) return new Response("Not found", { status: 404 });
  const { readerConnection } = await getServices();
  return streamEvents(
    request,
    projectStreamKey(ctx.project.organizationId),
    false,
    readerConnection,
  );
}
