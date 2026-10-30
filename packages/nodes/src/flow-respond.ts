// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export default defineNode({
  type: "flow.respond",
  label: "Respond to Webhook",
  description: "Send the HTTP response for a webhook run",
  category: "flow",
  icon: "MailReply01Icon",
  config: z.object({
    respondWith: z
      .enum(["json", "text", "noData"])
      .default("json")
      .meta({
        title: "Respond With",
        labels: { json: "JSON", text: "Text", noData: "No Data" },
        hints: {
          json: "Send the data as JSON",
          text: "Send plain text",
          noData: "Send an empty body",
        },
      }),
    // Empty: the input of this node.
    body: z
      .unknown()
      .optional()
      .meta({ title: "Response Body", ui: "fields", hideWhen: { respondWith: ["noData"] } }),
    responseCode: z.number().int().min(100).max(599).default(200).meta({ title: "Response Code" }),
    responseHeaders: z
      .record(z.string(), z.string())
      .optional()
      .meta({ title: "Response Headers" }),
  }),
  defaultConfig: { respondWith: "json", responseCode: 200 },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (c) => (typeof c.respondWith === "string" ? c.respondWith : undefined),
  // The node passes its input on. The answer goes to the HTTP request of a webhook with the
  // mode "Using Respond to Webhook Node". A run that no request waits for ignores it.
  run: ({ config, input }) => {
    const headers = { ...(config.responseHeaders ?? {}) };
    const hasType = Object.keys(headers).some((name) => name.toLowerCase() === "content-type");
    let body: unknown = null;
    if (config.respondWith === "json") {
      // Always encode. A string would go out raw as text otherwise.
      const value = config.body ?? input;
      body = value === undefined ? null : JSON.stringify(value);
      if (!hasType) headers["content-type"] = "application/json";
    }
    if (config.respondWith === "text") {
      body =
        typeof (config.body ?? input) === "string"
          ? (config.body ?? input)
          : JSON.stringify(config.body ?? input);
      if (!hasType) headers["content-type"] = "text/plain; charset=utf-8";
    }
    return {
      port: "out",
      data: input,
      respond: { status: config.responseCode, headers, body },
    };
  },
});
