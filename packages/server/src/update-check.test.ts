// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpdateCheck, isNewer, parseReleases, parseVersion } from "./update-check.server";

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: `Release ${tag}`,
  published_at: "2026-01-01T00:00:00Z",
  body: "- a change",
  ...extra,
});
const answer = (items: unknown[], headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(items), { status: 200, headers });

describe("update check", () => {
  it("reads versions and skips other tags", () => {
    assert.deepEqual(parseVersion("v0.2.1"), [0, 2, 1]);
    assert.equal(parseVersion("v1.0.0-rc1"), null);
    assert.equal(parseVersion("latest"), null);
  });

  it("compares versions by number, not by text", () => {
    assert.equal(isNewer("0.10.0", "0.9.0"), true);
    assert.equal(isNewer("0.2.1", "0.2.1"), false);
    assert.equal(isNewer("0.2.0", "0.2.1"), false);
    assert.equal(isNewer("0.2.2", "dev"), false);
  });

  it("skips drafts, pre-releases and tags that are not versions", () => {
    const list = parseReleases([
      release("v0.3.0"),
      release("v0.3.1", { draft: true }),
      release("v0.3.2", { prerelease: true }),
      release("nightly"),
      "junk",
    ]);
    assert.deepEqual(
      list.map((r) => r.version),
      ["0.3.0"],
    );
    assert.equal(list[0]?.url, "https://github.com/zerodot-io/zerodot/releases/tag/v0.3.0");
    assert.deepEqual(parseReleases({ message: "rate limit" }), []);
  });

  it("answers the newer releases, newest first, at most 10", async () => {
    const items = Array.from({ length: 14 }, (_, i) => release(`v0.3.${i}`));
    const check = createUpdateCheck({ fetcher: async () => answer(items) });
    const found = await check("0.2.4");
    assert.equal(found.length, 10);
    assert.equal(found[0]?.version, "0.3.13");
    assert.deepEqual(await check("0.3.13"), []);
  });

  it("asks GitHub once an hour and sends the ETag", async () => {
    const seen: (string | null)[] = [];
    let time = 0;
    const check = createUpdateCheck({
      fetcher: async (_url, init) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("if-none-match"));
        return seen.length === 1
          ? answer([release("v0.3.0")], { etag: '"abc"' })
          : new Response(null, { status: 304 });
      },
      now: () => time,
    });
    assert.equal((await check("0.2.4")).length, 1);
    assert.equal((await check("0.2.4")).length, 1);
    assert.equal(seen.length, 1);
    time = 61 * 60 * 1000;
    assert.equal((await check("0.2.4")).length, 1);
    assert.deepEqual(seen, [null, '"abc"']);
  });

  it("answers empty on an error or a rate limit and waits an hour", async () => {
    let calls = 0;
    let time = 0;
    const check = createUpdateCheck({
      fetcher: async () => {
        calls++;
        if (calls === 1) throw new Error("offline");
        return new Response("{}", { status: 403 });
      },
      now: () => time,
    });
    assert.deepEqual(await check("0.2.4"), []);
    assert.deepEqual(await check("0.2.4"), []);
    assert.equal(calls, 1);
    time = 61 * 60 * 1000;
    assert.deepEqual(await check("0.2.4"), []);
    assert.equal(calls, 2);
  });

  it("does not call GitHub when the check is off", async () => {
    let calls = 0;
    const check = createUpdateCheck({
      fetcher: async () => {
        calls++;
        return answer([release("v9.9.9")]);
      },
      enabled: () => false,
    });
    assert.deepEqual(await check("0.2.1"), []);
    assert.equal(calls, 0);
  });
});
