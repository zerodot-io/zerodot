// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import flowRespond from "./flow-respond";
import triggerWebhook from "./trigger-webhook";
import { ipAllowed, isBot, originAllowed } from "./webhook-checks";

const receive = triggerWebhook.webhook?.receive;
if (!receive) throw new Error("the webhook node has no receive");

const ctx = (
  config: Record<string, unknown>,
  request: Partial<Parameters<typeof receive>[0]["request"]> = {},
  credential: { type: string; data: Record<string, unknown> } | null = null,
) => ({
  config,
  credential,
  url: "http://localhost/hooks/t",
  workflow: { id: "w", name: "" },
  node: { id: "n", name: "Webhook" },
  state: undefined,
  signal: AbortSignal.timeout(1000),
  request: {
    method: "POST",
    headers: {},
    query: {},
    body: { a: 1 },
    rawBody: '{"a":1}',
    ...request,
  },
});

describe("webhook checks", () => {
  it("matches addresses and ranges", () => {
    assert.equal(ipAllowed("10.1.2.3", "10.0.0.0/8"), true);
    assert.equal(ipAllowed("11.1.2.3", "10.0.0.0/8, 192.168.1.5"), false);
    assert.equal(ipAllowed("192.168.1.5", "10.0.0.0/8, 192.168.1.5"), true);
    assert.equal(ipAllowed("::ffff:10.1.2.3", "10.0.0.0/8"), true);
    assert.equal(ipAllowed(null, "10.0.0.0/8"), false);
  });

  it("matches origins, exact and with a subdomain wildcard", () => {
    const list = "https://app.example.com, https://*.example.org, http://*.dev.test:3000";
    assert.equal(originAllowed("https://app.example.com", list), "https://app.example.com");
    assert.equal(originAllowed("https://a.example.org", list), "https://a.example.org");
    assert.equal(originAllowed("https://a.b.example.org", list), "https://a.b.example.org");
    assert.equal(originAllowed("https://example.org", list), null);
    assert.equal(originAllowed("http://a.example.org", list), null);
    assert.equal(originAllowed("https://evilexample.org", list), null);
    assert.equal(originAllowed("https://a.example.org.evil.com", list), null);
    assert.equal(originAllowed("http://x.dev.test:3000", list), "http://x.dev.test:3000");
    assert.equal(originAllowed("http://x.dev.test:4000", list), null);
    assert.equal(originAllowed(null, list), null);
    assert.equal(originAllowed(null, "*"), "*");
  });

  it("finds bots", () => {
    assert.equal(isBot("Slackbot-LinkExpanding 1.0"), true);
    assert.equal(isBot("curl/8.7.1"), false);
    assert.equal(isBot(undefined), false);
  });
});

describe("trigger.webhook receive", () => {
  it("accepts a plain request", async () => {
    const verdict = await receive(ctx({}));
    assert.deepEqual(verdict, {
      verdict: "accept",
      input: { method: "POST", headers: {}, query: {}, body: { a: 1 } },
    });
  });

  it("checks basic auth", async () => {
    const credential = { type: "http.basic", data: { username: "ada", password: "pw" } };
    const good = `Basic ${Buffer.from("ada:pw").toString("base64")}`;
    const config = { authentication: "basic" };
    assert.equal(
      (await receive(ctx(config, { headers: { authorization: good } }, credential))).verdict,
      "accept",
    );
    const bad = await receive(
      ctx(config, { headers: { authorization: "Basic eA==" } }, credential),
    );
    assert.equal(bad.verdict, "forbidden");
    assert.equal(bad.verdict === "forbidden" ? bad.status : 0, 401);
    // No credential: closed.
    assert.equal(
      (await receive(ctx(config, { headers: { authorization: good } }))).verdict,
      "forbidden",
    );
  });

  it("checks header auth", async () => {
    const credential = { type: "http.header", data: { name: "X-Key", value: "s3" } };
    const config = { authentication: "header" };
    assert.equal(
      (await receive(ctx(config, { headers: { "x-key": "s3" } }, credential))).verdict,
      "accept",
    );
    assert.equal(
      (await receive(ctx(config, { headers: { "x-key": "no" } }, credential))).verdict,
      "forbidden",
    );
    // A credential of another type does not fit.
    const basic = { type: "http.basic", data: { username: "a", password: "b" } };
    assert.equal(
      (await receive(ctx(config, { headers: { "x-key": "s3" } }, basic))).verdict,
      "forbidden",
    );
  });

  it("checks the caller address", async () => {
    const config = { ipAllowlist: "10.0.0.0/8" };
    assert.equal((await receive(ctx(config, { ip: "10.2.3.4" }))).verdict, "accept");
    assert.equal((await receive(ctx(config, { ip: "8.8.8.8" }))).verdict, "forbidden");
    // The server does not know the address: closed.
    assert.equal((await receive(ctx(config, { ip: null }))).verdict, "forbidden");
  });

  it("ignores bots when asked", async () => {
    const request = { headers: { "user-agent": "facebookexternalhit/1.1" } };
    assert.equal((await receive(ctx({ ignoreBots: true }, request))).verdict, "ignore");
    assert.equal((await receive(ctx({}, request))).verdict, "accept");
  });

  it("gives the raw body", async () => {
    const verdict = await receive(ctx({ rawBody: true }));
    assert.equal(
      verdict.verdict === "accept" ? (verdict.input as { body: unknown }).body : null,
      '{"a":1}',
    );
  });

  it("runs only when the rule is true", async () => {
    const rule = "{{ $trigger.body.a === 1 }}";
    assert.equal((await receive(ctx({ onlyRunIf: rule }))).verdict, "accept");
    assert.equal(
      (await receive(ctx({ onlyRunIf: "{{ $trigger.body.a === 2 }}" }))).verdict,
      "ignore",
    );
    assert.equal((await receive(ctx({ onlyRunIf: "false" }))).verdict, "ignore");
  });
});

