// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { helpersFor } from "./expression-helpers";

const labels = (value: unknown) => helpersFor(value).map((h) => h.label);

describe("helpersFor", () => {
  it("offers conversions for a number and a boolean", () => {
    assert.deepEqual(labels(12345), ["toString()", "toNumber()", "toBoolean()"]);
    assert.deepEqual(labels(true), ["toString()", "toNumber()", "toBoolean()"]);
  });

  it("offers includes for text and lists", () => {
    assert.deepEqual(labels("a"), ["toString()", "toNumber()", "toBoolean()", "includes("]);
    assert.deepEqual(labels([1]), ["toString()", "includes("]);
  });

  it("offers only toString for an object", () => {
    assert.deepEqual(labels({ a: 1 }), ["toString()"]);
  });

  it("offers the conversions when the value is not known", () => {
    assert.deepEqual(labels(undefined), ["toString()", "toNumber()", "toBoolean()"]);
  });
});
