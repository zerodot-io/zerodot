// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import type { NodeDefinition } from "@zerodot/engine";
import { registry } from "../index";
import { githubConfig } from "./config";
import { buildRequest } from "./request";
import { githubSignature } from "./trigger";

const signal = new AbortController().signal;
type Cred = { type: string; data: Record<string, unknown> };
const token: Cred = { type: "github.token", data: { accessToken: "ghp_secret" } };

const def = (type: string): NodeDefinition => {
  const found = registry.get(type);
  if (!found) throw new Error(`no node ${type}`);
  return found;
};

type Call = { url: string; init: RequestInit };

/** Answers the calls in order. A string `link` is the `Link` header. */
function mockFetch(
  answers: { body?: unknown; status?: number; link?: string }[],
  calls: Call[] = [],
) {
  mock.method(globalThis, "fetch", async (url: URL | string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = answers[calls.length - 1] ?? {};
    return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: answer.link ? { link: answer.link } : undefined,
    });
  });
  return calls;
}

const run = async (type: string, config: Record<string, unknown>, credential: Cred = token) => {
  const definition = def(type);
  return await definition.run({
    config: definition.config.parse(config),
    input: null,
    credential,
    signal,
    scope: {},
    tables: null,
    sandbox: null,
  } as never);
};

afterEach(() => mock.restoreAll());

const base = { owner: "acme", repository: "app" };

describe("github config and request", () => {
  it("checks that the operation belongs to the resource", () => {
    assert.equal(
      githubConfig.safeParse({ ...base, resource: "issue", operation: "getAll" }).success,
      false,
    );
    assert.equal(
      githubConfig.safeParse({ ...base, resource: "release", operation: "getAll" }).success,
      true,
    );
  });

  it("builds the calls of issues", () => {
    const parse = (c: Record<string, unknown>) => githubConfig.parse({ ...base, ...c });
    assert.deepEqual(
      buildRequest(
        parse({
          resource: "issue",
          operation: "create",
          title: "T",
          labels: "a, b",
          assignees: "",
        }),
      ),
      { method: "POST", path: "/repos/acme/app/issues", body: { title: "T", labels: ["a", "b"] } },
    );
    assert.equal(
      buildRequest(parse({ resource: "issue", operation: "get", issueNumber: 7 })).path,
      "/repos/acme/app/issues/7",
    );
    assert.throws(
      () => buildRequest(parse({ resource: "issue", operation: "get" })),
      /issueNumber/,
    );
    assert.throws(() => buildRequest(parse({ resource: "issue", operation: "create" })), /title/);
  });

  it("escapes the parts of a path", () => {
    const request = buildRequest(
      githubConfig.parse({
        owner: "a b",
        repository: "r/x",
        resource: "file",
        operation: "get",
        filePath: "dir one/file #1.md",
      }),
    );
    assert.equal(request.path, "/repos/a%20b/r%2Fx/contents/dir%20one/file%20%231.md");
  });
});

