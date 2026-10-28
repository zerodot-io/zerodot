// SPDX-License-Identifier: AGPL-3.0-only
export const UUID = /^[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;

/**
 * The run id and hash of a blob id `<run id>/<sha-256>`. The id comes from a stored reference,
 * and node data can hold a forged one, so the shape is checked before a store reads it.
 */
export function blobIdParts(id: string): { runId: string; hash: string } {
  const [runId, hash, extra] = id.split("/");
  if (!runId || !hash || extra !== undefined || !UUID.test(runId) || !HASH.test(hash)) {
    throw new Error(`Invalid blob id "${id}"`);
  }
  return { runId, hash };
}
