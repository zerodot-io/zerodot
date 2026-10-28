// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { type OAuth2Config, oauth2ConfigOf } from "./credentials";

/** A token is refreshed this long before it ends. */
export const REFRESH_WINDOW_MS = 60_000;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The provider refused the refresh token. The user must connect the account again. */
export class OAuth2ReconnectError extends Error {}

type FetchLike = typeof fetch;

type TokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** True when the credential has no token, or the token is near its end. */
export function needsRefresh(data: Record<string, unknown>, now: number): boolean {
  if (!str(data.accessToken)) return true;
  const expiresAt = str(data.expiresAt);
  if (!expiresAt) return false;
  const end = Date.parse(expiresAt);
  return Number.isNaN(end) || end - now <= REFRESH_WINDOW_MS;
}

/** The PKCE challenge (S256) of a verifier. */
export const pkceChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

/** A URL for an OAuth2 endpoint must use HTTPS. HTTP is for a server on this computer only. */
export function checkOAuth2Endpoint(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "The URL is not valid";
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && local)) return null;
  return "The URL must use HTTPS";
}

/** The URL where the user allows access. `state` and `challenge` come from the caller. */
export function buildAuthorizeUrl(
  config: OAuth2Config,
  data: Record<string, unknown>,
  options: { redirectUri: string; state: string; challenge?: string },
): string {
  const url = new URL(config.authUrl);
  const set = (key: string, value: string) => url.searchParams.set(key, value);
  // The caller values come last, so a preset cannot change them.
  for (const [key, value] of Object.entries(config.authQuery ?? {})) set(key, value);
  set("response_type", "code");
  set("client_id", str(data.clientId) ?? "");
  set("redirect_uri", options.redirectUri);
  set("state", options.state);
  if (config.scopes.length > 0) set("scope", config.scopes.join(" "));
  if (config.pkce && options.challenge) {
    set("code_challenge", options.challenge);
    set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** Sends a token request. Returns the parsed answer, or throws (see `refreshOAuth2Data`). */
async function requestTokens(
  config: OAuth2Config,
  data: Record<string, unknown>,
  params: Record<string, string>,
  fetchImpl: FetchLike | undefined,
): Promise<TokenResponse> {
  const clientId = str(data.clientId) ?? "";
  const clientSecret = str(data.clientSecret) ?? "";
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  };
  if (config.authentication === "header") {
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString("base64");
    headers.authorization = `Basic ${basic}`;
  } else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }

  const send = fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await send(config.tokenUrl, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `The token request failed: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  }

  let json: TokenResponse = {};
  try {
    json = (await response.json()) as TokenResponse;
  } catch {
    // The body is not JSON. The status code decides below.
  }
  const providerError = str(json.error);
  if (!response.ok || providerError) {
    // These codes mean the grant or the client is wrong, so the user must act.
    // A 5xx or a 429 can pass.
    const permanent = providerError
      ? ["invalid_grant", "invalid_client", "unauthorized_client"].includes(providerError)
      : response.status >= 400 && response.status < 500 && response.status !== 429;
    const message = `The token request was refused (${providerError ?? response.status})`;
    throw permanent ? new OAuth2ReconnectError(message) : new Error(message);
  }
  if (!str(json.access_token)) throw new Error("The token response has no access_token");
  return json;
}

/** The credential data with the tokens of a token response. */
function withTokens(
  data: Record<string, unknown>,
  json: TokenResponse,
  now: number,
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...data,
    accessToken: str(json.access_token),
    tokenType: str(json.token_type) ?? str(data.tokenType),
  };
  // Some providers send a new refresh token. When they do not, the old one stays.
  const newRefresh = str(json.refresh_token);
  if (newRefresh) next.refreshToken = newRefresh;
  const granted = str(json.scope);
  if (granted) next.grantedScope = granted;
  const expiresIn = Number(json.expires_in);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    next.expiresAt = new Date(now + expiresIn * 1000).toISOString();
  } else {
    delete next.expiresAt;
  }
  return next;
}

/**
 * Gets new tokens with the refresh token. Returns the new credential data (the old data plus the
 * new token fields). Throws `OAuth2ReconnectError` when the user must connect again, and a plain
 * `Error` for a problem that can pass (network, server error). Messages never hold token values.
 */
export async function refreshOAuth2Data(
  type: string,
  data: Record<string, unknown>,
  options: { now?: number; fetch?: FetchLike } = {},
): Promise<Record<string, unknown>> {
  const config = oauth2ConfigOf(type, data);
  if (!config) throw new Error(`The credential type "${type}" is not an OAuth2 type`);
  const refreshToken = str(data.refreshToken);
  if (!refreshToken) throw new OAuth2ReconnectError("The credential has no refresh token");
  const json = await requestTokens(
    config,
    data,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    options.fetch,
  );
  return withTokens(data, json, options.now ?? Date.now());
}

/** Trades the code from the callback for tokens. Returns the credential data with the tokens. */
export async function exchangeAuthorizationCode(
  type: string,
  data: Record<string, unknown>,
  input: { code: string; redirectUri: string; verifier?: string },
  options: { now?: number; fetch?: FetchLike } = {},
): Promise<Record<string, unknown>> {
  const config = oauth2ConfigOf(type, data);
  if (!config) throw new Error(`The credential type "${type}" is not an OAuth2 type`);
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
  };
  if (input.verifier) params.code_verifier = input.verifier;
  const json = await requestTokens(config, data, params, options.fetch);
  return withTokens(data, json, options.now ?? Date.now());
}
