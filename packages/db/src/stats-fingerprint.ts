// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

/**
 * Remove the parts of an error message that change between runs (urls, ids, numbers),
 * so the same error groups together.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "<id>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function errorFingerprint(message: string): string {
  return createHash("sha1").update(normalizeMessage(message)).digest("hex").slice(0, 16);
}