describe("github node", () => {
  it("creates an issue with the token and the right headers", async () => {
    const calls = mockFetch([{ body: { number: 3, title: "T" } }]);
    const result = await run("github.api", {
      ...base,
      resource: "issue",
      operation: "create",
      title: "T",
      body: "text",
    });
    assert.deepEqual(result, { port: "out", data: { number: 3, title: "T" } });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/app/issues");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal(headers.authorization, "Bearer ghp_secret");
    assert.equal(headers["x-github-api-version"], "2022-11-28");
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { title: "T", body: "text" });
  });

  it("uses the server of GitHub Enterprise and the OAuth2 token", async () => {
    const calls = mockFetch([{ body: { id: 1 } }]);
    await run(
      "github.api",
      { ...base, authentication: "oAuth2", resource: "repository", operation: "get" },
      {
        type: "github.oauth2",
        data: { accessToken: "at", server: "https://ghe.example.com/api/v3/" },
      },
    );
    assert.equal(calls[0]?.url, "https://ghe.example.com/api/v3/repos/acme/app");
    assert.equal((calls[0]?.init.headers as Record<string, string>).authorization, "Bearer at");
  });

  it("follows pages until the limit", async () => {
    const calls = mockFetch([
      {
        body: [{ n: 1 }, { n: 2 }],
        link: '<https://api.github.com/repos/acme/app/issues?page=2>; rel="next"',
      },
      { body: [{ n: 3 }, { n: 4 }] },
    ]);
    const result = (await run("github.api", {
      ...base,
      resource: "repository",
      operation: "getIssues",
      limit: 3,
    })) as { data: unknown[] };
    assert.deepEqual(result.data, [{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.equal(calls.length, 2);
    assert.match(calls[0]?.url ?? "", /per_page=3/);
  });

  it("does not send the token to another host", async () => {
    const calls = mockFetch([
      { body: [{ n: 1 }], link: '<https://evil.example.com/steal>; rel="next"' },
    ]);
    await assert.rejects(
      run("github.api", { ...base, resource: "release", operation: "getAll", returnAll: true }),
      /another host/,
    );
    assert.equal(calls.length, 1);
  });

  it("reads the text of a file", async () => {
    mockFetch([
      { body: { sha: "s1", encoding: "base64", content: Buffer.from("hello").toString("base64") } },
    ]);
    const result = (await run("github.api", {
      ...base,
      resource: "file",
      operation: "get",
      filePath: "a.txt",
    })) as { data: { text: string } };
    assert.equal(result.data.text, "hello");
  });

  it("reads the SHA before it edits a file", async () => {
    const calls = mockFetch([{ body: { sha: "abc" } }, { body: { commit: { sha: "c1" } } }]);
    await run("github.api", {
      ...base,
      resource: "file",
      operation: "edit",
      filePath: "a.txt",
      fileContent: "new",
      commitMessage: "update",
    });
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(calls[1]?.init.method, "PUT");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
      message: "update",
      content: Buffer.from("new").toString("base64"),
      sha: "abc",
    });
  });

  it("reads the SHA before it deletes a file", async () => {
    const calls = mockFetch([{ body: { sha: "abc" } }, { body: { commit: { sha: "c1" } } }]);
    await run("github.api", {
      ...base,
      resource: "file",
      operation: "delete",
      filePath: "a.txt",
      commitMessage: "remove",
    });
    assert.equal(calls[1]?.init.method, "DELETE");
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { message: "remove", sha: "abc" });
  });

  it("builds release update and delete, and repository get", () => {
    const update = buildRequest(
      githubConfig.parse({
        ...base,
        resource: "release",
        operation: "update",
        releaseId: 7,
        draft: false,
      }),
    );
    assert.equal(update.method, "PATCH");
    assert.equal(update.path, "/repos/acme/app/releases/7");
    assert.deepEqual(update.body, { draft: false });
    const remove = buildRequest(
      githubConfig.parse({ ...base, resource: "release", operation: "delete", releaseId: 7 }),
    );
    assert.equal(remove.method, "DELETE");
    const repo = buildRequest(
      githubConfig.parse({ ...base, resource: "repository", operation: "get" }),
    );
    assert.equal(repo.path, "/repos/acme/app");
  });

  it("lists workflows from the workflows key, and dispatches one", async () => {
    mockFetch([{ body: { total_count: 1, workflows: [{ id: 1 }] } }]);
    const listed = await run("github.api", { ...base, resource: "workflow", operation: "list" });
    assert.deepEqual(listed, { port: "out", data: [{ id: 1 }] });
    const calls = mockFetch([{ status: 204 }]);
    const sent = await run("github.api", {
      ...base,
      resource: "workflow",
      operation: "dispatch",
      workflowId: "ci.yml",
      ref: "main",
      workflowInputs: '{"env":"prod"}',
    });
    assert.deepEqual(sent, { port: "out", data: { success: true } });
    assert.equal(
      calls[0]?.url,
      "https://api.github.com/repos/acme/app/actions/workflows/ci.yml/dispatches",
    );
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
      ref: "main",
      inputs: { env: "prod" },
    });
    assert.throws(() =>
      buildRequest(
        githubConfig.parse({
          ...base,
          resource: "workflow",
          operation: "dispatch",
          workflowId: "ci.yml",
          ref: "main",
          workflowInputs: "[1]",
        }),
      ),
    );
  });

  it("answers success for a lock, and shows the API message without the token", async () => {
    mockFetch([{ status: 204 }]);
    const locked = await run("github.api", {
      ...base,
      resource: "issue",
      operation: "lock",
      issueNumber: 1,
    });
    assert.deepEqual(locked, { port: "out", data: { success: true } });
    mockFetch([{ status: 404, body: { message: "Not Found" } }]);
    await assert.rejects(
      run("github.api", { ...base, resource: "issue", operation: "get", issueNumber: 1 }),
      (error: Error) => /Not Found/.test(error.message) && !error.message.includes("ghp_secret"),
    );
  });

  it("needs a GitHub credential, and says when OAuth2 is not connected", async () => {
    await assert.rejects(
      run(
        "github.api",
        { ...base, resource: "issue", operation: "get", issueNumber: 1 },
        {
          type: "http.bearer",
          data: { token: "x" },
        },
      ),
      /needs a GitHub credential/,
    );
    await assert.rejects(
      run("github.api", { ...base, resource: "issue", operation: "get", issueNumber: 1 }, {
        type: "github.oauth2",
        data: { clientId: "i" },
      } as never),
      /not connected/,
    );
  });

  it("picks the credential type from the Authentication field", () => {
    const definition = def("github.api");
    assert.deepEqual(definition.credentialTypes, ["github.token", "github.oauth2"]);
    assert.deepEqual(definition.credentialRules?.["github.oauth2"], {
      showWhen: { authentication: ["oAuth2"] },
    });
    assert.deepEqual(def("trigger.github").credentialRules, definition.credentialRules);
  });
});

