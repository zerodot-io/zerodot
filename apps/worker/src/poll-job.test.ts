// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluatePoll, pollRunKey } from "./poll-job";

const item = (key: string) => ({ key, data: { key } });
const returns =
  (keys: string[], cursor: unknown = null) =>
  async () => ({
    items: keys.map(item),
    cursor,
  });

describe("evaluatePoll", () => {
  it("starts no run on the first poll, but remembers the items", async () => {
    const out = await evaluatePoll(null, "h", returns(["a", "b"], 7));
    assert.deepEqual(out.fresh, []);
    assert.deepEqual(out.next, { cursor: 7, seenKeys: ["a", "b"], configHash: "h" });
  });

  it("starts a run for each item that was not seen", async () => {
    const previous = { cursor: 7, seenKeys: ["a", "b"], configHash: "h" };
    const out = await evaluatePoll(previous, "h", returns(["b", "c", "d"], 9));
    assert.deepEqual(
      out.fresh.map((i) => i.key),
      ["c", "d"],
    );
    assert.deepEqual(out.next.seenKeys, ["a", "b", "c", "d"]);
  });

  it("gives the old cursor back, and null on a first poll", async () => {
    const seen: unknown[] = [];
    const poll = async (state: { cursor: unknown; firstPoll: boolean }) => {
      seen.push(state);
      return { items: [], cursor: null };
    };
    await evaluatePoll({ cursor: 5, seenKeys: [], configHash: "h" }, "h", poll);
    await evaluatePoll({ cursor: 5, seenKeys: [], configHash: "old" }, "h", poll);
    assert.deepEqual(seen, [
      { cursor: 5, firstPoll: false },
      { cursor: null, firstPoll: true },
    ]);
  });

  it("treats a changed config as a first poll", async () => {
    const previous = { cursor: 1, seenKeys: ["a"], configHash: "old" };
    const out = await evaluatePoll(previous, "new", returns(["a", "b"]));
    assert.deepEqual(out.fresh, []);
    assert.deepEqual(out.next.seenKeys, ["a", "b"]);
  });

  it("skips a repeated key inside one poll", async () => {
    const previous = { cursor: null, seenKeys: [], configHash: "h" };
    const out = await evaluatePoll(previous, "h", returns(["a", "a"]));
    assert.equal(out.fresh.length, 1);
  });

  it("keeps the newest 500 keys", async () => {
    const keys = Array.from({ length: 600 }, (_, i) => `k${i}`);
    const out = await evaluatePoll(
      { cursor: null, seenKeys: [], configHash: "h" },
      "h",
      returns(keys),
    );
    assert.equal(out.next.seenKeys.length, 500);
    assert.equal(out.next.seenKeys.at(-1), "k599");
  });

  it("rejects a bad key and a too long list", async () => {
    const previous = { cursor: null, seenKeys: [], configHash: "h" };
    await assert.rejects(
      evaluatePoll(previous, "h", async () => ({ items: [{ key: "", data: 1 }], cursor: null })),
      /key/,
    );
    await assert.rejects(
      evaluatePoll(previous, "h", returns(Array.from({ length: 1001 }, (_, i) => `k${i}`))),
      /limit/,
    );
  });

  it("lets an error pass, so the caller keeps the old state", async () => {
    await assert.rejects(
      evaluatePoll(null, "h", async () => {
        throw new Error("down");
      }),
      /down/,
    );
  });
});

describe("pollRunKey", () => {
  it("shortens a long key", () => {
    assert.equal(pollRunKey("t", "a"), "poll:t:a");
    assert.ok(pollRunKey("t", "x".repeat(500)).length < 100);
  });
});
