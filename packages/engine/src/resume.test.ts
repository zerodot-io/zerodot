// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resumeSignature, resumeUrl, verifyResumeSignature } from "./resume";

const key = Buffer.alloc(32, 7);

describe("resume signature", () => {
  it("is valid for the run and the node only", () => {
    const sig = resumeSignature(key, "run1", "node1");
    assert.equal(verifyResumeSignature(key, "run1", "node1", sig), true);
    assert.equal(verifyResumeSignature(key, "run2", "node1", sig), false);
    assert.equal(verifyResumeSignature(key, "run1", "node2", sig), false);
    assert.equal(verifyResumeSignature(Buffer.alloc(32, 8), "run1", "node1", sig), false);
    assert.equal(verifyResumeSignature(key, "run1", "node1", ""), false);
  });

  it("builds the address", () => {
    const url = resumeUrl("https://p.io/", key, "r", "a b");
    assert.ok(url.startsWith("https://p.io/resume/r/a%20b?sig="));
  });
});
