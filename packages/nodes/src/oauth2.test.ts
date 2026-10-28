// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { oauth2ConfigOf } from "./credentials";
import {
  buildAuthorizeUrl,
  checkOAuth2Endpoint,
  exchangeAuthorizationCode,
  needsRefresh,
  OAuth2ReconnectError,
  pkceChallenge,
  refreshOAuth2Data,
} from "./oauth2";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");

const data = {
  clientId: "id",
  clientSecret: "s3cret",
  authUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAt: "2026-01-01T00:00:30.000Z",
};

type Call = { url: string; headers: Record<string, string>; body: URLSearchParams };

function fakeFetch(response: () => Response, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init?.headers as Record<string, string>,
      body: init?.body as URLSearchParams,
    });
    return response();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("needsRefresh", () => {
  it("is true without a token, and near the end of a token", () => {
    assert.equal(needsRefresh({}, NOW), true);
    assert.equal(
      needsRefresh({ accessToken: "a", expiresAt: "2026-01-01T00:00:59.000Z" }, NOW),
      true,
    );
    assert.equal(needsRefresh({ accessToken: "a", expiresAt: "bad" }, NOW), true);
  });

  it("is false for a fresh token, and for a token without an end", () => {
    assert.equal(
      needsRefresh({ accessToken: "a", expiresAt: "2026-01-01T00:05:00.000Z" }, NOW),
      false,
    );
    assert.equal(needsRefresh({ accessToken: "a" }, NOW), false);
  });
});

