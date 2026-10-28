// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { variableInputSchema } from "./variables";

const parse = (input: unknown) => variableInputSchema.safeParse(input);

describe("variableInputSchema", () => {
  it("accepts a value of the right type", () => {
    assert.equal(parse({ key: "baseUrl", type: "string", value: "x" }).success, true);
    assert.equal(parse({ key: "n", type: "number", value: 1.5 }).success, true);
    assert.equal(parse({ key: "flag", type: "boolean", value: false }).success, true);
    assert.equal(parse({ key: "cfg", type: "json", value: { a: [1, 2] } }).success, true);
  });
  it("rejects a wrong type, a bad key, and a big value", () => {
    assert.equal(parse({ key: "n", type: "number", value: "1" }).success, false);
    assert.equal(parse({ key: "1abc", type: "string", value: "x" }).success, false);
    assert.equal(parse({ key: "a-b", type: "string", value: "x" }).success, false);
    assert.equal(parse({ key: "a".repeat(65), type: "string", value: "x" }).success, false);
    assert.equal(parse({ key: "big", type: "string", value: "x".repeat(70_000) }).success, false);
  });
});
