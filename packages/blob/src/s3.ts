// SPDX-License-Identifier: AGPL-3.0-only
import { type BlobRef, type BlobStore, blobId } from "@zerodot/engine";
import { blobIdParts } from "./id";
import { listObjects, type S3Context, s3Send } from "./s3-client";
import type { S3Keys, S3Target } from "./s3-sign";

export type S3BlobConfig = {
  target: S3Target;
  keys: S3Keys;
  bucket: string;
  /** Put before every key. Example: `blobs/`. Default: none. */
  prefix?: string;
  fetch?: typeof fetch;
};

/** Objects in a bucket of S3 or an S3-compatible service: `<prefix><run id>/<sha-256>`. */
export function s3BlobStore(config: S3BlobConfig): BlobStore {
  const prefix = config.prefix ?? "";
  const ctx: S3Context = {
    target: config.target,
    keys: config.keys,
    fetch: config.fetch ?? fetch,
  };
  /** The key of a blob. A forged id with `..` could reach keys outside the prefix. */
  const keyOf = (id: string) => {
    const { runId, hash } = blobIdParts(id);
    return `${prefix}${runId}/${hash}`;
  };

  return {
    async put(runId, bytes, mimeType): Promise<BlobRef> {
      const id = blobId(runId, bytes);
      await s3Send(ctx, {
        method: "PUT",
        bucket: config.bucket,
        key: keyOf(id),
        body: bytes,
        headers: { "content-type": mimeType },
      });
      return { $blob: id, mimeType, size: bytes.byteLength };
    },
    async get(ref) {
      const response = await s3Send(ctx, {
        method: "GET",
        bucket: config.bucket,
        key: keyOf(ref.$blob),
      });
      return new Uint8Array(await response.arrayBuffer());
    },
    async deleteRun(runId) {
      const rows = await listObjects(ctx, config.bucket, { prefix: `${prefix}${runId}/` });
      for (const row of rows) {
        if (typeof row.key === "string") {
          await s3Send(ctx, { method: "DELETE", bucket: config.bucket, key: row.key });
        }
      }
    },
    async listRunIds() {
      const rows = await listObjects(ctx, config.bucket, { prefix, delimiter: "/" });
      return rows
        .map((row) => (typeof row.prefix === "string" ? row.prefix : ""))
        .map((p) => p.slice(prefix.length).replace(/\/$/, ""))
        .filter((id) => id !== "");
    },
  };
}
