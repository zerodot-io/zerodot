// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeldLimiter } from "./held-limit";
import { createTriggerCache } from "./trigger-cache";

describe("held request cap", () => {
  it("refuses over the cap and frees a slot on release", () => {
    const limiter = createHeldLimiter(2);
    const a = limiter.acquire();
    const b = limiter.acquire();
    assert.ok(a && b);
    assert.equal(limiter.acquire(), null);
    assert.equal(limiter.active, 2);
    a();
    assert.equal(limiter.active, 1);
    assert.ok(limiter.acquire());
  });

  it("ignores a second release", () => {
    const limiter = createHeldLimiter(1);
    const release = limiter.acquire();
    assert.ok(release);
    release();
    release();
    assert.equal(limiter.active, 0);
    const first = limiter.acquire();
    assert.ok(first);
    assert.equal(limiter.acquire(), null);
  });
});

describe("trigger cache", () => {
  const setup = (max = 100) => {
    let time = 0;
    let loads = 0;
    const cache = createTriggerCache<{ id: string }>({
      ttlMs: 5000,
      missTtlMs: 1000,
      maxEntries: max,
      now: () => time,
    });
    const load = (row: { id: string } | null) => () => {
      loads += 1;
      return Promise.resolve(row);
    };
    return {
      cache,
      load,
      advance: (ms: number) => {
        time += ms;
      },
      loads: () => loads,
    };
  };

  it("reads once inside the TTL and again after it", async () => {
    const t = setup();
    await t.cache.get("a", t.load({ id: "1" }));
    await t.cache.get("a", t.load({ id: "2" }));
    assert.equal(t.loads(), 1);
    t.advance(5001);
    assert.deepEqual(await t.cache.get("a", t.load({ id: "3" })), { id: "3" });
    assert.equal(t.loads(), 2);
  });

  it("keeps a missing token for a shorter time", async () => {
    const t = setup();
    assert.equal(await t.cache.get("a", t.load(null)), null);
    await Promise.resolve();
    t.advance(500);
    await t.cache.get("a", t.load({ id: "1" }));
    assert.equal(t.loads(), 1);
    t.advance(600);
    assert.deepEqual(await t.cache.get("a", t.load({ id: "1" })), { id: "1" });
    assert.equal(t.loads(), 2);
  });

  it("shares one lookup between calls at the same time", async () => {
    const t = setup();
    await Promise.all([
      t.cache.get("a", t.load({ id: "1" })),
      t.cache.get("a", t.load({ id: "1" })),
    ]);
    assert.equal(t.loads(), 1);
  });

  it("does not keep a failed lookup", async () => {
    const t = setup();
    await assert.rejects(t.cache.get("a", () => Promise.reject(new Error("db"))));
    assert.equal(t.cache.size, 0);
    assert.deepEqual(await t.cache.get("a", t.load({ id: "1" })), { id: "1" });
  });

  it("drops the oldest entries over the size cap", async () => {
    const t = setup(2);
    await t.cache.get("a", t.load({ id: "1" }));
    await t.cache.get("b", t.load({ id: "2" }));
    await t.cache.get("c", t.load({ id: "3" }));
    assert.equal(t.cache.size, 2);
    await t.cache.get("a", t.load({ id: "1" }));
    assert.equal(t.loads(), 4);
  });
});
