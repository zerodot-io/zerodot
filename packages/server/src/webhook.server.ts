// SPDX-License-Identifier: AGPL-3.0-only
import { findWebhookTrigger, forOrganization } from "@zerodot/db";
import type { WebhookVerdict } from "@zerodot/engine";
import { graphSchema } from "@zerodot/engine";
import { originAllowed, registry } from "@zerodot/nodes";
import { enqueueRun, runResponseKey } from "@zerodot/queue";
import { HELD_RETRY_AFTER_SECONDS } from "./held-limit";
import { getServices } from "./services.server";
import { createTriggerCache, type TriggerCache } from "./trigger-cache";

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

export async function readBody(request: Request, limit: number): Promise<string | "too-large"> {
  const bytes = await readBodyBytes(request, limit);
  return bytes === "too-large" ? bytes : bytes.toString("utf8");
}

async function readBodyBytes(request: Request, limit: number): Promise<Buffer | "too-large"> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > limit) return "too-large";
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function parseBody(text: string, contentType: string): unknown {
  if (text.length === 0) return null;
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (contentType.includes("x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  return text;
}

/** The worker wakes a waiter when a run has news. This poll only covers a lost wake. */
const FALLBACK_POLL_MS = 1_000;

type Trigger = NonNullable<Awaited<ReturnType<typeof findWebhookTrigger>>>;

/**
 * Cache of the trigger lookup for each token. It ends by time (ZERODOT_WEBHOOK_CACHE_MS, default
 * 5 seconds, 2 seconds for an unknown token). A workflow that someone deactivates or unpublishes
 * can still get calls for that time in each API process. Set it to 0 to turn the cache off.
 */
let triggerCache: TriggerCache<Trigger> | undefined;
function lookupTrigger(db: Parameters<typeof findWebhookTrigger>[0], ttlMs: number, token: string) {
  triggerCache ??= createTriggerCache<Trigger>({
    ttlMs,
    missTtlMs: Math.min(ttlMs, 2_000),
    maxEntries: 5_000,
  });
  return triggerCache.get(token, () => findWebhookTrigger(db, token));
}

type RunResponse = { status: number; headers: Record<string, string>; body: unknown };

/**
 * Response headers that a workflow cannot set. A hook answers on the origin of the app, so a cookie
 * or a CORS or security header from a workflow could act on the sessions of the app.
 */
const BLOCKED_HEADER =
  /^(set-cookie2?|access-control-.*|content-security-policy(-report-only)?|x-content-type-options|x-frame-options|connection|keep-alive|transfer-encoding|content-length|upgrade|trailer|proxy-.*)$/i;

/** The response headers that a workflow gives, without the blocked ones. */
export function workflowHeaders(given: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!given || typeof given !== "object") return headers;
  for (const [name, value] of Object.entries(given)) {
    if (typeof value === "string" && !BLOCKED_HEADER.test(name)) headers[name] = value;
  }
  return headers;
}

/**
 * A hook answers with content that a workflow controls, on the origin of the app. The sandbox
 * gives a page an opaque origin and no scripts, so it cannot use the session of the person who
 * opens it.
 */
export function sandboxed(response: Response): Response {
  response.headers.set("content-security-policy", "sandbox");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

/** The options of a Webhook node. The route reads them from the trigger row. */
function webhookOptions(config: Record<string, unknown>, nodeType: string) {
  if (nodeType !== "trigger.webhook") {
    return { method: "POST", mode: "immediate", headers: {} as Record<string, string> };
  }
  const headers = workflowHeaders(config.responseHeaders);
  return {
    method: typeof config.httpMethod === "string" ? config.httpMethod : "POST",
    mode: typeof config.responseMode === "string" ? config.responseMode : "immediate",
    code: typeof config.responseCode === "number" ? config.responseCode : undefined,
    data: typeof config.responseData === "string" ? config.responseData : undefined,
    none: config.noResponseBody === true,
    origins: typeof config.allowedOrigins === "string" ? config.allowedOrigins : undefined,
    headers,
  };
}

/** CORS headers for a request. An empty object when the node allows no origin. */
function corsHeaders(origins: string | undefined, request: Request): Record<string, string> {
  if (!origins) return {};
  const allowed = originAllowed(request.headers.get("origin"), origins);
  if (allowed === "*") return { "access-control-allow-origin": "*" };
  if (allowed) return { "access-control-allow-origin": allowed, vary: "origin" };
  return {};
}

/** A response with a JSON body, a text body, or no body. */
function bodyResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  const hasType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
  if (body === null || body === undefined) return new Response(null, { status, headers });
  if (typeof body === "string") {
    return new Response(body, {
      status,
      headers: hasType ? headers : { "content-type": "text/plain; charset=utf-8", ...headers },
    });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: hasType ? headers : { "content-type": "application/json", ...headers },
  });
}

