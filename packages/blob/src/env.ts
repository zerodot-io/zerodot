// SPDX-License-Identifier: AGPL-3.0-only
import type { BlobStore } from "@zerodot/engine";
import { diskBlobStore } from "./disk";
import { s3BlobStore } from "./s3";
import { s3Settings } from "./s3-sign";

export const DEFAULT_INLINE_OUTPUT_BYTES = 256 * 1024;

export type BlobSetup = {
  store: BlobStore;
  /** A node input or output above this size is stored as a blob. */
  inlineBytes: number;
};

type Env = Record<string, string | undefined>;

const text = (value: string | undefined) =>
  value && value.trim() !== "" ? value.trim() : undefined;

/**
 * The blob store that the environment asks for. S3 (`ZERODOT_BLOB_S3_BUCKET`) wins over a disk
 * directory (`ZERODOT_BLOB_DIR`). Returns null when neither is set: then all data stays in Postgres.
 */
export function blobSetupFromEnv(env: Env = process.env): BlobSetup | null {
  const raw = text(env.ZERODOT_INLINE_OUTPUT_BYTES);
  const inlineBytes = raw === undefined ? DEFAULT_INLINE_OUTPUT_BYTES : Number(raw);
  if (!Number.isInteger(inlineBytes) || inlineBytes < 0) {
    throw new Error("ZERODOT_INLINE_OUTPUT_BYTES must be a whole number of bytes");
  }
  const bucket = text(env.ZERODOT_BLOB_S3_BUCKET);
  if (bucket) {
    const accessKeyId = text(env.ZERODOT_BLOB_S3_ACCESS_KEY_ID);
    const secretAccessKey = text(env.ZERODOT_BLOB_S3_SECRET_ACCESS_KEY);
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "ZERODOT_BLOB_S3_BUCKET needs ZERODOT_BLOB_S3_ACCESS_KEY_ID and ZERODOT_BLOB_S3_SECRET_ACCESS_KEY",
      );
    }
    const data: Record<string, string> = { accessKeyId, secretAccessKey };
    const optional = {
      region: text(env.ZERODOT_BLOB_S3_REGION),
      endpoint: text(env.ZERODOT_BLOB_S3_ENDPOINT),
      forcePathStyle: text(env.ZERODOT_BLOB_S3_FORCE_PATH_STYLE),
    };
    for (const [name, value] of Object.entries(optional)) if (value) data[name] = value;
    const { target, keys } = s3Settings({ type: "s3", data });
    const prefix = text(env.ZERODOT_BLOB_S3_PREFIX);
    return {
      store: s3BlobStore({
        target,
        keys,
        bucket,
        prefix: prefix ? prefix.replace(/\/?$/, "/") : "",
      }),
      inlineBytes,
    };
  }
  const dir = text(env.ZERODOT_BLOB_DIR);
  if (dir) return { store: diskBlobStore(dir), inlineBytes };
  return null;
}

let cached: { setup: BlobSetup | null } | undefined;

/** `blobSetupFromEnv` for the process environment. It reads the environment once. */
export function blobSetup(): BlobSetup | null {
  cached ??= { setup: blobSetupFromEnv() };
  return cached.setup;
}
