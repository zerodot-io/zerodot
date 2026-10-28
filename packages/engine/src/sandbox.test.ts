// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSandboxClient, SandboxError } from "./sandbox";

const request = { code: "return 1", scope: {}, timeoutMs: 1000 };
const signal = new AbortController().signal;

type Reply = "ok" | "busy" | "bad-gateway" | "refused";

/** A fake fetch. `plan` decides the answer for each call, by host. */
function fakeFetch(plan: (host: string, call: number) => Reply) {
  const hosts: string[] = [];
  const impl: typeof fetch = async (input) => {
    const host = new URL(String(input)).host;
    hosts.push(host);
    const reply = plan(host, hosts.length);
    if (reply === "refused") throw new TypeError("fetch failed");
    if (reply === "busy") {
      return new Response("{}", { status: 503, headers: { "retry-after": "1" } });
    }
    if (reply === "bad-gateway") return new Response("", { status: 502 });
    return Response.json({ result: host });
  };
  return { impl, hosts };
}

function options(fetchImpl: typeof fetch, extra: Parameters<typeof createSandboxClient>[1] = {}) {
  const sleeps: number[] = [];
  return {
    sleeps,
    options: {
      fetch: fetchImpl,
      random: () => 1,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      ...extra,
    },
  };
}

describe("sandbox client", () => {
  it("takes turns between equal replicas from a comma list", async () => {
    const f = fakeFetch(() => "ok");
    const client = createSandboxClient("http://10.0.0.1:3002, http://10.0.0.2:3002/", {
      fetch: f.impl,
    });
    for (let i = 0; i < 4; i++) await client.run(request, signal);
    assert.deepEqual(f.hosts, ["10.0.0.1:3002", "10.0.0.2:3002", "10.0.0.1:3002", "10.0.0.2:3002"]);
  });

  it("sends new runs to the replica with the fewest runs in flight", async () => {
    const hosts: string[] = [];
    const release: (() => void)[] = [];
    const impl: typeof fetch = async (input) => {
      const host = new URL(String(input)).host;
      hosts.push(host);
      if (hosts.length === 1) await new Promise<void>((resolve) => release.push(resolve));
      return Response.json({ result: host });
    };
    const client = createSandboxClient("http://10.0.0.1:3002,http://10.0.0.2:3002", {
      fetch: impl,
    });
    const first = client.run(request, signal);
    await new Promise((resolve) => setImmediate(resolve));
    // The first replica holds a run. Both next runs go to the second one.
    await client.run(request, signal);
    await client.run(request, signal);
    assert.deepEqual(hosts, ["10.0.0.1:3002", "10.0.0.2:3002", "10.0.0.2:3002"]);
    release[0]?.();
    await first;
  });

  it("expands a host name with many addresses into replicas", async () => {
    const f = fakeFetch(() => "ok");
    const client = createSandboxClient("http://sandbox:3002", {
      fetch: f.impl,
      resolve: async () => ["172.18.0.2", "172.18.0.3", "172.18.0.4"],
    });
    for (let i = 0; i < 3; i++) await client.run(request, signal);
    assert.deepEqual(f.hosts, ["172.18.0.2:3002", "172.18.0.3:3002", "172.18.0.4:3002"]);
  });

  it("asks DNS again after the TTL and keeps old addresses when DNS fails", async () => {
    let time = 0;
    let calls = 0;
    let fail = false;
    const f = fakeFetch(() => "ok");
    const client = createSandboxClient("http://sandbox:3002", {
      fetch: f.impl,
      now: () => time,
      dnsTtlMs: 1000,
      resolve: async () => {
        calls++;
        if (fail) throw new Error("dns down");
        return [`10.0.0.${calls}`];
      },
    });
    await client.run(request, signal);
    await client.run(request, signal);
    assert.equal(calls, 1);
    time = 2000;
    await client.run(request, signal);
    assert.equal(calls, 2);
    fail = true;
    time = 4000;
    await client.run(request, signal);
    assert.deepEqual(f.hosts, ["10.0.0.1:3002", "10.0.0.1:3002", "10.0.0.2:3002", "10.0.0.2:3002"]);
  });

  it("does not resolve IP addresses, localhost, or HTTPS", async () => {
    let calls = 0;
    const f = fakeFetch(() => "ok");
    const resolve = async () => {
      calls++;
      return ["1.1.1.1"];
    };
    for (const url of ["http://127.0.0.1:1", "http://localhost:1", "https://sandbox:1"]) {
      await createSandboxClient(url, { fetch: f.impl, resolve }).run(request, signal);
    }
    assert.equal(calls, 0);
    assert.deepEqual(f.hosts, ["127.0.0.1:1", "localhost:1", "sandbox:1"]);
  });

  it("fails over to another replica when one refuses the connection", async () => {
    const f = fakeFetch((host) => (host === "10.0.0.1:3002" ? "refused" : "ok"));
    const { options: o } = options(f.impl);
    const client = createSandboxClient("http://10.0.0.1:3002,http://10.0.0.2:3002", o);
    assert.equal(await client.run(request, signal), "10.0.0.2:3002");
    // The dead replica rests. The next run goes straight to the live one.
    assert.equal(await client.run(request, signal), "10.0.0.2:3002");
    assert.deepEqual(f.hosts, ["10.0.0.1:3002", "10.0.0.2:3002", "10.0.0.2:3002"]);
  });

  it("fails over when a replica answers 503 or 502", async () => {
    for (const bad of ["busy", "bad-gateway"] as const) {
      const f = fakeFetch((host) => (host === "10.0.0.1:3002" ? bad : "ok"));
      const { options: o } = options(f.impl);
      const client = createSandboxClient("http://10.0.0.1:3002,http://10.0.0.2:3002", o);
      assert.equal(await client.run(request, signal), "10.0.0.2:3002");
    }
  });

  it("waits with jittered, growing, capped backoff and uses Retry-After as a floor", async () => {
    let calls = 0;
    const f = fakeFetch(() => (++calls < 5 ? "busy" : "ok"));
    const a = options(f.impl, { backoffBaseMs: 100, backoffMaxMs: 500, random: () => 0.5 });
    await createSandboxClient("http://10.0.0.1:3002", a.options).run(request, signal);
    // Retry-After is 1 s but the cap is 500 ms, so every wait is 500 ms.
    assert.deepEqual(a.sleeps, [500, 500, 500, 500]);

    calls = 10;
    const g = fakeFetch(() => (++calls < 14 ? "refused" : "ok"));
    const b = options(g.impl, { backoffBaseMs: 100, backoffMaxMs: 500, random: () => 0.5 });
    await createSandboxClient("http://10.0.0.1:3002", b.options).run(request, signal);
    assert.deepEqual(b.sleeps, [50, 100, 200]);
  });

  it("fails with a clear error when all replicas stay full (max attempts)", async () => {
    const f = fakeFetch(() => "busy");
    const { options: o } = options(f.impl, { maxAttempts: 3 });
    const client = createSandboxClient("http://10.0.0.1:3002,http://10.0.0.2:3002", o);
    await assert.rejects(client.run(request, signal), (error: unknown) => {
      assert.ok(error instanceof SandboxError);
      assert.match(error.message, /busy/);
      return true;
    });
    assert.equal(f.hosts.length, 3);
  });

  it("fails after the deadline instead of waiting more", async () => {
    let time = 0;
    const f = fakeFetch(() => "busy");
    const client = createSandboxClient("http://10.0.0.1:3002", {
      fetch: f.impl,
      now: () => time,
      random: () => 1,
      backoffBaseMs: 1000,
      backoffMaxMs: 1000,
      busyDeadlineMs: 2500,
      maxAttempts: 100,
      sleep: async (ms) => {
        time += ms;
      },
    });
    await assert.rejects(client.run(request, signal), /busy/);
    // Waits of 1 s: the third wait would pass 2.5 s, so the client stops after 3 tries.
    assert.equal(f.hosts.length, 3);
  });

  it("says not reachable when no replica connects", async () => {
    const f = fakeFetch(() => "refused");
    const { options: o } = options(f.impl, { maxAttempts: 2 });
    await assert.rejects(
      createSandboxClient("http://10.0.0.1:3002", o).run(request, signal),
      /not reachable/,
    );
  });

  it("does not retry a timeout or a code error", async () => {
    let calls = 0;
    const timeout: typeof fetch = async () => {
      calls++;
      throw new DOMException("timed out", "TimeoutError");
    };
    await assert.rejects(
      createSandboxClient("http://10.0.0.1:3002", options(timeout).options).run(request, signal),
      /did not answer in time/,
    );
    const codeError: typeof fetch = async () => {
      calls++;
      return Response.json({ error: { message: "nope" }, logs: [{ level: "log", message: "x" }] });
    };
    const seen: string[] = [];
    await assert.rejects(
      createSandboxClient("http://10.0.0.1:3002", options(codeError).options).run(
        request,
        signal,
        (logs) => seen.push(...logs.map((l) => l.message)),
      ),
      /nope/,
    );
    assert.equal(calls, 2);
    assert.deepEqual(seen, ["x"]);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => "refused");
    const client = createSandboxClient("http://10.0.0.1:3002", {
      fetch: f.impl,
      sleep: async () => controller.abort(new Error("cancelled")),
    });
    await assert.rejects(client.run(request, controller.signal), /cancelled/);
    assert.equal(f.hosts.length, 1);
  });

  it("rejects an empty URL list", () => {
    assert.throws(() => createSandboxClient(" , "), SandboxError);
  });
});
