// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUpdateCheck, isNewer, newestVersion, parseVersion } from "./update-check.server";

const tags = (...names: string[]) =>
  new Response(JSON.stringify(names.map((name) => ({ name }))), { status: 200 });

describe("update check", () => {
  it("reads versions and skips other tags", () => {
    assert.deepEqual(parseVersion("v0.2.1"), [0, 2, 1]);
    assert.equal(parseVersion("v1.0.0-rc1"), null);
    assert.equal(parseVersion("latest"), null);
  });

  it("picks the highest version by number, not by text", () => {
    assert.equal(newestVersion(["v0.9.0", "v0.10.0", "v0.2.1", "nightly"]), "0.10.0");
    assert.equal(newestVersion(["nightly"]), null);
  });

  it("compares versions", () => {
    assert.equal(isNewer("0.2.2", "0.2.1"), true);
    assert.equal(isNewer("0.2.1", "0.2.1"), false);
    assert.equal(isNewer("0.2.0", "0.2.1"), false);
    assert.equal(isNewer("0.2.2", "dev"), false);
  });

  it("answers the newer version and asks GitHub once a day", async () => {
    let calls = 0;
    let time = 0;
    const check = createUpdateCheck({
      fetcher: async () => {
        calls++;
        return tags("v0.2.2", "v0.2.1");
      },
      now: () => time,
    });
    assert.equal(await check("0.2.1"), "0.2.2");
    assert.equal(await check("0.2.2"), null);
    assert.equal(calls, 1);
    time = 25 * 60 * 60 * 1000;
    await check("0.2.1");
    assert.equal(calls, 2);
  });

  it("answers null on an error and waits an hour before the next try", async () => {
    let calls = 0;
    let time = 0;
    const check = createUpdateCheck({
      fetcher: async () => {
        calls++;
        throw new Error("offline");
      },
      now: () => time,
    });
    assert.equal(await check("0.2.1"), null);
    assert.equal(await check("0.2.1"), null);
    assert.equal(calls, 1);
    time = 61 * 60 * 1000;
    await check("0.2.1");
    assert.equal(calls, 2);
  });

  it("does not call GitHub when the check is off", async () => {
    let calls = 0;
    const check = createUpdateCheck({
      fetcher: async () => {
        calls++;
        return tags("v9.9.9");
      },
      enabled: () => false,
    });
    assert.equal(await check("0.2.1"), null);
    assert.equal(calls, 0);
  });
});