describe("refreshOAuth2Data", () => {
  it("sends the client with Basic auth and saves the new tokens", async () => {
    const calls: Call[] = [];
    const next = await refreshOAuth2Data("oauth2.generic", data, {
      now: NOW,
      fetch: fakeFetch(
        () =>
          json({
            access_token: "new-access",
            refresh_token: "new-refresh",
            expires_in: 3600,
            token_type: "Bearer",
            scope: "a b",
          }),
        calls,
      ),
    });
    assert.equal(calls[0]?.url, data.tokenUrl);
    assert.equal(
      calls[0]?.headers.authorization,
      `Basic ${Buffer.from("id:s3cret").toString("base64")}`,
    );
    assert.equal(calls[0]?.body.get("grant_type"), "refresh_token");
    assert.equal(calls[0]?.body.get("refresh_token"), "old-refresh");
    assert.equal(calls[0]?.body.get("client_secret"), null);
    assert.equal(next.accessToken, "new-access");
    assert.equal(next.refreshToken, "new-refresh");
    assert.equal(next.expiresAt, "2026-01-01T01:00:00.000Z");
    assert.equal(next.tokenType, "Bearer");
    assert.equal(next.grantedScope, "a b");
    assert.equal(next.clientSecret, "s3cret");
  });

  it("sends the client in the body when the credential says so", async () => {
    const calls: Call[] = [];
    await refreshOAuth2Data(
      "oauth2.generic",
      { ...data, authentication: "body" },
      { now: NOW, fetch: fakeFetch(() => json({ access_token: "x", expires_in: 60 }), calls) },
    );
    assert.equal(calls[0]?.headers.authorization, undefined);
    assert.equal(calls[0]?.body.get("client_id"), "id");
    assert.equal(calls[0]?.body.get("client_secret"), "s3cret");
  });

  it("keeps the old refresh token when the provider sends none", async () => {
    const next = await refreshOAuth2Data("oauth2.generic", data, {
      now: NOW,
      fetch: fakeFetch(() => json({ access_token: "x" })),
    });
    assert.equal(next.refreshToken, "old-refresh");
    assert.equal(next.expiresAt, undefined);
  });

  it("asks for a reconnect on invalid_grant, with a message that has no secret", async () => {
    await assert.rejects(
      refreshOAuth2Data("oauth2.generic", data, {
        fetch: fakeFetch(() =>
          json({ error: "invalid_grant", error_description: "old-refresh" }, 400),
        ),
      }),
      (error: Error) =>
        error instanceof OAuth2ReconnectError &&
        error.message.includes("invalid_grant") &&
        !error.message.includes("old-refresh"),
    );
  });

  it("asks for a reconnect when there is no refresh token", async () => {
    await assert.rejects(
      refreshOAuth2Data("oauth2.generic", { ...data, refreshToken: undefined }),
      OAuth2ReconnectError,
    );
  });

  it("does not ask for a reconnect for a server error, a 429, or a network error", async () => {
    for (const response of [() => json({}, 503), () => json({}, 429)]) {
      await assert.rejects(
        refreshOAuth2Data("oauth2.generic", data, { fetch: fakeFetch(response) }),
        (error: Error) => !(error instanceof OAuth2ReconnectError),
      );
    }
    await assert.rejects(
      refreshOAuth2Data("oauth2.generic", data, {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
      (error: Error) =>
        !(error instanceof OAuth2ReconnectError) && error.message.includes("TypeError"),
    );
  });

  it("rejects a response without an access token, and a type that is not OAuth2", async () => {
    await assert.rejects(
      refreshOAuth2Data("oauth2.generic", data, { fetch: fakeFetch(() => json({})) }),
      /access_token/,
    );
    await assert.rejects(refreshOAuth2Data("http.bearer", { token: "x" }), /not an OAuth2 type/);
  });
});

describe("authorize URL and code exchange", () => {
  const config = oauth2ConfigOf("oauth2.generic", { ...data, scope: "read write" });

  it("builds the authorize URL with state and PKCE", () => {
    assert.ok(config);
    const url = new URL(
      buildAuthorizeUrl(config, data, {
        redirectUri: "https://zerodot.example/oauth2/callback",
        state: "st",
        challenge: pkceChallenge("verifier"),
      }),
    );
    assert.equal(url.origin + url.pathname, "https://example.com/authorize");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("client_id"), "id");
    assert.equal(url.searchParams.get("redirect_uri"), "https://zerodot.example/oauth2/callback");
    assert.equal(url.searchParams.get("state"), "st");
    assert.equal(url.searchParams.get("scope"), "read write");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      url.searchParams.get("code_challenge"),
      "iMnq5o6zALKXGivsnlom_0F5_WYda32GHkxlV7mq7hQ",
    );
    assert.ok(!url.toString().includes("s3cret"));
  });

  it("does not let a preset query change the fixed parameters", () => {
    assert.ok(config);
    const url = new URL(
      buildAuthorizeUrl({ ...config, authQuery: { state: "evil", access_type: "offline" } }, data, {
        redirectUri: "https://zerodot.example/cb",
        state: "good",
      }),
    );
    assert.equal(url.searchParams.get("state"), "good");
    assert.equal(url.searchParams.get("access_type"), "offline");
  });

  it("trades the code for tokens with the verifier", async () => {
    const calls: Call[] = [];
    const next = await exchangeAuthorizationCode(
      "oauth2.generic",
      { ...data, accessToken: undefined, refreshToken: undefined, expiresAt: undefined },
      { code: "the-code", redirectUri: "https://zerodot.example/cb", verifier: "v" },
      {
        now: NOW,
        fetch: fakeFetch(
          () => json({ access_token: "a1", refresh_token: "r1", expires_in: 60 }),
          calls,
        ),
      },
    );
    assert.equal(calls[0]?.body.get("grant_type"), "authorization_code");
    assert.equal(calls[0]?.body.get("code"), "the-code");
    assert.equal(calls[0]?.body.get("redirect_uri"), "https://zerodot.example/cb");
    assert.equal(calls[0]?.body.get("code_verifier"), "v");
    assert.equal(next.accessToken, "a1");
    assert.equal(next.refreshToken, "r1");
    assert.equal(next.expiresAt, "2026-01-01T00:01:00.000Z");
  });

  it("checks endpoints", () => {
    assert.equal(checkOAuth2Endpoint("https://example.com/token"), null);
    assert.equal(checkOAuth2Endpoint("http://localhost:9000/token"), null);
    assert.match(String(checkOAuth2Endpoint("http://example.com/token")), /HTTPS/);
    assert.match(String(checkOAuth2Endpoint("javascript:alert(1)")), /HTTPS/);
    assert.match(String(checkOAuth2Endpoint("nope")), /not valid/);
  });
});
