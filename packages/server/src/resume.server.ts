// SPDX-License-Identifier: AGPL-3.0-only
import { findRunOrganization, forOrganization } from "@zerodot/db";
import { graphSchema, verifyResumeSignature } from "@zerodot/engine";
import {
  messagePage,
  parseWaitForm,
  registry,
  renderWaitForm,
  waitCallbackData,
} from "@zerodot/nodes";
import { enqueueResume } from "@zerodot/queue";
import { getServices } from "./services.server";
import { parseBody, readBody } from "./webhook.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The link has a signature, so keep it out of referrers and keep the page free of scripts.
const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
};

const page = (text: string, status: number) =>
  new Response(messagePage(text), { status, headers: HEADERS });

/**
 * A person answers a node that waits. GET shows the form, or takes `?approved=true|false`.
 * POST takes the form. The signature in the link says that the node asked for this answer.
 * A node that waits for a callback takes any method. The call is the node output, and the
 * answer is JSON.
 */
export async function handleResume(
  request: Request,
  runId: string,
  nodeId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const { db, secretKey, queue, config } = await getServices();
  if (
    !UUID.test(runId) ||
    !verifyResumeSignature(secretKey, runId, nodeId, url.searchParams.get("sig") ?? "")
  ) {
    return page("This link is not valid.", 403);
  }
  const organizationId = await findRunOrganization(db, runId);
  if (!organizationId) return page("This link is not valid.", 404);
  const scope = forOrganization(db, organizationId, { secretKey });

  const waiting = await scope.runs.waitingNode(runId, nodeId);
  if (!waiting) return page("This request was answered, or it has expired.", 410);

  const record = await scope.runs.get(runId);
  const version = record?.versionId ? await scope.workflows.getVersion(record.versionId) : null;
  const graph = graphSchema.safeParse(version?.graph ?? record?.graphSnapshot);
  const node = graph.success ? graph.data.nodes.find((n) => n.id === nodeId) : undefined;
  const definition = node ? registry.get(node.type) : undefined;
  if (!node || !definition) return page("This request is not known.", 404);
  const form = definition.waitForm?.(node.config) ?? null;
  const callback = definition.waitsForCallback?.(node.config) === true;

  let answer: unknown;
  if (callback) {
    const text = await readBody(request, config.ZERODOT_MAX_WEBHOOK_BODY_BYTES);
    if (text === "too-large") return Response.json({ error: "Body is too large" }, { status: 413 });
    answer = waitCallbackData({
      method: request.method,
      headers: request.headers,
      url,
      body: parseBody(text, request.headers.get("content-type") ?? ""),
    });
  } else if (form) {
    if (request.method !== "POST") {
      return new Response(renderWaitForm(form), { headers: HEADERS });
    }
    const parsed = parseWaitForm(form, await request.formData());
    if (!parsed.ok) return page(parsed.error, 400);
    answer = parsed.answers;
  } else {
    const approved = url.searchParams.get("approved");
    if (approved !== "true" && approved !== "false") return page("This link is not valid.", 400);
    answer = { approved: approved === "true" };
  }

  if (!(await scope.runs.answerWait(runId, nodeId, callback ? answer : { data: answer }))) {
    if (callback) {
      return Response.json({ error: "This run does not wait for a call now" }, { status: 410 });
    }
    return page("This request was answered, or it has expired.", 410);
  }
  await enqueueResume(queue, { runId, organizationId, delayMs: 0 });
  if (callback) return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  return page("Thank you. Your answer is saved.", 200);
}
