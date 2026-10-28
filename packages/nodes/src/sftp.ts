// SPDX-License-Identifier: AGPL-3.0-only
import type { SFTPWrapper } from "ssh2";
import { type RemoteEntry, type RemoteFs, remoteFilesNode } from "./remote-files";
import { connectSsh, openSftp, SSH_CREDENTIAL_TYPES } from "./ssh";

const call = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => {
    run((error, value) => (error ? reject(error) : resolve(value as T)));
  });

const join = (dir: string, name: string) => `${dir.replace(/\/+$/, "")}/${name}`;

function typeOf(mode: number): RemoteEntry["type"] {
  switch (mode & 0o170000) {
    case 0o040000:
      return "directory";
    case 0o100000:
      return "file";
    case 0o120000:
      return "link";
    default:
      return "other";
  }
}

export function sftpFs(sftp: SFTPWrapper, closeConnection: () => void): RemoteFs {
  const list = async (path: string, recursive: boolean): Promise<RemoteEntry[]> => {
    const entries = await call<
      { filename: string; attrs: { mode: number; size: number; mtime: number } }[]
    >((done) => sftp.readdir(path, done));
    const out: RemoteEntry[] = [];
    for (const entry of entries) {
      const item: RemoteEntry = {
        name: entry.filename,
        path: join(path, entry.filename),
        type: typeOf(entry.attrs.mode),
        size: entry.attrs.size,
        modifiedAt: new Date(entry.attrs.mtime * 1000).toISOString(),
      };
      out.push(item);
      if (recursive && item.type === "directory") out.push(...(await list(item.path, true)));
    }
    return out;
  };
  const removeFolder = async (path: string, recursive: boolean): Promise<void> => {
    if (recursive) {
      for (const entry of await list(path, false)) {
        if (entry.type === "directory") await removeFolder(entry.path, true);
        else await call<void>((done) => sftp.unlink(entry.path, done));
      }
    }
    await call<void>((done) => sftp.rmdir(path, done));
  };
  return {
    list,
    download: (path) => call<Buffer>((done) => sftp.readFile(path, done)),
    upload: (path, bytes) => call<void>((done) => sftp.writeFile(path, bytes, done)),
    async remove(path, folder, recursive) {
      if (folder) await removeFolder(path, recursive);
      else await call<void>((done) => sftp.unlink(path, done));
    },
    rename: (from, to) => call<void>((done) => sftp.rename(from, to, done)),
    async close() {
      closeConnection();
    },
  };
}

export default remoteFilesNode({
  type: "sftp.files",
  label: "SFTP",
  description: "List, download, upload, rename, and delete files on an SFTP server",
  app: "SFTP",
  icon: "FolderOpen",
  credentialTypes: SSH_CREDENTIAL_TYPES,
  async connect(credential) {
    const client = await connectSsh(credential);
    try {
      return sftpFs(await openSftp(client), () => client.end());
    } catch (error) {
      client.end();
      throw error;
    }
  },
});
