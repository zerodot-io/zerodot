// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from "node:crypto";

/** The signature in the resume URL of a waiting node. Only this run and this node can use it. */
export function resumeSignature(secretKey: Buffer, runId: string, nodeId: string): string {
  return createHmac("sha256", secretKey).update(`resume:${runId}:${nodeId}`).digest("base64url");
}

export function verifyResumeSignature(
  secretKey: Buffer,
  runId: string,
  nodeId: string,
  given: string,
): boolean {
  const wanted = Buffer.from(resumeSignature(secretKey, runId, nodeId));
  const actual = Buffer.from(given);
  return wanted.byteLength === actual.byteLength && timingSafeEqual(wanted, actual);
}

/** The address that a person opens to answer a waiting node. */
export function resumeUrl(
  baseUrl: string,
  secretKey: Buffer,
  runId: string,
  nodeId: string,
): string {
  const signature = resumeSignature(secretKey, runId, nodeId);
  return `${baseUrl.replace(/\/+$/, "")}/resume/${runId}/${encodeURIComponent(nodeId)}?sig=${signature}`;
}
