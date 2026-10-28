// SPDX-License-Identifier: AGPL-3.0-only

/** The output of a Wait node that a call to its resume URL ended. */
export type WaitCallbackData = {
  method: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
};

/** The call, without the `sig` query value. The signature only proves the right to call. */
export function waitCallbackData(call: {
  method: string;
  headers: Headers;
  url: URL;
  body: unknown;
}): WaitCallbackData {
  const query = Object.fromEntries(call.url.searchParams);
  delete query.sig;
  return {
    method: call.method,
    headers: Object.fromEntries(call.headers),
    query,
    body: call.body,
  };
}
