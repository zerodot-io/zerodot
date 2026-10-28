// SPDX-License-Identifier: AGPL-3.0-only
import type { BlobStore } from "@zerodot/engine";

/** Where large and binary node data goes, and from what size. */
export type BlobSetup = {
  store: BlobStore;
  /** A node input or output above this size (bytes) is stored as a blob. */
  inlineBytes: number;
};

let current: BlobSetup | null = null;

/**
 * The blob setup of this process. The web server sets it when it starts. A scope made with
 * `forOrganization` uses it, unless the caller passes its own. Null means: no blob store, all
 * data stays in Postgres.
 */
export function setBlobSetup(setup: BlobSetup | null): void {
  current = setup;
}

export const getBlobSetup = (): BlobSetup | null => current;
