// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { callMcpTool, MCP_CREDENTIAL_TYPES } from "./mcp-client";

export default defineNode({
  type: "mcp.call_tool",
  label: "MCP Call Tool",
  description: "Call a tool on an MCP server",
  category: "integration",
  icon: "Plug",
  config: z.object({
    // Streamable HTTP endpoint of the MCP server. No stdio servers in v1.
    url: z.url(),
    tool: z.string().min(1),
    // Values can use expressions. The editor builds the form from the JSON Schema of the tool.
    arguments: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  }),
  defaultConfig: { url: "https://", tool: "", arguments: {}, timeoutMs: 30_000 },
  credentialTypes: MCP_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.tool === "string" && config.tool !== "" ? config.tool : undefined,
  // A tool that reports an error fails the node. A good answer is the output.
  async run({ config, credential, signal }) {
    const result = await callMcpTool(
      { url: config.url, credential, signal, timeoutMs: config.timeoutMs },
      config.tool,
      config.arguments,
    );
    return { port: "out", data: result };
  },
});
