// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { assertCommandsEnabled } from "./local-access";

const MAX_OUTPUT_BYTES = 1024 * 1024;

export default defineNode({
  type: "core.execute_command",
  label: "Execute Command",
  description: "Run a shell command on the machine of the worker",
  category: "core",
  icon: "ComputerTerminal01Icon",
  config: z.object({
    command: z.string().min(1).meta({
      title: "Command",
      placeholder: "e.g. echo hello",
      description: "Runs in a shell. The operator must set ZERODOT_ENABLE_EXECUTE_COMMAND=true.",
    }),
    timeoutMs: z.number().int().min(1).max(600_000).default(30_000).meta({
      title: "Timeout (ms)",
    }),
    failOnError: z.boolean().default(false).meta({
      title: "Fail on Non-Zero Exit",
      description: "Whether the node fails when the command exits with a code that is not 0",
    }),
  }),
  defaultConfig: { command: "", timeoutMs: 30_000, failOnError: false },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) =>
    typeof cfg.command === "string" && cfg.command !== "" ? cfg.command : undefined,
  async run({ config, signal }) {
    assertCommandsEnabled();
    const { exec } = await import("node:child_process");
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve, reject) => {
        exec(
          config.command,
          { timeout: config.timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, signal },
          (error, stdout, stderr) => {
            if (!error) return resolve({ exitCode: 0, stdout, stderr });
            if (signal.aborted) return reject(new Error("Run cancelled"));
            if (error.killed) {
              return reject(new Error(`The command took longer than ${config.timeoutMs} ms`));
            }
            if ("code" in error && typeof error.code === "number") {
              return resolve({ exitCode: error.code, stdout, stderr });
            }
            if ("code" in error && error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
              return reject(new Error("The output of the command is too large"));
            }
            reject(error);
          },
        );
      },
    );
    if (config.failOnError && result.exitCode !== 0) {
      throw new Error(
        `The command exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
    return { port: "out", data: result };
  },
});
