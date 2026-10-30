// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { credentialHeader } from "./credential-header";

export default defineNode({
  type: "http.request",
  label: "HTTP Request",
  description: "Call any HTTP API and get the response",
  category: "core",
  icon: "Globe02Icon",
  config: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).meta({
      title: "Method",
      hints: {
        GET: "Read data",
        POST: "Send data or create something",
        PUT: "Replace something",
        PATCH: "Change part of something",
        DELETE: "Remove something",
      },
    }),
    url: z.url(),
    sendQuery: z.boolean().default(false).meta({ title: "Send Query Parameters" }),
    // An expression can return a number or a boolean (a chat id, for example). Make it a string.
    query: z
      .record(z.string(), z.coerce.string())
      .optional()
      .meta({ title: "Query Parameters", showWhen: { sendQuery: [true] } }),
    sendHeaders: z.boolean().default(false).meta({ title: "Send Headers" }),
    headers: z
      .record(z.string(), z.coerce.string())
      .optional()
      .meta({ showWhen: { sendHeaders: [true] } }),
    sendBody: z.boolean().default(false).meta({ title: "Send Body" }),
    body: z
      .unknown()
      .optional()
      .meta({ ui: "fields", showWhen: { sendBody: [true] } }),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
    fullResponse: z.boolean().default(false).meta({
      description: "Return status, headers, and body. Error statuses do not fail the node.",
    }),
  }),
  defaultConfig: {
    method: "GET",
    url: "https://",
    sendQuery: false,
    sendHeaders: false,
    sendBody: false,
    timeoutMs: 30_000,
    fullResponse: false,
  },
  credentialTypes: ["http.basic", "http.bearer", "http.header", "oauth2.generic"],
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.url === "string" && config.url !== "https://"
      ? `${String(config.method ?? "GET")}: ${config.url}`
      : undefined,
  // The body is the output. A full response keeps error statuses as data.
  async run({ config, credential, signal }) {
    const headers = new Headers(config.sendHeaders ? config.headers : undefined);
    // A header from the config wins over the credential.
    if (credential) {
      const [name, value] = credentialHeader(credential);
      if (!headers.has(name)) headers.set(name, value);
    }
    let body: string | undefined;
    if (config.sendBody && config.body !== undefined && config.method !== "GET") {
      if (typeof config.body === "string") {
        body = config.body;
      } else {
        body = JSON.stringify(config.body);
        if (!headers.has("content-type")) headers.set("content-type", "application/json");
      }
    }
    const url = new URL(config.url);
    if (config.sendQuery) {
      for (const [name, value] of Object.entries(config.query ?? {}))
        url.searchParams.append(name, value);
    }
    const response = await fetch(url, {
      method: config.method,
      headers,
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    const text = await response.text();
    const isJson = (response.headers.get("content-type") ?? "").includes("json");
    let parsed: unknown = text;
    if (isJson && text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (config.fullResponse) {
      return {
        port: "out",
        data: {
          status: response.status,
          ok: response.ok,
          headers: Object.fromEntries(response.headers),
          body: parsed,
        },
      };
    }
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}: ${text.slice(0, 200)}`);
    }
    return { port: "out", data: parsed };
  },
});
