// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { listMcpTools } from "./mcp-tools.server";

afterEach(() => mock.restoreAll());

describe("listMcpTools", () => {
  it("lists the tools with their JSON Schema, and sends the credential", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const { z } = await import("zod");
    const seen: Headers[] = [];
    // A new server for each request, like the zerodot server. No session.
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const server = new McpServer({ name: "fake", version: "1" });
      server.registerTool(
        "echo",
        { description: "Echo", inputSchema: { text: z.string() } },
        async (args) => ({ content: [{ type: "text" as const, text: args.text }] }),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const request = new Request(input as string, init);
      seen.push(request.headers);
      return transport.handleRequest(request);
    });
    const tools = await listMcpTools({
      url: "https://mcp.test/mcp",
      credential: { type: "http.bearer", data: { token: "tok" } },
      signal: new AbortController().signal,
      timeoutMs: 5000,
    });
    const first = tools[0];
    assert.equal(first?.name, "echo");
    assert.deepEqual((first?.inputSchema as { required?: string[] } | undefined)?.required, [
      "text",
    ]);
    assert.ok(seen.every((h) => h.get("authorization") === "Bearer tok"));
  });
});
