// SPDX-License-Identifier: AGPL-3.0-only
import { type BlobRef, type BlobStore, blobRunId, mapBlobRefs } from "@zerodot/engine";
import { and, eq, inArray } from "drizzle-orm";
import { getBlobSetup } from "./blob-setup";
import type { Db } from "./client";
import { run, runNodeResult } from "./schema";

/** Deletes all blobs of the runs. Call it when you delete runs. A run without blobs is fine. */
export async function deleteBlobsForRuns(
  runIds: string[],
  store: BlobStore | undefined = getBlobSetup()?.store,
): Promise<void> {
  if (!store) return;
  for (const runId of runIds) await store.deleteRun(runId);
}

/**
 * Deletes the blobs of runs that are gone (purged, or deleted with their workflow). Safe to run
 * at any time and as often as needed. Returns the number of runs whose blobs it deleted.
 */
export async function deleteOrphanBlobs(
  db: Db,
  store: BlobStore | undefined = getBlobSetup()?.store,
): Promise<number> {
  if (!store) return 0;
  const found = await store.listRunIds();
  let deleted = 0;
  for (let i = 0; i < found.length; i += 500) {
    const chunk = found.slice(i, i + 500);
    const alive = new Set(
      (await db.select({ id: run.id }).from(run).where(inArray(run.id, chunk))).map((r) => r.id),
    );
    for (const runId of chunk) {
      if (alive.has(runId)) continue;
      await store.deleteRun(runId);
      deleted++;
    }
  }
  return deleted;
}

/**
 * A retry run starts with copies of the saved results of the old run. The copies point to blobs
 * of the old run, and those go when the old run goes. This copies the blobs to the new run and
 * changes the references.
 */
export async function copyBlobsToRun(
  db: Db,
  store: BlobStore,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const move = async (ref: BlobRef): Promise<BlobRef> => {
    if (blobRunId(ref.$blob) !== sourceId) return ref;
    const copy = await store.put(targetId, await store.get(ref), ref.mimeType);
    return {
      ...copy,
      ...(ref.fileName === undefined ? {} : { fileName: ref.fileName }),
      ...(ref.json ? { json: true as const } : {}),
    };
  };
  const rows = await db.select().from(runNodeResult).where(eq(runNodeResult.runId, targetId));
  for (const row of rows) {
    const next = {
      input: await mapBlobRefs(row.input, move),
      output: await mapBlobRefs(row.output, move),
      inputRef: await mapBlobRefs(row.inputRef, move),
      outputRef: await mapBlobRefs(row.outputRef, move),
    };
    const before = {
      input: row.input,
      output: row.output,
      inputRef: row.inputRef,
      outputRef: row.outputRef,
    };
    if (JSON.stringify(next) === JSON.stringify(before)) continue;
    await db
      .update(runNodeResult)
      .set(next)
      .where(
        and(
          eq(runNodeResult.runId, row.runId),
          eq(runNodeResult.nodeId, row.nodeId),
          eq(runNodeResult.attempt, row.attempt),
        ),
      );
  }
}
