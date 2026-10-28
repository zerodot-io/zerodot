// SPDX-License-Identifier: AGPL-3.0-only
import { credentialTypeByName } from "./credentials";
import { needsRefresh, OAuth2ReconnectError, refreshOAuth2Data } from "./oauth2";

/** A credential from the store. Same shape as `OpenedCredential` of `@zerodot/db`. */
export type StoredCredential = {
  id: string;
  name: string;
  type: string;
  status: "ok" | "needs_reconnect";
  data: Record<string, unknown>;
};

/** The part of `credentials` of `@zerodot/db` that this file needs. */
export type CredentialStore = {
  open(id: string): Promise<StoredCredential | null>;
  refresh(
    id: string,
    refresh: (
      current: StoredCredential,
    ) => Promise<{ data: Record<string, unknown> } | { status: "needs_reconnect" } | null>,
  ): Promise<StoredCredential | null>;
};

export type OpenOptions = {
  now?: () => number;
  fetch?: typeof fetch;
};

/**
 * Opens a credential. For an OAuth2 credential, it first makes sure the access token is valid:
 * a token near its end is refreshed, and the new tokens are saved. Many runs can ask at once.
 * The row lock in `credentials.refresh` lets only one of them call the provider.
 *
 * Throws when the account is not connected, or when the provider refused the refresh token
 * (the credential is then marked `needs_reconnect`). Returns null when the credential is gone.
 */
export async function openCredential(
  credentials: CredentialStore,
  id: string,
  options: OpenOptions = {},
): Promise<StoredCredential | null> {
  const now = options.now ?? Date.now;
  const opened = await credentials.open(id);
  if (!opened || !credentialTypeByName.get(opened.type)?.oauth2) return opened;
  if (opened.status === "needs_reconnect") throw reconnect(opened.name);
  if (!needsRefresh(opened.data, now())) return opened;
  if (!opened.data.accessToken && !opened.data.refreshToken) throw notConnected(opened.name);

  const result = await credentials.refresh(id, async (current) => {
    if (current.status === "needs_reconnect") return null;
    // Another caller can have refreshed while this one waited for the lock.
    if (!needsRefresh(current.data, now())) return null;
    try {
      return {
        data: await refreshOAuth2Data(current.type, current.data, {
          now: now(),
          fetch: options.fetch,
        }),
      };
    } catch (error) {
      if (error instanceof OAuth2ReconnectError) return { status: "needs_reconnect" };
      throw error;
    }
  });
  if (!result) return null;
  if (result.status === "needs_reconnect") throw reconnect(result.name);
  return result;
}

const reconnect = (name: string) =>
  new Error(`The credential "${name}" must be connected again. The provider refused the refresh.`);

const notConnected = (name: string) =>
  new Error(`The credential "${name}" is not connected to an account yet.`);
