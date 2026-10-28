// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { connectSsh, runRemoteCommand, SSH_CREDENTIAL_TYPES } from "./ssh";

export default defineNode({
  type: "ssh.execute",
  label: "SSH",
  description: "Run a command on a server over SSH",
  category: "integration",
  app: "SSH",
  icon: "Terminal",
  config: z.object({
    command: z.string().min(1).meta({
      title: "Command",
      placeholder: "e.g. uptime",
    }),
    workingDirectory: z.string().default("").meta({
      title: "Working Directory",
      description: "The folder to run the command in. Empty: the home folder of the user.",
    }),
    failOnError: z.boolean().default(false).meta({
      title: "Fail on Non-Zero Exit",
      description: "Whether the node fails when the command exits with a code that is not 0",
    }),
  }),
  defaultConfig: { command: "", workingDirectory: "", failOnError: false },
  credentialTypes: SSH_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) =>
    typeof cfg.command === "string" && cfg.command !== "" ? cfg.command : undefined,
  async run({ config, credential, signal }) {
    const client = await connectSsh(credential);
    try {
      const quoted = `'${config.workingDirectory.replace(/'/g, `'\\''`)}'`;
      const command = config.workingDirectory
        ? `cd ${quoted} && ${config.command}`
        : config.command;
      const result = await runRemoteCommand(client, command, signal);
      if (config.failOnError && result.exitCode !== 0) {
        throw new Error(
          `The command exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
      return { port: "out", data: result };
    } finally {
      client.end();
    }
  },
});