/** The address of the caller. Only when the server runs behind a proxy that we trust. */
function callerIp(request: Request, trustProxy: boolean): string | null {
  if (!trustProxy) return null;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || null;
}

type Scope = ReturnType<typeof forOrganization>;

/**
 * Holds a request until the run answers it. `lastNode` answers with the output of the last node
 * when the run ends. `respondNode` answers with what a Respond to Webhook node says.
 * Returns null when the time is up. The caller then answers `202`.
 */
export async function holdForAnswer(input: {
  mode: "lastNode" | "respondNode";
  runId: string;
  scope: Scope;
  timeoutMs: number;
  extra: Record<string, string>;
  code?: number;
  none?: boolean;
  /** Stops the wait when the client closes the connection. The result is then null. */
  signal?: AbortSignal;
}): Promise<Response | null> {
  const { redis, runWaiter } = await getServices();
  const { mode, runId, scope, extra } = input;
  const deadline = Date.now() + input.timeoutMs;
  const saved = async () => {
    const text = await redis.get(runResponseKey(runId));
    if (!text) return null;
    const answer = JSON.parse(text) as RunResponse;
    return bodyResponse(answer.status, answer.body, {
      ...extra,
      ...workflowHeaders(answer.headers),
    });
  };
  for (;;) {
    if (input.signal?.aborted) return null;
    // Arm before the reads, so a wake that comes during them is not lost.
    const wake = runWaiter.arm(runId, input.signal);
    try {
      if (mode === "respondNode") {
        const answer = await saved();
        if (answer) return answer;
      }
      const latest = await scope.runs.get(runId);
      if (latest && ["succeeded", "failed", "cancelled"].includes(latest.status)) {
        if (latest.status !== "succeeded") {
          return bodyResponse(
            500,
            {
              error: {
                code: "run_failed",
                message: (latest.error as { message?: string } | null)?.message ?? "The run failed",
                runId,
              },
            },
            extra,
          );
        }
        if (mode === "respondNode") {
          // The node can write its answer just before the run ends.
          const answer = await saved();
          if (answer) return answer;
          return bodyResponse(
            500,
            {
              error: {
                code: "no_response",
                message: "The workflow ended without a Respond to Webhook node",
                runId,
              },
            },
            extra,
          );
        }
        const results = await scope.runs.results(runId);
        const last = results
          .filter((r) => r.status === "succeeded" && r.finishedAt)
          .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))[0];
        return input.none
          ? new Response(null, { status: input.code ?? 200, headers: extra })
          : bodyResponse(input.code ?? 200, last?.output ?? null, extra);
      }
      if (Date.now() >= deadline) return null;
      await wake.wait(Math.min(FALLBACK_POLL_MS, deadline - Date.now()));
    } finally {
      wake.disarm();
    }
  }
}

/**
 * Production webhook: `/hooks/:token`, with the method of the Webhook node (default POST).
 * The token is the path of the node, or a generated token. Runs the published version.
 */
export async function handleWebhook(request: Request, token: string): Promise<Response> {
  return sandboxed(await answerWebhook(request, token));
}

