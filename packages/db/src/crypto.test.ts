// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { open, parseSecretKey, seal } from "./crypto";

describe("crypto", () => {
  const key = randomBytes(32);

  it("round-trips a value", () => {
    const sealed = seal(key, { token: "abc", n: 1 }, "org1");
    assert.deepEqual(open(key, sealed, "org1"), { token: "abc", n: 1 });
  });

  it("gives a different result each time and hides the text", () => {
    const a = seal(key, { token: "supersecret" }, "org1");
    const b = seal(key, { token: "supersecret" }, "org1");
    assert.notDeepEqual(a, b);
    assert.equal(a.includes("supersecret"), false);
  });

  it("does not open with another key, owner, or after a change", () => {
    const sealed = seal(key, "x", "org1");
    assert.throws(() => open(randomBytes(32), sealed, "org1"), /Could not decrypt/);
    assert.throws(() => open(key, sealed, "org2"), /Could not decrypt/);
    const changed = Buffer.from(sealed);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    assert.throws(() => open(key, changed, "org1"), /Could not decrypt/);
  });

  it("checks the key format", () => {
    assert.equal(parseSecretKey(key.toString("base64")).length, 32);
    assert.throws(() => parseSecretKey("short"), /32 bytes/);
  });
});
