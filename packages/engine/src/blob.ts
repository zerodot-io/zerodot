// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

/**
 * Large and binary node data. A blob store keeps the bytes outside Postgres. The node result
 * keeps a small reference. The stores themselves (disk, S3) are in `@zerodot/blob`.
 */
export type BlobRef = {
  /** The blob id: `<run id>/<sha-256 of the bytes>`. */
  $blob: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
  fileName?: string;
  /** True when the bytes are the JSON text of a whole node output, and not a file. */
  json?: true;
};

export interface BlobStore {
  /** Stores bytes for a run. The same bytes in the same run give the same reference. */
  put(runId: string, bytes: Uint8Array, mimeType: string): Promise<BlobRef>;
  get(ref: BlobRef): Promise<Uint8Array>;
  /** Deletes all blobs of a run. */
  deleteRun(runId: string): Promise<void>;
  /** The ids of all runs that have blobs. Used to find blobs of runs that are gone. */
  listRunIds(): Promise<string[]>;
}

/** Binary data in a node output, under `binary.<property>`. Same shape as `BinaryData`. */
type InlineBinary = { data: string; mimeType: string; fileName?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isBlobRef(value: unknown): value is BlobRef {
  return (
    isRecord(value) &&
    typeof value.$blob === "string" &&
    typeof value.mimeType === "string" &&
    typeof value.size === "number"
  );
}

const isInlineBinary = (value: unknown): value is InlineBinary =>
  isRecord(value) && typeof value.data === "string" && typeof value.mimeType === "string";

/** True when the value has a blob reference anywhere inside. */
export function containsBlobRef(value: unknown): boolean {
  if (isBlobRef(value)) return true;
  if (Array.isArray(value)) return value.some(containsBlobRef);
  if (isRecord(value)) return Object.values(value).some(containsBlobRef);
  return false;
}

export const blobId = (runId: string, bytes: Uint8Array): string =>
  `${runId}/${createHash("sha256").update(bytes).digest("hex")}`;

/** The run id part of a blob id. */
export const blobRunId = (id: string): string => id.split("/")[0] ?? "";

/**
 * Copy of `value` where each file under a `binary` key is a blob reference. Other data does not
 * change. The input is not changed.
 */
export async function externalizeBinary(
  value: unknown,
  store: BlobStore,
  runId: string,
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => externalizeBinary(item, store, runId)));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "binary" && isRecord(child) && Object.values(child).every(isInlineBinary)) {
      const files: Record<string, unknown> = {};
      for (const [property, file] of Object.entries(child)) {
        const binary = file as InlineBinary;
        const ref = await store.put(runId, Buffer.from(binary.data, "base64"), binary.mimeType);
        files[property] =
          binary.fileName === undefined ? ref : { ...ref, fileName: binary.fileName };
      }
      out[key] = files;
    } else {
      out[key] = await externalizeBinary(child, store, runId);
    }
  }
  return out;
}

export type StoredValue = {
  /** What goes in the JSON column. Null when the whole value is in a blob. */
  inline: unknown;
  /** The reference to the whole value, when it was above the limit. */
  ref: BlobRef | null;
};

/**
 * Prepares a node input or output for the database. Files become blobs. When the rest is still
 * above `inlineBytes`, the whole value becomes one JSON blob. `keepInline` stops the second step.
 */
export async function storeValue(
  value: unknown,
  store: BlobStore,
  options: { runId: string; inlineBytes: number; keepInline?: boolean },
): Promise<StoredValue> {
  const slim = await externalizeBinary(value, store, options.runId);
  if (options.keepInline) return { inline: slim, ref: null };
  const text = JSON.stringify(slim ?? null);
  if (Buffer.byteLength(text) <= options.inlineBytes) return { inline: slim, ref: null };
  const ref = await store.put(options.runId, Buffer.from(text), "application/json");
  return { inline: null, ref: { ...ref, json: true } };
}

/**
 * Copy of `value` where each blob reference is back to `{ data, mimeType, fileName }` (base64).
 * A reference to a whole JSON value is read and parsed. A missing blob gives an error.
 */
export async function hydrate(value: unknown, store: BlobStore): Promise<unknown> {
  if (isBlobRef(value)) {
    const bytes = await store.get(value);
    if (value.json) return hydrate(JSON.parse(Buffer.from(bytes).toString("utf8")), store);
    const file: InlineBinary = {
      data: Buffer.from(bytes).toString("base64"),
      mimeType: value.mimeType,
    };
    if (value.fileName !== undefined) file.fileName = value.fileName;
    return file;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrate(item, store)));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = await hydrate(child, store);
    return out;
  }
  return value;
}

/** The ids of all blobs that a value points to. */
export function blobIds(value: unknown, found: string[] = []): string[] {
  if (isBlobRef(value)) found.push(value.$blob);
  else if (Array.isArray(value)) for (const item of value) blobIds(item, found);
  else if (isRecord(value)) for (const item of Object.values(value)) blobIds(item, found);
  return found;
}

/** A store in memory. For tests. */
export function memoryBlobStore(): BlobStore & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    async put(runId, bytes, mimeType) {
      const id = blobId(runId, bytes);
      blobs.set(id, Uint8Array.from(bytes));
      return { $blob: id, mimeType, size: bytes.byteLength };
    },
    async get(ref) {
      const bytes = blobs.get(ref.$blob);
      if (!bytes) throw new Error(`Blob ${ref.$blob} does not exist`);
      return bytes;
    },
    async deleteRun(runId) {
      for (const id of [...blobs.keys()]) if (blobRunId(id) === runId) blobs.delete(id);
    },
    async listRunIds() {
      return [...new Set([...blobs.keys()].map(blobRunId))];
    },
  };
}

/** Copy of `value` where `change` replaces each blob reference. */
export async function mapBlobRefs(
  value: unknown,
  change: (ref: BlobRef) => Promise<BlobRef>,
): Promise<unknown> {
  if (isBlobRef(value)) return change(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => mapBlobRefs(item, change)));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) out[key] = await mapBlobRefs(child, change);
    return out;
  }
  return value;
}
