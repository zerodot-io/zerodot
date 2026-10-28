// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, type NodeDefinition, type ResolvedCredential } from "@zerodot/engine";
import { z } from "zod";
import { readBinary, toBinary } from "./binary";

export type RemoteEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  modifiedAt: string | null;
};

/** What the FTP and SFTP nodes need from a server. Each protocol has its own version. */
export type RemoteFs = {
  list(path: string, recursive: boolean): Promise<RemoteEntry[]>;
  download(path: string): Promise<Buffer>;
  upload(path: string, bytes: Buffer): Promise<void>;
  remove(path: string, folder: boolean, recursive: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
};

const OPERATIONS = ["list", "download", "upload", "rename", "delete"] as const;

const config = z.object({
  operation: z
    .enum(OPERATIONS)
    .default("list")
    .meta({
      title: "Operation",
      labels: {
        list: "List",
        download: "Download",
        upload: "Upload",
        rename: "Rename or Move",
        delete: "Delete",
      },
      hints: {
        list: "List the files and folders in a folder",
        download: "Get a file as binary data",
        upload: "Send a binary field of the input to the server",
        rename: "Rename or move a file or folder",
        delete: "Delete a file or a folder",
      },
    }),
  path: z.string().min(1).default("/").meta({
    title: "Path",
    placeholder: "e.g. /data/report.csv",
    description: "The folder or the file on the server",
  }),
  newPath: z
    .string()
    .min(1)
    .optional()
    .meta({
      title: "New Path",
      description: "The new path of the file or folder",
      showWhen: { operation: ["rename"] },
    }),
  property: z
    .string()
    .min(1)
    .default("data")
    .meta({
      title: "Binary Field",
      description: "Download: the file goes to binary.<property>. Upload: the file comes from it.",
      showWhen: { operation: ["download", "upload"] },
    }),
  recursive: z
    .boolean()
    .default(false)
    .meta({
      title: "Recursive",
      description: "List: go into the folders. Delete: delete a folder with its content.",
      showWhen: { operation: ["list", "delete"] },
    }),
  folder: z
    .boolean()
    .default(false)
    .meta({
      title: "Folder",
      description: "Whether the path is a folder",
      showWhen: { operation: ["delete"] },
    }),
});

export type RemoteFilesConfig = z.output<typeof config>;

const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() ?? path;

/** Runs one operation. The caller opens and closes the connection. */
export async function runRemoteOperation(
  fs: RemoteFs,
  cfg: RemoteFilesConfig,
  input: unknown,
): Promise<unknown> {
  switch (cfg.operation) {
    case "list":
      return { items: await fs.list(cfg.path, cfg.recursive) };
    case "download": {
      const bytes = await fs.download(cfg.path);
      return { path: cfg.path, binary: { [cfg.property]: toBinary(bytes, baseName(cfg.path)) } };
    }
    case "upload": {
      const file = readBinary(input, cfg.property);
      const bytes = Buffer.from(file.data, "base64");
      // A path that ends with / is a folder. The file keeps its name.
      const target = cfg.path.endsWith("/")
        ? `${cfg.path}${file.fileName ?? cfg.property}`
        : cfg.path;
      await fs.upload(target, bytes);
      return { path: target, size: bytes.length };
    }
    case "rename": {
      if (!cfg.newPath) throw new Error("Add the new path");
      await fs.rename(cfg.path, cfg.newPath);
      return { path: cfg.newPath, oldPath: cfg.path };
    }
    case "delete":
      await fs.remove(cfg.path, cfg.folder, cfg.recursive);
      return { path: cfg.path, deleted: true };
  }
}

/** The FTP node and the SFTP node differ only in how they connect. */
export function remoteFilesNode(options: {
  type: string;
  label: string;
  description: string;
  app: string;
  icon: string;
  credentialTypes: string[];
  connect(credential: ResolvedCredential | null): Promise<RemoteFs>;
}): NodeDefinition {
  return defineNode({
    type: options.type,
    label: options.label,
    description: options.description,
    category: "integration",
    app: options.app,
    actions: [
      { label: "List files in a folder", config: { operation: "list" } },
      { label: "Download a file", config: { operation: "download" } },
      { label: "Upload a file", config: { operation: "upload" } },
      { label: "Rename or move a file", config: { operation: "rename" } },
      { label: "Delete a file or folder", config: { operation: "delete" } },
    ],
    icon: options.icon,
    config,
    defaultConfig: {
      operation: "list",
      path: "/",
      property: "data",
      recursive: false,
      folder: false,
    },
    credentialTypes: options.credentialTypes,
    ports: { in: ["in"], out: ["out"] },
    subtitle: (cfg) => (typeof cfg.operation === "string" ? cfg.operation : undefined),
    async run({ config: cfg, input, credential }) {
      const fs = await options.connect(credential);
      try {
        return { port: "out", data: await runRemoteOperation(fs, cfg, input) };
      } finally {
        await fs.close().catch(() => {});
      }
    },
  }) as NodeDefinition;
}
