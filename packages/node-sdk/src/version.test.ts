// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { satisfiesSdk } from "./version";

describe("satisfiesSdk", () => {
  it("allows the same major version, from the given version up", () => {
    assert.equal(satisfiesSdk("^1.4", "1.4.0"), true);
    assert.equal(satisfiesSdk("^1.4", "1.9.2"), true);
    assert.equal(satisfiesSdk("^1.4", "1.3.9"), false);
    assert.equal(satisfiesSdk("^1.4", "2.0.0"), false);
    assert.equal(satisfiesSdk("^1.4.2", "1.4.1"), false);
  });

  it("keeps major 0 to one minor version", () => {
    assert.equal(satisfiesSdk("^0.2", "0.2.5"), true);
    assert.equal(satisfiesSdk("^0.2", "0.3.0"), false);
  });

  it("accepts one exact version and rejects bad text", () => {
    assert.equal(satisfiesSdk("1.0.0", "1.0.0"), true);
    assert.equal(satisfiesSdk("1.0.0", "1.0.1"), false);
    assert.equal(satisfiesSdk(">=1", "1.0.0"), false);
    assert.equal(satisfiesSdk("^x", "1.0.0"), false);
  });
});
