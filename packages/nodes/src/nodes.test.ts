// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { graphSchema } from "@zerodot/engine";
import {
  credentialTypeCatalog,
  oauth2ConfigOf,
  registry,
  validateCredentialData,
  validateGraphNodes,
} from "./index";

const signal = new AbortController().signal;

function node(type: string) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  return definition;
}

afterEach(() => mock.restoreAll());

describe("trigger.webhook", () => {
  it("passes the request through", () => {
    const input = { method: "POST", body: { a: 1 } };
    const result = node("trigger.webhook").run({
      config: {},
      input,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual(result, { port: "out", data: input });
  });
});

describe("trigger.manual", () => {
  it("passes the input through", () => {
    const result = node("trigger.manual").run({
      config: {},
      input: { x: 1 },
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual(result, { port: "out", data: { x: 1 } });
  });
});

describe("logic.if", () => {
  it("picks true or false", () => {
    const run = (condition: unknown) =>
      node("logic.if").run({
        config: { condition },
        input: "in",
        credential: null,
        signal,
        scope: {},
        sandbox: null,
        tables: null,
      });
    assert.deepEqual(run(true), { port: "true", data: "in" });
    assert.deepEqual(run(0), { port: "false", data: "in" });
  });
});

describe("http.request", () => {
  it("calls fetch and parses JSON", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await node("http.request").run({
      config: {
        method: "POST",
        url: "https://api.example.com/x",
        sendBody: true,
        body: { a: 1 },
        timeoutMs: 1000,
      },
      input: null,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.equal(fetchMock.mock.callCount(), 1);
    const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
    assert.equal(init.method, "POST");
    assert.equal(init.body, '{"a":1}');
    assert.equal((init.headers as Headers).get("content-type"), "application/json");
    assert.deepEqual(result.data, { ok: 1 });
  });

  it("returns the full response when asked", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: 1 }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    const result = await node("http.request").run({
      config: {
        method: "GET",
        url: "https://api.example.com/x",
        timeoutMs: 1000,
        fullResponse: true,
      },
      input: null,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    const data = result.data as { body: unknown; status: number };
    assert.deepEqual(data.body, { ok: 1 });
    assert.equal(data.status, 201);
  });

  it("sends query and headers only when toggled on", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("ok"));
    const run = async (on: boolean) =>
      await node("http.request").run({
        config: {
          method: "GET",
          url: "https://api.example.com/x?a=1",
          sendQuery: on,
          query: { b: "2" },
          sendHeaders: on,
          headers: { "x-k": "v" },
          timeoutMs: 1000,
        },
        input: null,
        credential: null,
        signal,
        scope: {},
        sandbox: null,
        tables: null,
      });
    await run(true);
    await run(false);
    const [on, off] = fetchMock.mock.calls.map((c) => c.arguments as [URL, RequestInit]);
    assert.equal(String(on?.[0]), "https://api.example.com/x?a=1&b=2");
    assert.equal((on?.[1].headers as Headers).get("x-k"), "v");
    assert.equal(String(off?.[0]), "https://api.example.com/x?a=1");
    assert.equal((off?.[1].headers as Headers).get("x-k"), null);
  });

  it("fails on error status without fullResponse", async () => {
    mock.method(globalThis, "fetch", async () => new Response("nope", { status: 404 }));
    await assert.rejects(
      async () =>
        await node("http.request").run({
          config: { method: "GET", url: "https://api.example.com/x", timeoutMs: 1000 },
          input: null,
          credential: null,
          signal,
          scope: {},
          sandbox: null,
          tables: null,
        }),
      /status 404/,
    );
  });

  it("keeps text bodies as text", async () => {
    mock.method(globalThis, "fetch", async () => new Response("hello", { status: 500 }));
    const result = await node("http.request").run({
      config: {
        method: "GET",
        url: "https://api.example.com/x",
        timeoutMs: 1000,
        fullResponse: true,
      },
      input: null,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual(result.data, {
      status: 500,
      ok: false,
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: "hello",
    });
  });
});

describe("data.set", () => {
  const run = async (config: Record<string, unknown>, input: unknown) =>
    await node("data.set").run({
      config,
      input,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });

  it("adds fields to the input", async () => {
    assert.deepEqual(await run({ fields: { b: 2 }, keepInput: true }, { a: 1 }), {
      port: "out",
      data: { a: 1, b: 2 },
    });
  });
  it("can drop the input, and ignores a non-object input", async () => {
    assert.deepEqual((await run({ fields: { b: 2 }, keepInput: false }, { a: 1 })).data, { b: 2 });
    assert.deepEqual((await run({ fields: { b: 2 }, keepInput: true }, "text")).data, { b: 2 });
  });
});

describe("logic.switch", () => {
  const def = node("logic.switch");
  const run = async (value: unknown) =>
    await def.run({
      config: { value, cases: ["200", "404"] },
      input: "in",
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });

  it("matches a case by the text of the value, or goes to default", async () => {
    assert.equal((await run(200)).port, "200");
    assert.equal((await run("404")).port, "404");
    assert.equal((await run("500")).port, "default");
  });
  it("has one port for each case", () => {
    assert.deepEqual(def.outPorts?.({ cases: ["a", "b"] }), ["a", "b", "default"]);
    assert.deepEqual(def.outPorts?.({}), ["default"]);
  });
  it("rejects duplicate cases and the reserved name", () => {
    assert.equal(def.config.safeParse({ value: 1, cases: ["a", "a"] }).success, false);
    assert.equal(def.config.safeParse({ value: 1, cases: ["default"] }).success, false);
  });
});

describe("flow.noop", () => {
  it("passes the input on", async () => {
    const result = await node("flow.noop").run({
      config: {},
      input: { a: 1 },
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual(result, { port: "out", data: { a: 1 } });
  });
});

describe("flow.delay", () => {
  it("asks the engine to wait", async () => {
    const before = Date.now();
    const result = await node("flow.delay").run({
      config: { amount: 2, unit: "minutes" },
      input: { x: 1 },
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual((result as { data: unknown }).data, { x: 1 });
    const until = (result as { waitUntil?: number }).waitUntil ?? 0;
    assert.ok(until >= before + 120_000 && until <= Date.now() + 120_000);
  });
  it("limits the wait to 30 days", () => {
    const config = node("flow.delay").config;
    assert.equal(config.safeParse({ amount: 31, unit: "days" }).success, false);
    assert.equal(config.safeParse({ amount: 30, unit: "days" }).success, true);
  });
});

describe("trigger.cron", () => {
  it("passes the input through and checks the expression", async () => {
    const def = node("trigger.cron");
    const input = { scheduledAt: "2026-01-01T00:00:00.000Z", timezone: "UTC" };
    assert.deepEqual(
      await def.run({
        config: {},
        input,
        credential: null,
        signal,
        scope: {},
        sandbox: null,
        tables: null,
      }),
      {
        port: "out",
        data: input,
      },
    );
    assert.equal(
      def.config.safeParse({ expression: "*/5 * * * *", timezone: "Asia/Kolkata" }).success,
      true,
    );
    assert.equal(def.config.safeParse({ expression: "not a cron" }).success, false);
    assert.equal(
      def.config.safeParse({ expression: "* * * * *", timezone: "Mars/Base" }).success,
      false,
    );
  });
});

describe("http.request credentials", () => {
  const call = async (
    credential: { type: string; data: Record<string, unknown> },
    headers?: Record<string, string>,
  ) => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response("ok", { status: 200 }),
    );
    await node("http.request").run({
      config: {
        method: "GET",
        url: "https://api.example.com/x",
        sendHeaders: true,
        headers,
        timeoutMs: 1000,
      },
      input: null,
      credential,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit | undefined;
    return new Headers(init?.headers);
  };

  it("adds basic, bearer, and custom headers", async () => {
    const basic = await call({ type: "http.basic", data: { username: "ann", password: "pw" } });
    assert.equal(basic.get("authorization"), `Basic ${Buffer.from("ann:pw").toString("base64")}`);
    mock.restoreAll();
    const bearer = await call({ type: "http.bearer", data: { token: "t0k" } });
    assert.equal(bearer.get("authorization"), "Bearer t0k");
    mock.restoreAll();
    const custom = await call({ type: "http.header", data: { name: "X-Api-Key", value: "k" } });
    assert.equal(custom.get("x-api-key"), "k");
    mock.restoreAll();
    const oauth2 = await call({ type: "oauth2.generic", data: { accessToken: "at-1" } });
    assert.equal(oauth2.get("authorization"), "Bearer at-1");
    assert.ok(node("http.request").credentialTypes?.includes("oauth2.generic"));
  });

  it("keeps a header that the config sets", async () => {
    const headers = await call(
      { type: "http.bearer", data: { token: "from-credential" } },
      { Authorization: "Bearer from-config" },
    );
    assert.equal(headers.get("authorization"), "Bearer from-config");
  });
});

describe("validateCredentialData", () => {
  it("checks the fields of a type", () => {
    assert.equal(validateCredentialData("http.bearer", { token: "x" }), null);
    assert.match(String(validateCredentialData("http.bearer", {})), /token/);
    assert.match(
      String(validateCredentialData("http.header", { name: "bad name", value: "v" })),
      /name/,
    );
    assert.match(String(validateCredentialData("nope", {})), /Unknown credential type/);
    assert.equal(validateCredentialData("http.basic", { username: "a" }, { partial: true }), null);
    assert.match(String(validateCredentialData("http.bearer", { token: "x", extra: 1 })), /./);
  });
});

describe("oauth2.generic credential", () => {
  const base = {
    clientId: "id",
    clientSecret: "secret",
    authUrl: "https://example.com/authorize",
    tokenUrl: "https://example.com/token",
  };

  it("accepts the user fields and rejects token fields from a client", () => {
    assert.equal(validateCredentialData("oauth2.generic", base), null);
    assert.match(
      String(validateCredentialData("oauth2.generic", { ...base, accessToken: "t" })),
      /set by the server/,
    );
    assert.match(
      String(validateCredentialData("oauth2.generic", { accessToken: "t" }, { partial: true })),
      /set by the server/,
    );
  });

  it("accepts token fields from the server", () => {
    const data = { ...base, accessToken: "t", expiresAt: "2026-01-01T00:00:00.000Z" };
    assert.equal(validateCredentialData("oauth2.generic", data, { trusted: true }), null);
    assert.match(
      String(
        validateCredentialData("oauth2.generic", { ...base, expiresAt: "soon" }, { trusted: true }),
      ),
      /expiresAt/,
    );
  });

  it("checks the URLs", () => {
    assert.match(
      String(validateCredentialData("oauth2.generic", { ...base, tokenUrl: "nope" })),
      /tokenUrl/,
    );
  });

  it("builds the OAuth2 settings from the data", () => {
    assert.deepEqual(oauth2ConfigOf("oauth2.generic", { ...base, scope: "a  b" }), {
      authUrl: base.authUrl,
      tokenUrl: base.tokenUrl,
      scopes: ["a", "b"],
      authentication: "header",
      pkce: true,
    });
    assert.equal(
      oauth2ConfigOf("oauth2.generic", { ...base, authentication: "body" })?.authentication,
      "body",
    );
    assert.equal(oauth2ConfigOf("oauth2.generic", { clientId: "id" }), null);
    assert.equal(oauth2ConfigOf("http.bearer", { token: "x" }), null);
  });

  it("marks the catalog entry", () => {
    const entry = credentialTypeCatalog.find((t) => t.type === "oauth2.generic");
    assert.equal(entry?.oauth2, true);
    assert.ok(entry?.serverFields.includes("refreshToken"));
    assert.equal(credentialTypeCatalog.find((t) => t.type === "http.bearer")?.oauth2, false);
  });
});

describe("code.js", () => {
  const def = node("code.js");

  it("sends the code and the scope to the sandbox and returns the result", async () => {
    const calls: unknown[] = [];
    const result = await def.run({
      config: { code: "return $input.a;", timeoutMs: 500 },
      input: { a: 1 },
      credential: null,
      signal,
      scope: { $input: { a: 1 }, $vars: { v: 2 } },
      tables: null,
      sandbox: {
        run: async (request) => {
          calls.push(request);
          return { ok: true };
        },
      },
    });
    assert.deepEqual(result, { port: "out", data: { ok: true } });
    assert.deepEqual(calls, [
      { code: "return $input.a;", scope: { $input: { a: 1 }, $vars: { v: 2 } }, timeoutMs: 500 },
    ]);
  });

  it("fails clearly when there is no sandbox, and passes errors on", async () => {
    const base = {
      config: { code: "return 1;", timeoutMs: 500 },
      input: null,
      credential: null,
      signal,
      scope: {},
      tables: null,
    };
    await assert.rejects(async () => def.run({ ...base, sandbox: null }), /no SANDBOX_URL/);
    await assert.rejects(
      async () =>
        def.run({
          ...base,
          sandbox: {
            run: async () => {
              throw new Error("boom (line 2)");
            },
          },
        }),
      /boom \(line 2\)/,
    );
  });

  it("does not treat {{ }} in code as an expression", () => {
    assert.deepEqual(def.rawConfigKeys, ["code"]);
    assert.equal(
      (def.config as unknown as { shape: { code: { meta(): unknown } } }).shape.code.meta() !==
        undefined,
      true,
    );
  });
});

describe("validateGraphNodes", () => {
  const base = {
    position: { x: 0, y: 0 },
    credentialId: null,
    pinned: null,
    onError: "fail" as const,
  };
  const graph = (nodes: Record<string, unknown>[], edges: Record<string, unknown>[] = []) =>
    graphSchema.parse({ schema: 1, nodes: nodes.map((n) => ({ ...base, ...n })), edges });

  it("accepts a valid graph", () => {
    const problems = validateGraphNodes(
      graph(
        [
          { id: "a", type: "trigger.manual", name: "Start" },
          { id: "b", type: "logic.if", name: "Check", config: { condition: "{{ $input.ok }}" } },
        ],
        [{ id: "e", from: "a", fromPort: "out", to: "b", toPort: "in" }],
      ),
    );
    assert.deepEqual(problems, []);
  });

  it("names an unknown type, a bad config, and a bad port", () => {
    const problems = validateGraphNodes(
      graph(
        [
          { id: "a", type: "trigger.manual", name: "Start" },
          { id: "b", type: "nope.nope", name: "Bad" },
          { id: "c", type: "http.request", name: "Call", config: { method: "FETCH", url: "x" } },
        ],
        [{ id: "e", from: "a", fromPort: "yes", to: "c", toPort: "in" }],
      ),
    );
    assert.ok(problems.some((p) => p.includes('unknown node type "nope.nope"')));
    assert.ok(problems.some((p) => p.startsWith('"Call": config.method')));
    assert.ok(problems.some((p) => p.includes('no output port "yes"')));
  });

  it("skips values that are expressions", () => {
    const problems = validateGraphNodes(
      graph([
        {
          id: "a",
          type: "http.request",
          name: "Call",
          config: { method: "GET", url: "{{ $vars.baseUrl }}/x", timeoutMs: "{{ $vars.t }}" },
        },
      ]),
    );
    assert.deepEqual(problems, []);
  });
});

describe("mcp.call_tool", () => {
  async function fakeServer(
    tool: (args: { text: string }) => {
      content: { type: "text"; text: string }[];
      isError?: boolean;
    },
  ) {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { WebStandardStreamableHTTPServerTransport } = await import(
      "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
    );
    const { z } = await import("zod");
    const seen: Headers[] = [];
    // A new server for each request, like the zerodot server. No session.
    mock.method(globalThis, "fetch", async (input: string | URL, init?: RequestInit) => {
      const server = new McpServer({ name: "fake", version: "1" });
      server.registerTool(
        "echo",
        { description: "Echo", inputSchema: { text: z.string() } },
        async (args) => tool(args),
      );
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      const request = new Request(input as string, init);
      seen.push(request.headers);
      return transport.handleRequest(request);
    });
    return seen;
  }

  const run = (
    config: Record<string, unknown>,
    credential: { type: string; data: Record<string, unknown> } | null = null,
  ) =>
    node("mcp.call_tool").run({
      config,
      input: {},
      credential,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });

  it("calls a tool and parses a JSON answer", async () => {
    const seen = await fakeServer((args) => ({
      content: [{ type: "text", text: JSON.stringify({ echoed: args.text }) }],
    }));
    const result = await run(
      { url: "https://mcp.test/mcp", tool: "echo", arguments: { text: "hi" }, timeoutMs: 5000 },
      { type: "http.bearer", data: { token: "tok" } },
    );
    assert.deepEqual(result, {
      port: "out",
      data: {
        text: '{"echoed":"hi"}',
        data: { echoed: "hi" },
        content: [{ type: "text", text: '{"echoed":"hi"}' }],
      },
    });
    assert.ok(seen.every((h) => h.get("authorization") === "Bearer tok"));
  });

  it("fails the node when the tool reports an error", async () => {
    await fakeServer(() => ({ content: [{ type: "text", text: "no such user" }], isError: true }));
    await assert.rejects(
      async () =>
        run({
          url: "https://mcp.test/mcp",
          tool: "echo",
          arguments: { text: "x" },
          timeoutMs: 5000,
        }),
      /failed: no such user/,
    );
  });

  it("lists the tools with their JSON Schema", async () => {
    await fakeServer(() => ({ content: [] }));
    const { listMcpTools } = await import("./index");
    const tools = await listMcpTools({
      url: "https://mcp.test/mcp",
      credential: null,
      signal,
      timeoutMs: 5000,
    });
    const first = tools[0];
    assert.equal(first?.name, "echo");
    assert.deepEqual((first?.inputSchema as { required?: string[] } | undefined)?.required, [
      "text",
    ]);
  });
});

describe("trigger.http_poll", () => {
  const definition = registry.get("trigger.http_poll");
  const config = {
    url: "https://api.example.com/items",
    intervalSeconds: 300,
    itemsPath: "data.items",
    keyPath: "id",
    newestFirst: true,
    maxItems: 2,
  };
  const poll = (body: unknown, overrides = {}, credential = null as never) => {
    mock.method(globalThis, "fetch", async () => Response.json(body));
    if (!definition?.poll) throw new Error("not a poll node");
    return definition.poll({
      config: { ...config, ...overrides },
      credential,
      cursor: null,
      firstPoll: false,
      workflow: { id: "w", name: "W" },
      node: { id: "n", name: "N" },
      signal: new AbortController().signal,
    });
  };
  afterEach(() => mock.restoreAll());

  it("returns the newest items, oldest first", async () => {
    const result = await poll({ data: { items: [{ id: 3 }, { id: 2 }, { id: 1 }] } });
    assert.deepEqual(
      result?.items.map((i) => i.key),
      ["2", "3"],
    );
  });

  it("reads a list in the oldest-first order", async () => {
    const result = await poll(
      { data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }] } },
      { newestFirst: false },
    );
    assert.deepEqual(
      result?.items.map((i) => i.key),
      ["2", "3"],
    );
  });

  it("fails when the list or a key is missing", async () => {
    await assert.rejects(poll({ data: {} }), /No list/);
    await assert.rejects(poll({ data: { items: [{ name: "x" }] } }), /no key/);
  });

  it("is a poll trigger that passes the item through", async () => {
    assert.ok(definition?.poll);
    const out = await definition?.run({ input: { id: 1 } } as never);
    assert.deepEqual(out, { port: "out", data: { id: 1 } });
  });
});
