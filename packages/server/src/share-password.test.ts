// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashSharePassword, verifySharePassword } from "./share-password";

describe("share password", () => {
  it("accepts the right password only", async () => {
    const stored = await hashSharePassword("correct horse");
    assert.equal(await verifySharePassword("correct horse", stored), true);
    assert.equal(await verifySharePassword("wrong horse", stored), false);
    assert.equal(await verifySharePassword("correct horse", "bad"), false);
  });

  it("salts each hash", async () => {
    assert.notEqual(await hashSharePassword("same"), await hashSharePassword("same"));
  });
});
