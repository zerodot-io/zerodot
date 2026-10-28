// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";

export const GITHUB_TOKEN_CREDENTIAL = "github.token";
export const GITHUB_OAUTH2_CREDENTIAL = "github.oauth2";
export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";

/** The most items that "return all" collects. A node output has a size limit too. */
export const MAX_ITEMS = 5000;
const PER_PAGE = 100;

export type GithubAccess = { token: string; baseUrl: string };

/** The token and the API address of a GitHub credential (access token or OAuth2). */
export function githubAccess(credential: Pick<ResolvedCredential, "type" | "data"> | null) {
  if (
    !credential ||
    (credential.type !== GITHUB_TOKEN_CREDENTIAL && credential.type !== GITHUB_OAUTH2_CREDENTIAL)
  ) {
    throw new Error("The node needs a GitHub credential");
  }
  const { accessToken, server } = credential.data;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new Error(
      credential.type === GITHUB_OAUTH2_CREDENTIAL
        ? "The GitHub credential is not connected to an account yet"
        : 'The credential has no "accessToken"',
    );
  }
  const base = typeof server === "string" && server !== "" ? server : GITHUB_API;
  return { token: accessToken, baseUrl: base.replace(/\/+$/, "") } satisfies GithubAccess;
}

export type GithubRequest = {
  method: string;
  /** Starts with `/`. */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  /** The list is in this key of the answer, not the answer itself. */
  itemsKey?: string;
};

type CallOptions = { signal: AbortSignal; timeoutMs: number };

const nextLink = (header: string | null): string | null =>
  header
    ?.split(",")
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find(Boolean) ?? null;

async function send(access: GithubAccess, url: URL, request: GithubRequest, options: CallOptions) {
  // The token goes only to the API host. A link that points elsewhere is never followed.
  if (url.origin !== new URL(access.baseUrl).origin) {
    throw new Error("GitHub sent a link to another host");
  }
  const response = await fetch(url, {
    method: request.method,
    headers: {
      authorization: `Bearer ${access.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": API_VERSION,
      "user-agent": "zerodot",
      ...(request.body ? { "content-type": "application/json" } : {}),
    },
    body: request.body ? JSON.stringify(request.body) : undefined,
    redirect: "error",
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
  });
  if (!response.ok) {
    const answer = (await response.json().catch(() => null)) as { message?: string } | null;
    const hint =
      response.status === 404 || response.status === 403
        ? " Check the repository name and that the token may use this endpoint."
        : "";
    throw new Error(
      `GitHub ${request.method} ${request.path} failed (${response.status}): ${answer?.message ?? "no message"}.${hint}`,
    );
  }
  const data =
    response.status === 204 ? null : ((await response.json().catch(() => null)) as unknown);
  return { data, next: nextLink(response.headers.get("link")) };
}

function urlFor(access: GithubAccess, request: GithubRequest): URL {
  const url = new URL(`${access.baseUrl}${request.path}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

/** One call. A 204 answer gives null. The error text never has the token. */
export async function callGithub(
  access: GithubAccess,
  request: GithubRequest,
  options: CallOptions,
): Promise<unknown> {
  return (await send(access, urlFor(access, request), request, options)).data;
}

/** A list. Follows the `next` links until it has `limit` items, or all items when `limit` is null. */
export async function callGithubList(
  access: GithubAccess,
  request: GithubRequest,
  limit: number | null,
  options: CallOptions,
): Promise<unknown[]> {
  const wanted = Math.min(limit ?? MAX_ITEMS, MAX_ITEMS);
  const items: unknown[] = [];
  let url: URL | null = urlFor(access, {
    ...request,
    query: { ...request.query, per_page: Math.min(PER_PAGE, wanted) },
  });
  while (url && items.length < wanted) {
    const page: { data: unknown; next: string | null } = await send(access, url, request, options);
    const found: unknown =
      request.itemsKey && typeof page.data === "object" && page.data !== null
        ? (page.data as Record<string, unknown>)[request.itemsKey]
        : page.data;
    if (Array.isArray(found)) items.push(...found);
    url = page.next ? new URL(page.next) : null;
  }
  return items.slice(0, wanted);
}
