// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, type ResolvedCredential, resolveTemplate } from "@zerodot/engine";
import { z } from "zod";
import { credentialHeader } from "./credential-header";
import { ipAllowed, isBot, jwtValid, sameSecret } from "./webhook-checks";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

/** A field with `option: true` shows under "Options" in the editor, after the user adds it. */
const option = (title: string) => ({ option: true, title });

const webhookConfig = z.object({
  httpMethod: z
    .enum(METHODS)
    .default("POST")
    .meta({
      title: "HTTP Method",
      hints: {
        GET: "Read data",
        POST: "Send data or create something",
        PUT: "Replace something",
        PATCH: "Change part of something",
        DELETE: "Remove something",
        HEAD: "Get the headers only",
      },
    }),
  // The path of the URL. Empty: the URL uses a generated token.
  path: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/, "Use letters, digits, - and _ (up to 100)")
    .optional()
    .meta({ title: "Path" }),
  authentication: z
    .enum(["none", "basic", "header", "jwt"])
    .default("none")
    .meta({
      title: "Authentication",
      labels: { none: "None", basic: "Basic Auth", header: "Header Auth", jwt: "JWT Auth" },
      hints: {
        none: "Anyone with the URL can call it",
        basic: "A user name and a password",
        header: "A secret value in a request header",
        jwt: "A signed JWT token",
      },
    }),
  // lastNode and respondNode hold the HTTP request until the run answers.
  responseMode: z
    .enum(["immediate", "lastNode", "respondNode"])
    .default("immediate")
    .meta({
      title: "Respond",
      labels: {
        immediate: "Immediately",
        lastNode: "When Last Node Finishes",
        respondNode: "Using 'Respond to Webhook' Node",
      },
      hints: {
        immediate: "Answer at once. The workflow runs after",
        lastNode: "Answer with the output of the last node",
        respondNode: "Answer from a Respond to Webhook node",
      },
    }),
  allowedOrigins: z
    .string()
    .optional()
    .meta({
      ...option("Allowed Origins (CORS)"),
      description: "Comma separated. * allows all. https://*.example.com allows subdomains.",
    }),
  ignoreBots: z.boolean().optional().meta(option("Ignore Bots")),
  ipAllowlist: z
    .string()
    .optional()
    .meta({ ...option("IP(s) Allowlist"), description: "Comma separated. Ranges: 10.0.0.0/8" }),
  noResponseBody: z.boolean().optional().meta(option("No Response Body")),
  onlyRunIf: z
    .string()
    .optional()
    .meta({
      ...option("Only Run If"),
      description: "An expression. The run starts when it is true.",
    }),
  rawBody: z.boolean().optional().meta(option("Raw Body")),
  binaryProperty: z
    .string()
    .min(1)
    .optional()
    .meta({
      ...option("Binary Property"),
      description: "Save the body as a file under this name in the binary data.",
      showWhen: { httpMethod: ["POST", "PATCH", "PUT"] },
    }),
  responseCode: z
    .number()
    .int()
    .min(100)
    .max(599)
    .optional()
    .meta({ ...option("Response Code"), showWhen: { responseMode: ["immediate", "lastNode"] } }),
  responseData: z
    .string()
    .optional()
    .meta({ ...option("Response Data"), showWhen: { responseMode: ["immediate"] } }),
  responseHeaders: z
    .record(z.string(), z.string())
    .optional()
    .meta({ ...option("Response Headers") }),
});

/** The header that the caller must send, or null when the credential does not fit the method. */
function expectedHeader(
  method: "basic" | "header",
  credential: ResolvedCredential | null,
): [string, string] | null {
  const fits =
    credential &&
    ((method === "basic" && credential.type === "http.basic") ||
      (method === "header" && credential.type === "http.header"));
  if (!fits) return null;
  try {
    return credentialHeader(credential);
  } catch {
    return null;
  }
}

export type WebhookTriggerConfig = z.output<typeof webhookConfig>;

