// SPDX-License-Identifier: AGPL-3.0-only
import Fastify, { type FastifyRequest } from "fastify";
import { sendResponse, toRequest } from "./bridge";

type Handler = (request: Request, params: Record<string, string>) => Promise<Response> | Response;

const ALL = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
type Method = (typeof ALL)[number];

/** The handlers read and limit the body themselves. Fastify only passes the stream on. */
const MAX_BODY = 1024 * 1024 * 1024;

export function createApp() {
  const app = Fastify({ bodyLimit: MAX_BODY, exposeHeadRoutes: false, logger: false });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_req, payload, done) => done(null, payload));

  const serve = (methods: readonly Method[], url: string, handler: Handler) =>
    app.route({
      method: [...methods],
      url,
      handler: async (req: FastifyRequest, reply) => {
        const controller = new AbortController();
        // `close` fires when the client leaves, also in the middle of a stream.
        reply.raw.on("close", () => {
          if (!reply.raw.writableFinished) controller.abort();
        });
        const params = req.params as Record<string, string>;
        const response = await handler(toRequest(req, controller.signal), params);
        return sendResponse(reply, response);
      },
    });

  const lazy = async () => {
    const [{ getServices }, { getApiServices }] = await Promise.all([
      import("@zerodot/server/services.server"),
      import("@zerodot/server/api/app-services.server"),
    ]);
    return { getServices, getApiServices };
  };

  app.get("/healthz", () => ({ ok: true, service: "api" }));

  serve(["GET", "POST", "PATCH", "DELETE"], "/api/v1/*", async (request) => {
    const { handleApi } = await import("@zerodot/server/api/handler.server");
    return handleApi(await (await lazy()).getApiServices(), request);
  });
  serve(["GET", "POST", "DELETE"], "/mcp", async (request) => {
    const { handleMcp } = await import("@zerodot/server/api/mcp.server");
    return handleMcp(await (await lazy()).getApiServices(), request);
  });
  serve(["GET", "POST"], "/api/auth/*", async (request) => {
    const { auth } = await (await lazy()).getServices();
    return auth.handler(request);
  });
  /** The Webhook node sets the method. The default is POST. */
  serve(ALL, "/hooks/:token", async (request, { token = "" }) => {
    const { handleWebhook } = await import("@zerodot/server/webhook.server");
    return handleWebhook(request, token);
  });
  serve(ALL, "/hooks-test/:token", async (request, { token = "" }) => {
    const { handleTestWebhook } = await import("@zerodot/server/test-webhook.server");
    return handleTestWebhook(request, token);
  });
  serve(["GET", "POST"], "/resume/:runId/:nodeId", async (request, { runId = "", nodeId = "" }) => {
    const { handleResume } = await import("@zerodot/server/resume.server");
    return handleResume(request, runId, nodeId);
  });
  serve(["GET"], "/oauth2/callback", async (request) => {
    const { handleOAuth2Callback } = await import("@zerodot/server/oauth2.server");
    return handleOAuth2Callback(request);
  });
  serve(["GET"], "/api/p/:slug/events", async (request, { slug = "" }) => {
    const { projectEventsResponse } = await import("@zerodot/server/sse.server");
    return projectEventsResponse(request, slug);
  });
  serve(["GET"], "/api/p/:slug/runs/:runId/events", async (request, { slug = "", runId = "" }) => {
    const { runEventsResponse } = await import("@zerodot/server/sse.server");
    return runEventsResponse(request, slug, runId);
  });

  return app;
}