describe("flow.respond", () => {
  const run = (config: Record<string, unknown>, input: unknown) =>
    flowRespond.run({
      config: flowRespond.config.parse(config),
      input,
      credential: null,
      signal: AbortSignal.timeout(1000),
      scope: {},
      sandbox: null,
      tables: null,
    });

  it("answers with the input as JSON by default", async () => {
    const result = await run({}, { ok: true });
    assert.deepEqual(result.data, { ok: true });
    assert.deepEqual(result.respond, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"ok":true}',
    });
  });

  it("encodes a string body as JSON", async () => {
    const result = await run({}, "hi");
    assert.equal(result.respond?.body, '"hi"');
    assert.equal(result.respond?.headers["content-type"], "application/json");
  });

  it("answers with text, a code, and headers", async () => {
    const result = await run(
      { respondWith: "text", body: "hi", responseCode: 201, responseHeaders: { "x-a": "b" } },
      {},
    );
    assert.equal(result.respond?.status, 201);
    assert.equal(result.respond?.body, "hi");
    assert.equal(result.respond?.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(result.respond?.headers["x-a"], "b");
  });

  it("answers with no data", async () => {
    assert.equal((await run({ respondWith: "noData" }, { a: 1 })).respond?.body, null);
  });

  const jwt = (claims: Record<string, unknown>, secret = "s3cret", alg = "HS256") => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const body = `${enc({ alg, typ: "JWT" })}.${enc(claims)}`;
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const jwtCredential = { type: "jwt.auth", data: { algorithm: "HS256", secret: "s3cret" } };

  it("checks JWT auth", async () => {
    const config = { authentication: "jwt" };
    const send = (token?: string, credential: typeof jwtCredential | null = jwtCredential) =>
      receive(
        ctx(config, { headers: token ? { authorization: `Bearer ${token}` } : {} }, credential),
      );
    assert.equal((await send(jwt({ sub: "a" }))).verdict, "accept");
    assert.equal((await send(jwt({ sub: "a" }, "wrong"))).verdict, "forbidden");
    assert.equal((await send(jwt({ exp: 1 }))).verdict, "forbidden");
    assert.equal((await send(undefined)).verdict, "forbidden");
    assert.equal((await send(jwt({ sub: "a" }), null)).verdict, "forbidden");
    // The token header cannot pick another algorithm.
    assert.equal((await send(jwt({ sub: "a" }, "s3cret", "none"))).verdict, "forbidden");
  });

  it("saves the body as binary data", async () => {
    const verdict = await receive(
      ctx(
        { binaryProperty: "file" },
        { headers: { "content-type": "image/png; x=1" }, bodyBase64: "aGk=" },
      ),
    );
    assert.deepEqual(verdict, {
      verdict: "accept",
      input: {
        method: "POST",
        headers: { "content-type": "image/png; x=1" },
        query: {},
        body: {},
        binary: { file: { data: "aGk=", mimeType: "image/png" } },
      },
    });
  });
});
