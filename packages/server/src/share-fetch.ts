// SPDX-License-Identifier: AGPL-3.0-only

/** The header that carries the password of a protected share link. */
export const SHARE_PASSWORD_HEADER = "X-Zerodot-Share-Password";

/** Sent by a zerodot import. A single-use link opens only for a request that has it. */
export const SHARE_IMPORT_HEADER = "X-Zerodot-Import";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;

export class ShareFetchError extends Error {
  constructor(
    message: string,
    /** True when the link needs a password, or the password is not correct. */
    readonly passwordRequired = false,
  ) {
    super(message);
  }
}

/** Reads a share link, or any URL of a `.zerodot.json` file. Throws a `ShareFetchError`. */
export async function fetchSharedFile(url: string, password?: string | null): Promise<unknown> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ShareFetchError("The link is not a full URL");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new ShareFetchError("The link must start with https:// or http://");
  }
  let response: Response;
  try {
    response = await fetch(target, {
      headers: {
        [SHARE_IMPORT_HEADER]: "1",
        ...(password ? { [SHARE_PASSWORD_HEADER]: password } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ShareFetchError("Could not read the link");
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new ShareFetchError("The file is larger than 5 MB");
  const text = await response.text();
  if (text.length > MAX_BYTES) throw new ShareFetchError("The file is larger than 5 MB");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ShareFetchError("The link does not give a workflow file");
  }
  const info = (body ?? {}) as { error?: unknown; passwordRequired?: unknown };
  const error = typeof info.error === "string" ? info.error : null;
  if (response.status === 401 && info.passwordRequired === true) {
    throw new ShareFetchError(error ?? "This link needs a password", true);
  }
  if (!response.ok) {
    throw new ShareFetchError(error ?? `The link gave status ${response.status}`);
  }
  return body;
}
