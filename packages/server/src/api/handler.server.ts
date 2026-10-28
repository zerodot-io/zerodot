// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ApiServices,
  authenticate,
  createContext,
  enforceRateLimit,
  requireAdmin,
} from "./context.server";
import { ApiError, badRequest, errorResponse, toErrorBody } from "./errors";
import { buildOpenApi } from "./openapi";
import { type Method, Reply, type Route } from "./route";
import { routes } from "./routes.server";

const BASE_PATH = "/api/v1";
const MAX_BODY_BYTES = 5 * 1024 * 1024;
const METHODS = new Set<string>(["GET", "POST", "PATCH", "DELETE"]);

type Compiled = { route: Route; pattern: RegExp; names: string[] };

function compile(route: Route): Compiled {
  const names: string[] = [];
  const source = route.path.replace(/:(\w+)/g, (_match, name: string) => {
    names.push(name);
    return "([^/]+)";
  });
  return { route, pattern: new RegExp(`^${source}$`), names };
}

const compiled = routes.map(compile);

function match(method: string, path: string) {
  let pathMatched = false;
  for (const entry of compiled) {
    const found = entry.pattern.exec(path);
    if (!found) continue;
    pathMatched = true;
    if (entry.route.method !== method) continue;
    const params = Object.fromEntries(
      entry.names.map((name, i) => [name, decodeURIComponent(found[i + 1] ?? "")]),
    );
    return { route: entry.route, params };
  }
  return { route: null, pathMatched };
}

function queryOf(url: URL): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    out[key] = all.length > 1 ? all : (all[0] ?? "");
  }
  return out;
}

async function readJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "Body is too large");
  const text = await request.text();
  if (text.length === 0) return undefined;
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Body is too large");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("The body is not valid JSON");
  }
}

function finish(result: unknown, route: Route): Response {
  if (result instanceof Response) return result;
  if (result instanceof Reply) return Response.json(result.body, { status: result.status });
  return Response.json(result, { status: route.status });
}

/** `/api/v1/*`. The caller passes the services, so tests can use fakes. */
export async function handleApi(services: ApiServices, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.startsWith(BASE_PATH)
    ? url.pathname.slice(BASE_PATH.length).replace(/\/+$/, "") || "/"
    : url.pathname;
  try {
    if (request.method === "GET" && path === "/openapi.json") {
      return Response.json(buildOpenApi(routes, services.baseUrl));
    }
    if (!METHODS.has(request.method)) throw new ApiError(405, "method_not_allowed", "Not allowed");
    const found = match(request.method as Method, path);
    if (!found.route) {
      if (found.pathMatched) throw new ApiError(405, "method_not_allowed", "Method not allowed");
      throw new ApiError(404, "not_found", "Unknown route");
    }
    const principal = await authenticate(services, request);
    await enforceRateLimit(services, principal);
    const ctx = createContext(services, principal);
    if (found.route.role === "admin") requireAdmin(ctx);
    const body = found.route.schemas.body ? await readJson(request) : undefined;
    const result = await found.route.run(ctx, {
      params: found.params,
      query: queryOf(url),
      body,
      request,
    });
    return finish(result, found.route);
  } catch (error) {
    const headers: Record<string, string> = {};
    if (error instanceof ApiError && error.status === 429) headers["retry-after"] = "60";
    if (error instanceof ApiError && error.status === 405) headers.allow = [...METHODS].join(", ");
    if (toErrorBody(error).status === 500) {
      console.error(JSON.stringify({ msg: "api.unhandled", error: String(error) }));
    }
    return errorResponse(error, headers);
  }
}
