// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type BlobRef, type BlobStore, blobId } from "@zerodot/engine";

import { blobIdParts, UUID } from "./id";

/** Files in a directory: `<dir>/<run id>/<sha-256>`. Use a volume that all workers and web share. */
export function diskBlobStore(dir: string): BlobStore {
  /** The path of a blob. */
  const pathOf = (id: string): string => {
    const { runId, hash } = blobIdParts(id);
    return join(dir, runId, hash);
  };

  return {
    async put(runId, bytes, mimeType): Promise<BlobRef> {
      const id = blobId(runId, bytes);
      const path = pathOf(id);
      await mkdir(join(dir, runId), { recursive: true });
      // Write to a temp name, then rename. A reader never sees half a file.
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(temp, bytes);
      await rename(temp, path);
      return { $blob: id, mimeType, size: bytes.byteLength };
    },
    async get(ref) {
      return new Uint8Array(await readFile(pathOf(ref.$blob)));
    },
    async deleteRun(runId) {
      if (!UUID.test(runId)) throw new Error(`Invalid run id "${runId}"`);
      await rm(join(dir, runId), { recursive: true, force: true });
    },
    async listRunIds() {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      return entries.filter((e) => e.isDirectory() && UUID.test(e.name)).map((e) => e.name);
    },
  };
}