describe("trigger.github", () => {
  const url = "https://zerodot.example/hooks/tok123";
  const config = { ...base, events: ["push", "issues"] };
  const receive = (body: unknown, headers: Record<string, string>, signed = true) => {
    const rawBody = JSON.stringify(body);
    return def("trigger.github").webhook?.receive({
      config,
      credential: null,
      url,
      workflow: { id: "w", name: "w" },
      node: { id: "n", name: "n" },
      state: null,
      signal,
      request: {
        method: "POST",
        headers: {
          ...(signed ? { "x-hub-signature-256": githubSignature(url, rawBody) } : {}),
          ...headers,
        },
        query: {},
        body,
        rawBody,
      },
    });
  };

  it("accepts a signed delivery of a wanted event", async () => {
    const verdict = await receive(
      { action: "opened", issue: { number: 1 } },
      { "x-github-event": "issues", "x-github-delivery": "d1" },
    );
    assert.deepEqual(verdict, {
      verdict: "accept",
      input: {
        event: "issues",
        action: "opened",
        delivery: "d1",
        body: { action: "opened", issue: { number: 1 } },
      },
    });
  });

  it("refuses a missing, wrong, or other-address signature", async () => {
    assert.deepEqual(await receive({}, { "x-github-event": "push" }, false), {
      verdict: "forbidden",
      status: 403,
    });
    assert.deepEqual(
      await receive({}, { "x-github-event": "push", "x-hub-signature-256": "sha256=00" }),
      { verdict: "forbidden", status: 403 },
    );
    const rawBody = "{}";
    const other = githubSignature("https://zerodot.example/hooks/other", rawBody);
    assert.deepEqual(
      await receive({}, { "x-github-event": "push", "x-hub-signature-256": other }),
      { verdict: "forbidden", status: 403 },
    );
  });

  it("answers a ping and skips events that the node did not ask for", async () => {
    const ping = await receive({ zen: "x" }, { "x-github-event": "ping" });
    assert.deepEqual(ping, { verdict: "ignore", response: { status: 200, body: { ok: true } } });
    assert.deepEqual(await receive({}, { "x-github-event": "fork" }), { verdict: "ignore" });
  });

  const context = (state: unknown = null) => ({
    config,
    credential: token,
    url,
    workflow: { id: "w", name: "w" },
    node: { id: "n", name: "n" },
    state,
    signal,
  });

  it("makes the webhook at GitHub with the signing secret", async () => {
    const calls = mockFetch([{ body: [] }, { body: { id: 99 } }]);
    const state = await def("trigger.github").webhook?.activate?.(context());
    assert.deepEqual(state, { hookId: 99 });
    assert.equal(calls[1]?.init.method, "POST");
    const body = JSON.parse(String(calls[1]?.init.body));
    assert.equal(body.config.url, url);
    assert.equal(body.config.content_type, "json");
    assert.deepEqual(body.events, ["push", "issues"]);
    // GitHub signs with this secret, and the receive side derives the same one.
    const raw = "{}";
    const { createHmac } = await import("node:crypto");
    const secret = body.config.secret as string;
    assert.equal(
      `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      githubSignature(url, raw),
    );
  });

  it("updates a webhook that has this address already", async () => {
    const calls = mockFetch([{ body: [{ id: 5, config: { url } }] }, { body: { id: 5 } }]);
    const state = await def("trigger.github").webhook?.activate?.(context());
    assert.deepEqual(state, { hookId: 5 });
    assert.equal(calls[1]?.init.method, "PATCH");
    assert.match(calls[1]?.url ?? "", /\/hooks\/5$/);
  });

  it("removes the webhook, and accepts one that is gone", async () => {
    const calls = mockFetch([{ status: 204 }]);
    await def("trigger.github").webhook?.deactivate?.(context({ hookId: 5 }));
    assert.equal(calls[0]?.init.method, "DELETE");
    mockFetch([{ status: 404, body: { message: "Not Found" } }]);
    assert.equal(await def("trigger.github").webhook?.deactivate?.(context({ hookId: 5 })), null);
    mockFetch([{ status: 500, body: { message: "boom" } }]);
    await assert.rejects(
      (async () => def("trigger.github").webhook?.deactivate?.(context({ hookId: 5 })))(),
      /500/,
    );
  });
});
