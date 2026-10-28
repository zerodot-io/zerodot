// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import type { Client, FileInfo } from "basic-ftp";
import { type RemoteEntry, type RemoteFs, remoteFilesNode } from "./remote-files";

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

function typeOf(info: FileInfo): RemoteEntry["type"] {
  if (info.isDirectory) return "directory";
  if (info.isSymbolicLink) return "link";
  return info.isFile ? "file" : "other";
}

export function ftpFs(client: Client): RemoteFs {
  const list = async (path: string, recursive: boolean): Promise<RemoteEntry[]> => {
    const out: RemoteEntry[] = [];
    for (const info of await client.list(path)) {
      const item: RemoteEntry = {
        name: info.name,
        path: join(path, info.name),
        type: typeOf(info),
        size: info.size,
        modifiedAt: info.modifiedAt ? info.modifiedAt.toISOString() : null,
      };
      out.push(item);
      if (recursive && item.type === "directory") out.push(...(await list(item.path, true)));
    }
    return out;
  };
  return {
    list,
    async download(path) {
      const { Writable } = await import("node:stream");
      const chunks: Buffer[] = [];
      await client.downloadTo(
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        }),
        path,
      );
      return Buffer.concat(chunks);
    },
    async upload(path, bytes) {
      const { Readable } = await import("node:stream");
      const slash = path.lastIndexOf("/");
      if (slash > 0) await client.ensureDir(path.slice(0, slash));
      await client.cd("/");
      await client.uploadFrom(Readable.from(bytes), path);
    },
    async remove(path, folder, recursive) {
      if (!folder) return void (await client.remove(path));
      if (recursive) await client.removeDir(path);
      else await client.send(`RMD ${path}`);
    },
    async rename(from, to) {
      await client.rename(from, to);
    },
    async close() {
      client.close();
    },
  };
}

export default remoteFilesNode({
  type: "ftp.files",
  label: "FTP",
  description: "List, download, upload, rename, and delete files on an FTP server",
  app: "FTP",
  icon: "FolderOpen",
  credentialTypes: ["ftp"],
  async connect(credential: ResolvedCredential | null) {
    if (credential?.type !== "ftp") throw new Error("Pick an FTP credential");
    const { data } = credential;
    const host = text(data.host);
    if (!host) throw new Error('The credential has no "host"');
    const { Client } = await import("basic-ftp");
    const client = new Client(30_000);
    try {
      await client.access({
        host,
        port: text(data.port) ? Number(data.port) : 21,
        user: text(data.username) ?? "anonymous",
        password: text(data.password) ?? "anonymous@",
        secure: data.secure === "true",
      });
    } catch (error) {
      client.close();
      throw error;
    }
    return ftpFs(client);
  },
});
