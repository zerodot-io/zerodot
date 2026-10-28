// SPDX-License-Identifier: AGPL-3.0-only
import { forOrganization, webhookToken } from "@zerodot/db";
import { registry } from "@zerodot/nodes";
import { getServices } from "./services.server";
import { holdForAnswer, parseBody, readBody } from "./webhook.server";

/** A person listens for one test event for this long. */
export const LISTEN_SECONDS = 120;

const PATH = /^[A-Za-z0-9_-]{1,100}$/;

const listenKey = (token: string) => `testhook:listen:${token}`;
const eventKey = (token: string) => `testhook:event:${token}`;
/** The editor says which test run answers the request that the URL got. */
const runKey = (token: string) => `testhook:run:${token}`;

/**
 * The last part of the URL of a trigger node: its path, or the token of the published trigger, or
 * the token that a publish will give it. So the test URL is the production URL with `hooks-test`.
 */
export async function tokenOf(
  existing: { token?: string } | undefined,
  workflowId: string,
  nodeId: string,
  path?: string,
): Promise<string> {
  if (path && PATH.test(path)) return path;
  if (existing?.token) return existing.token;
  const { secretKey } = await getServices();
  return webhookToken(secretKey, workflowId, nodeId);
}

/** The address that the service gets when the workflow is active. */
export async function productionWebhookUrl(token: string): Promise<string> {
  const { config } = await getServices();
  return `${config.ZERODOT_BASE_URL}/hooks/${token}`;
}

export async function testWebhookUrl(token: string): Promise<string> {
  const { config } = await getServices();
  return `${config.ZERODOT_BASE_URL}/hooks-test/${token}`;
}

/** A trigger with `webhookTest` checks the test requests like the production ones. */
export type ListenCheck = { type: string; config: Record<string, unknown> };

/** The listen key holds the method that the Webhook node expects and its response mode. */
export async function startListening(
  token: string,
  method: string,
  mode: string,
  check?: ListenCheck,
) {
  const { redis } = await getServices();
  await redis.del(eventKey(token), runKey(token));
  await redis.set(listenKey(token), JSON.stringify({ method, mode, check }), "EX", LISTEN_SECONDS);
}

/** The editor started a test run for the event. The held request waits for its answer. */
export async function linkRun(token: string, runId: string, organizationId: string) {
  const { redis } = await getServices();
  await redis.set(runKey(token), JSON.stringify({ runId, organizationId }), "EX", 600);
}

export async function stopListening(token: string) {
  const { redis } = await getServices();
  await redis.del(listenKey(token), eventKey(token));
}

/** The event that the test URL got, or null. A read removes it. */
export async function takeEvent(token: string): Promise<unknown | null> {
  const { redis } = await getServices();
  const text = await redis.getdel(eventKey(token));
  return text === null ? null : JSON.parse(text);
}

const json = (body: unknown, status: number) => Response.json(body, { status });

/** Test webhook: any method on /hooks-test/:token. It takes one request while the editor listens. */
export async function handleTestWebhook(request: Request, token: string): Promise<Response> {
  const { redis, config, db, secretKey } = await getServices();
  const listening = await redis.get(listenKey(token));
  const { method, mode, check } = listening
    ? (JSON.parse(listening) as { method: string; mode: string; check?: ListenCheck })
    : { method: null, mode: "immediate", check: undefined };
  if (method !== null && method !== request.method) {
    return json(
      { error: { code: "method_not_allowed", message: `This webhook takes ${method}` } },
      405,
    );
  }
  const text = await readBody(request, config.ZERODOT_MAX_WEBHOOK_BODY_BYTES);
  if (text === "too-large") {
    return json({ error: { code: "payload_too_large", message: "Body is too large" } }, 413);
  }
  const url = new URL(request.url);
  const event = {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    query: Object.fromEntries(url.searchParams),
    body: parseBody(text, request.headers.get("content-type") ?? ""),
  };
  // A trigger of an app checks its own requests (for example a secret). A forged request does not
  // use up the listen.
  const definition = check ? registry.get(check.type) : undefined;
  if (check && definition?.webhook && definition.webhookTest) {
    const verdict = await definition.webhook.receive({
      config: definition.config.parse(check.config) as Record<string, unknown>,
      credential: null,
      url: `${config.ZERODOT_BASE_URL}/hooks-test/${token}`,
      workflow: { id: "", name: "" },
      node: { id: "", name: "" },
      state: undefined,
      signal: AbortSignal.timeout(30_000),
      request: { ...event, rawBody: text },
    });
    if (verdict.verdict === "forbidden") {
      return json({ error: { code: "forbidden", message: "The request is not valid" } }, 403);
    }
    if (verdict.verdict === "ignore") return json({ ignored: true }, 200);
  }
  // One request only. The delete tells the first request from a second one.
  // An unknown token gets the same answer, so the URL does not tell which tokens exist.
  if (method === null || (await redis.del(listenKey(token))) === 0) {
    return json(
      {
        error: {
          code: "not_listening",
          message: "Click Listen for test event in the editor, then send the request again",
        },
      },
      404,
    );
  }
  await redis.set(eventKey(token), JSON.stringify(event), "EX", 60);

  // Like the production URL, a response mode holds the request until the test run answers.
  if (mode === "lastNode" || mode === "respondNode") {
    const deadline = Date.now() + config.ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS;
    for (;;) {
      const linked = await redis.get(runKey(token));
      if (linked) {
        const { runId, organizationId } = JSON.parse(linked) as {
          runId: string;
          organizationId: string;
        };
        const held = await holdForAnswer({
          mode,
          runId,
          scope: forOrganization(db, organizationId, { secretKey }),
          timeoutMs: Math.max(0, deadline - Date.now()),
          extra: {},
        });
        if (held) return held;
        break;
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return json({ ok: true }, 200);
}
