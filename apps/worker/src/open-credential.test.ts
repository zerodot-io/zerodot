// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createDb, forOrganization } from "@zerodot/db";
import { resetDatabase, seedOrganization } from "@zerodot/db/testing";
import { openCredential } from "@zerodot/nodes";

const databaseUrl = process.env.DATABASE_URL;
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

const base = {
  clientId: "id",
  clientSecret: "s3cret",
  authUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
};

describe("openCredential", { skip: !databaseUrl }, () => {
  const handle = createDb(databaseUrl ?? "postgres://unused");
  const secretKey = randomBytes(32);
  const scope = () => forOrganization(handle.db, "o1", { secretKey });
  let counter = 0;

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
  });
  after(() => handle.close());

  async function make(data: Record<string, unknown>) {
    counter += 1;
    return scope().credentials.create({ name: `c${counter}`, type: "oauth2.generic", data });
  }

  const tokenFetch = (calls: string[], delayMs = 0): typeof fetch =>
    (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      calls.push(String(body.get("refresh_token")));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

  it("returns a credential that is not OAuth2 as it is", async () => {
    const c = await scope().credentials.create({
      name: "bearer",
      type: "http.bearer",
      data: { token: "t" },
    });
    const opened = await openCredential(scope().credentials, c.id);
    assert.equal(opened?.data.token, "t");
  });

  it("returns null for a credential that does not exist", async () => {
    assert.equal(
      await openCredential(scope().credentials, "00000000-0000-4000-8000-000000000000"),
      null,
    );
  });

  it("does not call the provider for a fresh token", async () => {
    const c = await make({
      ...base,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-01-01T01:00:00.000Z",
    });
    const calls: string[] = [];
    const opened = await openCredential(scope().credentials, c.id, {
      now: () => NOW,
      fetch: tokenFetch(calls),
    });
    assert.equal(opened?.data.accessToken, "a");
    assert.equal(calls.length, 0);
  });

  it("refreshes an old token and saves the new data", async () => {
    const c = await make({
      ...base,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-01-01T00:00:10.000Z",
    });
    const calls: string[] = [];
    const opened = await openCredential(scope().credentials, c.id, {
      now: () => NOW,
      fetch: tokenFetch(calls),
    });
    assert.equal(opened?.data.accessToken, "new-access");
    assert.deepEqual(calls, ["r"]);
    const again = await scope().credentials.open(c.id);
    assert.equal(again?.data.accessToken, "new-access");
    assert.equal(again?.data.refreshToken, "new-refresh");
  });

  it("calls the provider once when five runs ask at the same time", async () => {
    const c = await make({
      ...base,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-01-01T00:00:10.000Z",
    });
    const calls: string[] = [];
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        openCredential(scope().credentials, c.id, { now: () => NOW, fetch: tokenFetch(calls, 50) }),
      ),
    );
    assert.deepEqual(calls, ["r"]);
    for (const result of results) assert.equal(result?.data.accessToken, "new-access");
  });

  it("marks the credential when the provider refuses the refresh token", async () => {
    const c = await make({
      ...base,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-01-01T00:00:10.000Z",
    });
    const refuse = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;
    await assert.rejects(
      openCredential(scope().credentials, c.id, { now: () => NOW, fetch: refuse }),
      /must be connected again/,
    );
    const listed = (await scope().credentials.list()).find((x) => x.id === c.id);
    assert.equal(listed?.status, "needs_reconnect");
    // The next call fails at once and does not call the provider.
    const calls: string[] = [];
    await assert.rejects(
      openCredential(scope().credentials, c.id, { now: () => NOW, fetch: tokenFetch(calls) }),
      /must be connected again/,
    );
    assert.equal(calls.length, 0);
  });

  it("keeps the data and the status after a network error", async () => {
    const c = await make({
      ...base,
      accessToken: "a",
      refreshToken: "r",
      expiresAt: "2026-01-01T00:00:10.000Z",
    });
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    await assert.rejects(
      openCredential(scope().credentials, c.id, { now: () => NOW, fetch: broken }),
      /token request failed/,
    );
    const listed = (await scope().credentials.list()).find((x) => x.id === c.id);
    assert.equal(listed?.status, "ok");
    assert.equal((await scope().credentials.open(c.id))?.data.accessToken, "a");
  });

  it("says so when the account was never connected", async () => {
    const c = await make(base);
    await assert.rejects(
      openCredential(scope().credentials, c.id, { now: () => NOW }),
      /not connected/,
    );
    const listed = (await scope().credentials.list()).find((x) => x.id === c.id);
    assert.equal(listed?.status, "ok");
  });
});
