// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createSandboxClient } from "@zerodot/engine";
import { createGate, createSandboxServer, renderSandboxMetrics } from "./server";

describe("sandbox server", () => {
  const server = createSandboxServer({ maxConcurrency: 1, maxWaitMs: 200, maxBodyBytes: 10_000 });
  let base = "";
  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const post = (body: unknown) =>
    fetch(`${base}/run`, {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("answers health checks", async () => {
    const response = await fetch(`${base}/healthz`);
    assert.deepEqual(await response.json(), { ok: true, service: "sandbox" });
  });

  it("runs code through the client", async () => {
    const client = createSandboxClient(base);
    const signal = new AbortController().signal;
    assert.deepEqual(
      await client.run(
        { code: "return { n: $input.n * 2 };", scope: { $input: { n: 4 } }, timeoutMs: 1000 },
        signal,
      ),
      { n: 8 },
    );
    await assert.rejects(
      client.run({ code: "throw new Error('nope');", scope: {}, timeoutMs: 1000 }, signal),
      /nope/,
    );
  });

  it("checks the request", async () => {
    assert.equal((await post("not json")).status, 400);
    assert.equal((await post({ code: "", scope: {}, timeoutMs: 100 })).status, 400);
    assert.equal((await post({ code: "return 1", scope: {}, timeoutMs: 999_999 })).status, 400);
    assert.equal((await post({ code: "x".repeat(20_000), scope: {}, timeoutMs: 100 })).status, 413);
    assert.equal((await fetch(`${base}/other`)).status, 404);
  });

  it("answers 503 when it is busy for too long", async () => {
    const slow = post({ code: "while (true) {}", scope: {}, timeoutMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await post({ code: "return 1", scope: {}, timeoutMs: 100 });
    assert.equal(busy.status, 503);
    await slow;
    // With one try, the client maps 503 to a clear message.
    const client = createSandboxClient(base, { maxAttempts: 1 });
    const blocker = post({ code: "while (true) {}", scope: {}, timeoutMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      client.run({ code: "return 1", scope: {}, timeoutMs: 100 }, new AbortController().signal),
      /busy/,
    );
    await blocker;
  });

  it("the client waits and retries until the sandbox has a free place", async () => {
    const blocker = post({ code: "while (true) {}", scope: {}, timeoutMs: 300 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const client = createSandboxClient(base, { backoffBaseMs: 50, backoffMaxMs: 100 });
    assert.equal(
      await client.run(
        { code: "return 7", scope: {}, timeoutMs: 100 },
        new AbortController().signal,
      ),
      7,
    );
    await blocker;
  });

  it("the client reports an unreachable sandbox", async () => {
    const client = createSandboxClient("http://127.0.0.1:1");
    await assert.rejects(
      client.run({ code: "return 1", scope: {}, timeoutMs: 100 }, new AbortController().signal),
      /not reachable/,
    );
  });

  it("answers 503 with Retry-After and counts it in /metrics", async () => {
    const slow = post({ code: "while (true) {}", scope: {}, timeoutMs: 400 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await post({ code: "return 1", scope: {}, timeoutMs: 100 });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "1");
    const text = await (await fetch(`${base}/metrics`)).text();
    assert.match(text, /^zerodot_sandbox_active 1$/m);
    assert.match(text, /^zerodot_sandbox_max_concurrency 1$/m);
    assert.match(text, /^zerodot_sandbox_rejected_total [1-9]\d*$/m);
    await slow;
    assert.match(await (await fetch(`${base}/metrics`)).text(), /^zerodot_sandbox_active 0$/m);
  });
});

describe("gate", () => {
  it("answers at once when the wait is 0", async () => {
    const gate = createGate(1, 0, 5);
    assert.equal(await gate.enter(), true);
    const startedAt = Date.now();
    assert.equal(await gate.enter(), false);
    assert.ok(Date.now() - startedAt < 50);
    assert.deepEqual(gate.stats(), { running: 1, queued: 0, rejected: 1, started: 1 });
  });

  it("keeps the queue short: more callers than maxQueue get no at once", async () => {
    const gate = createGate(1, 5000, 2);
    assert.equal(await gate.enter(), true);
    const first = gate.enter();
    const second = gate.enter();
    assert.equal(gate.stats().queued, 2);
    assert.equal(await gate.enter(), false);
    gate.leave();
    assert.equal(await first, true);
    gate.leave();
    assert.equal(await second, true);
    gate.leave();
    assert.deepEqual(gate.stats(), { running: 0, queued: 0, rejected: 1, started: 3 });
  });

  it("lets a waiting caller go after maxWaitMs", async () => {
    const gate = createGate(1, 30, 1);
    await gate.enter();
    assert.equal(await gate.enter(), false);
    assert.equal(gate.stats().queued, 0);
  });

  it("renders Prometheus text", () => {
    const text = renderSandboxMetrics({ running: 2, queued: 1, rejected: 3, started: 9 }, 4);
    assert.match(text, /^zerodot_sandbox_active 2$/m);
    assert.match(text, /^zerodot_sandbox_queued 1$/m);
    assert.match(text, /^zerodot_sandbox_rejected_total 3$/m);
    assert.match(text, /^zerodot_sandbox_runs_total 9$/m);
  });
});