async function answerWebhook(request: Request, token: string): Promise<Response> {
  const { db, redis, queue, config, secretKey, heldLimiter } = await getServices();

  // Fixed window rate limit per token. 0 turns it off.
  const limit = config.ZERODOT_WEBHOOK_RATE_LIMIT_PER_MINUTE;
  const windowKey = `rl:hook:${token}:${Math.floor(Date.now() / 60_000)}`;
  if (limit > 0) {
    const hits = await redis.incr(windowKey);
    if (hits === 1) await redis.expire(windowKey, 120);
    if (hits > limit) {
      return json({ error: { code: "rate_limited", message: "Too many requests" } }, 429, {
        "retry-after": "60",
      });
    }
  }

  const trigger = await lookupTrigger(db, config.ZERODOT_WEBHOOK_CACHE_MS, token);
  if (!trigger?.active || !trigger.publishedVersionId) {
    return json({ error: { code: "not_found", message: "Unknown webhook" } }, 404);
  }

  const options = webhookOptions(trigger.config as Record<string, unknown>, trigger.nodeType);
  const cors = corsHeaders(options.origins, request);
  const reply = (body: unknown, status: number, headers: Record<string, string> = {}) =>
    json(body, status, { ...cors, ...headers });

  // A browser asks with OPTIONS before a cross-origin request.
  if (request.method === "OPTIONS") {
    if (!options.origins)
      return reply({ error: { code: "not_found", message: "Unknown webhook" } }, 404);
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "access-control-allow-methods": options.method,
        "access-control-allow-headers":
          request.headers.get("access-control-request-headers") ?? "content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (request.method !== options.method) {
    return reply(
      { error: { code: "method_not_allowed", message: `This webhook takes ${options.method}` } },
      405,
      { allow: options.method },
    );
  }

  const bytes = await readBodyBytes(request, config.ZERODOT_MAX_WEBHOOK_BODY_BYTES);
  if (bytes === "too-large") {
    return reply({ error: { code: "payload_too_large", message: "Body is too large" } }, 413);
  }
  const text = bytes.toString("utf8");

  const url = new URL(request.url);
  const triggerInput = {
    method: request.method,
    headers: Object.fromEntries(request.headers),
    query: Object.fromEntries(url.searchParams),
    body: parseBody(text, request.headers.get("content-type") ?? ""),
  };

  const scope = forOrganization(db, trigger.organizationId, { secretKey });
  let runInput: unknown = triggerInput;

  // A trigger node with its own webhook code checks the request: the Webhook node (authentication,
  // caller address, bots, "only run if"), or a trigger of an app (for example its secret).
  const definition = registry.get(trigger.nodeType);
  if (definition?.webhook) {
    const version = await scope.workflows.getVersion(trigger.publishedVersionId);
    const graph = graphSchema.safeParse(version?.graph);
    const node = graph.success ? graph.data.nodes.find((n) => n.id === trigger.nodeId) : undefined;
    if (!node) return reply({ error: { code: "not_found", message: "Unknown webhook" } }, 404);
    let verdict: WebhookVerdict;
    try {
      verdict = await definition.webhook.receive({
        config: definition.config.parse(trigger.config) as Record<string, unknown>,
        credential: node.credentialId ? await scope.credentials.open(node.credentialId) : null,
        url: `${config.ZERODOT_BASE_URL}/hooks/${token}`,
        workflow: { id: trigger.workflowId, name: "" },
        node: { id: node.id, name: node.name },
        state: (trigger.config as { nodeState?: unknown }).nodeState,
        signal: AbortSignal.timeout(30_000),
        request: {
          method: triggerInput.method,
          headers: triggerInput.headers,
          query: triggerInput.query,
          body: triggerInput.body,
          rawBody: text,
          bodyBase64: bytes.toString("base64"),
          ip: callerIp(request, config.ZERODOT_TRUST_PROXY),
        },
      });
    } catch (error) {
      console.error(JSON.stringify({ msg: "webhook.receive_failed", error: String(error) }));
      return reply(
        { error: { code: "bad_request", message: "The webhook could not read this request" } },
        400,
      );
    }
    if (verdict.verdict === "forbidden") {
      return reply(
        { error: { code: "forbidden", message: "The request is not valid" } },
        verdict.status ?? 403,
        workflowHeaders(verdict.headers),
      );
    }
    if (verdict.verdict === "ignore") {
      return verdict.response
        ? reply(verdict.response.body, verdict.response.status)
        : reply({ ignored: true }, 200);
    }
    runInput = verdict.input;
  }

  // A held request costs memory and database polls. Take a slot before the run exists, so a full
  // process answers 503 and starts no run. The client can try again.
  const holds = options.mode === "lastNode" || options.mode === "respondNode";
  const release = holds ? heldLimiter.acquire() : () => {};
  if (!release) {
    return reply(
      { error: { code: "busy", message: "Too many requests wait for a run. Try again soon." } },
      503,
      { "retry-after": String(HELD_RETRY_AFTER_SECONDS) },
    );
  }
  const live = trigger;
  const versionId = trigger.publishedVersionId;
  try {
    return await startRun();
  } finally {
    release();
  }

  async function startRun(): Promise<Response> {
    const { run, created } = await scope.runs.create({
      workflowId: live.workflowId,
      mode: "production",
      versionId,
      triggerType: "webhook",
      triggerNodeId: live.nodeId,
      triggerInput: runInput,
      idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    });
    if (created) {
      try {
        await enqueueRun(queue, {
          runId: run.id,
          organizationId: live.organizationId,
          mode: "production",
        });
      } catch (error) {
        await scope.runs.finish(run.id, {
          status: "failed",
          error: { message: "Could not queue the run" },
        });
        console.error(JSON.stringify({ msg: "webhook.enqueue_failed", error: String(error) }));
        return reply({ error: { code: "unavailable", message: "Could not queue the run" } }, 503);
      }
    }

    const extra = { ...cors, ...options.headers };
    const accepted = () => bodyResponse(202, { runId: run.id }, extra);

    if (options.mode === "lastNode" || options.mode === "respondNode") {
      const held = await holdForAnswer({
        mode: options.mode,
        runId: run.id,
        scope,
        timeoutMs: config.ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS,
        extra,
        code: options.code,
        none: options.none,
        signal: request.signal,
      });
      return held ?? accepted();
    }

    // The default answer: the run is queued.
    const status = options.code ?? 202;
    if (options.none) return new Response(null, { status, headers: extra });
    if (options.data !== undefined) {
      let parsed: unknown = options.data;
      try {
        parsed = JSON.parse(options.data);
      } catch {
        // The text is not JSON. Send it as text.
      }
      return bodyResponse(status, parsed, extra);
    }
    return bodyResponse(status, { runId: run.id }, extra);
  }
}
