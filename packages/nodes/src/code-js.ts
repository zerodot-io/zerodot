// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, SANDBOX_MAX_CODE_CHARS, SANDBOX_MAX_TIMEOUT_MS } from "@zerodot/engine";
import { z } from "zod";

const DEFAULT_CODE = `// Return the data for the next node. console.log shows in the run.
// You can read: $input, $trigger, $node["Name"].data, $vars (read only), $run.
return { ...$input };`;

export default defineNode({
  type: "code.js",
  label: "Code",
  description: "Run JavaScript to transform data",
  category: "code",
  icon: "Code",
  config: z.object({
    // The body of an async function. Use `return`. The editor shows this field as code.
    code: z.string().min(1).max(SANDBOX_MAX_CODE_CHARS).meta({ ui: "code" }),
    timeoutMs: z.number().int().min(1).max(SANDBOX_MAX_TIMEOUT_MS).default(10_000),
  }),
  defaultConfig: { code: DEFAULT_CODE, timeoutMs: 10_000 },
  // JavaScript is not an expression. `{{ }}` in code stays as it is.
  rawConfigKeys: ["code"],
  ports: { in: ["in"], out: ["out"] },
  subtitle: () => "JavaScript",
  async run({ config, scope, sandbox, signal, log }) {
    if (!sandbox) {
      throw new Error("Code cannot run here: the worker has no SANDBOX_URL");
    }
    const result = await sandbox.run(
      { code: config.code, scope, timeoutMs: config.timeoutMs },
      signal,
      log,
    );
    return { port: "out", data: result ?? null };
  },
});
