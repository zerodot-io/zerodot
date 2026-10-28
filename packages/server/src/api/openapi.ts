// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { Route } from "./route";

type JsonSchema = Record<string, unknown>;
type Components = Record<string, JsonSchema>;

/**
 * JSON Schema of a Zod schema. Recursive schemas put their parts in `$defs`.
 * OpenAPI keeps them under `components.schemas`, so each part moves there under a unique name.
 */
function toSchema(schema: z.ZodType, prefix: string, components: Components): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io: "input",
    unrepresentable: "any",
    cycles: "ref",
  }) as JsonSchema & { $defs?: Record<string, JsonSchema> };
  const { $defs, $schema: _schema, ...root } = json;
  const rename = (value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll('"#/$defs/', `"#/components/schemas/${prefix}_`));
  for (const [name, def] of Object.entries($defs ?? {})) {
    components[`${prefix}_${name}`] = rename(def) as JsonSchema;
  }
  return rename(root) as JsonSchema;
}

function parametersOf(
  schema: z.ZodType | undefined,
  location: "path" | "query",
  prefix: string,
  components: Components,
) {
  if (!schema) return [];
  const json = toSchema(schema, prefix, components) as {
    properties?: Record<string, JsonSchema>;
    required?: string[];
  };
  return Object.entries(json.properties ?? {}).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || (json.required ?? []).includes(name),
    schema: property,
  }));
}

const operationId = (route: Route) =>
  `${route.method.toLowerCase()}${route.path
    .split("/")
    .filter(Boolean)
    .map((p) => (p.startsWith(":") ? `By${p.slice(1)[0]?.toUpperCase()}${p.slice(2)}` : p))
    .map((p) => `${p[0]?.toUpperCase()}${p.slice(1)}`)
    .join("")}`;

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

/** The OpenAPI 3.1 document. It comes from the route table, so it cannot drift from the code. */
export function buildOpenApi(routes: Route[], baseUrl: string): JsonSchema {
  const components: Components = {
    Error: {
      type: "object",
      required: ["error"],
      properties: {
        error: {
          type: "object",
          required: ["code", "message"],
          properties: {
            code: { type: "string" },
            message: { type: "string" },
            details: {},
          },
        },
      },
    },
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [index, route] of routes.entries()) {
    const prefix = `r${index}`;
    const openApiPath = route.path.replace(/:(\w+)/g, "{$1}");
    const parameters = [
      ...parametersOf(route.schemas.params, "path", `${prefix}p`, components),
      ...parametersOf(route.schemas.query, "query", `${prefix}q`, components),
    ];
    const success = route.stream
      ? { description: "Server-sent events", content: { "text/event-stream": {} } }
      : {
          description: "Success",
          content: {
            "application/json": {
              schema: toSchema(route.schemas.response, `${prefix}s`, components),
            },
          },
        };
    const responses: Record<string, unknown> = {
      [String(route.status)]: success,
      400: errorResponse("The request is not valid"),
      401: errorResponse("Missing, wrong, or expired API key"),
      404: errorResponse("Not found"),
      429: errorResponse("Rate limit"),
    };
    for (const status of route.alsoStatus) responses[String(status)] = success;
    if (route.role === "admin") responses[403] = errorResponse("The key needs the admin role");
    paths[openApiPath] = {
      ...paths[openApiPath],
      [route.method.toLowerCase()]: {
        operationId: operationId(route),
        summary: route.summary,
        description: route.description,
        tags: [route.tag],
        security: [{ bearer: [] }],
        parameters,
        requestBody: route.schemas.body
          ? {
              required: true,
              content: {
                "application/json": {
                  schema: toSchema(route.schemas.body, `${prefix}b`, components),
                },
              },
            }
          : undefined,
        responses,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "zerodot API",
      version: "1",
      description:
        "Send an API key in `Authorization: Bearer <key>`. A key belongs to one project. " +
        "Errors use `{ error: { code, message, details } }`. List routes use `limit` and `cursor`.",
    },
    servers: [{ url: `${baseUrl}/api/v1` }],
    security: [{ bearer: [] }],
    paths,
    components: {
      schemas: components,
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    },
  };
}
