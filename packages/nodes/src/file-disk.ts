// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readBinary, toBinary } from "./binary";
import { resolveFilePath } from "./local-access";

export default defineNode({
  type: "file.disk",
  label: "Read/Write Files from Disk",
  description: "Read a file from the machine of the worker, or write one to it",
  category: "data",
  actions: [
    { label: "Read a file from disk", config: { operation: "read" } },
    { label: "Write a file to disk", config: { operation: "write" } },
  ],
  icon: "HardDriveIcon",
  config: z.object({
    operation: z
      .enum(["read", "write"])
      .default("read")
      .meta({
        title: "Operation",
        labels: { read: "Read File", write: "Write File" },
        hints: {
          read: "Read a file and put it in a binary field",
          write: "Write a binary field of the input to a file",
        },
      }),
    path: z.string().min(1).meta({
      title: "File Path",
      placeholder: "e.g. exports/report.csv",
      description:
        "Relative to the folder in ZERODOT_FILES_DIR. The operator must set that variable.",
    }),
    property: z.string().min(1).default("data").meta({
      title: "Binary Field",
      description: "Read: the file goes to binary.<property>. Write: the file comes from it.",
    }),
    append: z
      .boolean()
      .default(false)
      .meta({
        title: "Append",
        description: "Write only: add to the end of the file, and do not replace it",
        showWhen: { operation: ["write"] },
      }),
  }),
  defaultConfig: { operation: "read", path: "", property: "data", append: false },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.path === "string" && cfg.path !== "" ? cfg.path : undefined),
  async run({ config, input }) {
    const fs = await import("node:fs/promises");
    const { basename, dirname } = await import("node:path");
    const path = await resolveFilePath(config.path);
    if (config.operation === "read") {
      const bytes = await fs.readFile(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") throw new Error(`The file "${config.path}" does not exist`);
        if (error.code === "EISDIR") throw new Error(`"${config.path}" is a folder`);
        throw error;
      });
      return {
        port: "out",
        data: { path: config.path, binary: { [config.property]: toBinary(bytes, basename(path)) } },
      };
    }
    const file = readBinary(input, config.property);
    const bytes = Buffer.from(file.data, "base64");
    await fs.mkdir(dirname(path), { recursive: true });
    if (config.append) await fs.appendFile(path, bytes);
    else await fs.writeFile(path, bytes);
    return { port: "out", data: { path: config.path, size: bytes.length } };
  },
});