export default defineNode({
  type: "trigger.webhook",
  label: "Webhook",
  description: "Start the workflow when an HTTP request arrives",
  category: "trigger",
  icon: "WebhookIcon",
  config: webhookConfig,
  defaultConfig: { httpMethod: "POST", authentication: "none", responseMode: "immediate" },
  credentialTypes: ["http.basic", "http.header", "jwt.auth"],
  credentialRules: {
    "http.basic": { showWhen: { authentication: ["basic"] } },
    "http.header": { showWhen: { authentication: ["header"] } },
    "jwt.auth": { showWhen: { authentication: ["jwt"] } },
  },
  ports: { in: [], out: ["out"] },
  // The text of these keys is not an expression for the node. The route reads them as they are.
  rawConfigKeys: ["onlyRunIf", "responseData"],
  subtitle: (c) => (typeof c.httpMethod === "string" ? c.httpMethod : undefined),
  // The input holds { method, headers, query, body }.
  run: ({ input }) => ({ port: "out", data: input }),
  webhook: {
    // The checks of the route: authentication, caller address, bots, and the "only run if" rule.
    async receive({ config: raw, credential, request }) {
      const c = webhookConfig.parse(raw);
      if (c.authentication === "jwt") {
        const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? "")?.[1];
        const key = credential?.type === "jwt.auth" ? credential.data : null;
        const algorithm = typeof key?.algorithm === "string" ? key.algorithm : "";
        // No credential: fail closed.
        if (
          !bearer ||
          !key ||
          !jwtValid(bearer, {
            algorithm,
            secret: typeof key.secret === "string" ? key.secret : undefined,
            publicKey: typeof key.publicKey === "string" ? key.publicKey : undefined,
          })
        ) {
          return { verdict: "forbidden", status: 403 };
        }
      } else if (c.authentication !== "none") {
        const expected = expectedHeader(c.authentication, credential);
        // No credential: fail closed.
        if (!expected) return { verdict: "forbidden", status: 403 };
        const given = request.headers[expected[0].toLowerCase()];
        if (given === undefined || !sameSecret(given, expected[1])) {
          return {
            verdict: "forbidden",
            status: c.authentication === "basic" ? 401 : 403,
            headers:
              c.authentication === "basic"
                ? { "www-authenticate": 'Basic realm="Webhook"' }
                : undefined,
          };
        }
      }
      if (c.ipAllowlist && !ipAllowed(request.ip, c.ipAllowlist)) {
        return { verdict: "forbidden", status: 403 };
      }
      if (c.ignoreBots && isBot(request.headers["user-agent"])) {
        return { verdict: "ignore" };
      }
      const saveFile =
        c.binaryProperty !== undefined &&
        ["POST", "PATCH", "PUT"].includes(request.method) &&
        request.bodyBase64 !== undefined &&
        request.bodyBase64 !== "";
      const mimeType = request.headers["content-type"]?.split(";")[0]?.trim();
      const input = {
        method: request.method,
        headers: request.headers,
        query: request.query,
        body: saveFile ? {} : c.rawBody ? (request.rawBody ?? "") : request.body,
        ...(saveFile && c.binaryProperty
          ? {
              binary: {
                [c.binaryProperty]: {
                  data: request.bodyBase64 ?? "",
                  mimeType: mimeType || "application/octet-stream",
                },
              },
            }
          : {}),
      };
      if (c.onlyRunIf !== undefined && c.onlyRunIf.trim() !== "") {
        let result: unknown;
        try {
          result = resolveTemplate(c.onlyRunIf, {
            $trigger: input,
            $input: input,
            $node: {},
            $vars: {},
            $run: {},
          });
        } catch (error) {
          return {
            verdict: "ignore",
            response: {
              status: 400,
              body: {
                error: {
                  code: "bad_request",
                  message: `"Only Run If" failed: ${error instanceof Error ? error.message : String(error)}`,
                },
              },
            },
          };
        }
        const off = result === false || result === null || result === undefined || result === 0;
        if (off || (typeof result === "string" && ["", "false", "0"].includes(result.trim()))) {
          return { verdict: "ignore" };
        }
      }
      return { verdict: "accept", input };
    },
  },
});
