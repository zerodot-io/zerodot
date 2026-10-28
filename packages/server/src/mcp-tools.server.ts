// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import { credentialHeader } from "@zerodot/nodes";

export type McpTool = {
  name: string;
  description: string;
  /** JSON Schema of the arguments. The editor builds the argument form from it. */
  inputSchema: unknown;
};

export type McpServerOptions = {
  url: string;
  credential: ResolvedCredential | null;
  signal: AbortSignal;
  timeoutMs: number;
};

const MAX_TOOLS = 500;

/**
 * The tools of an external MCP server, for the tool picker of the editor. Connects over
 * Streamable HTTP and always closes. The MCP Call Tool node itself is in `@zerodot/mcp`.
 */
export async function listMcpTools(options: McpServerOptions): Promise<McpTool[]> {
  const [{ Client }, { StreamableHTTPClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  const headers: Record<string, string> = {};
  if (options.credential) {
    const [name, value] = credentialHeader(options.credential);
    headers[name] = value;
  }
  const client = new Client({ name: "zerodot", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers },
  });
  const request = { signal: options.signal, timeout: options.timeoutMs };
  try {
    await client.connect(transport, request);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, request);
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_TOOLS);
    return tools;
  } finally {
    await client.close().catch(() => {});
  }
}
