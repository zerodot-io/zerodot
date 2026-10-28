// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { isVisible, type ShowRules, visibleCredentialTypes } from "./show-when";

const read = (values: Record<string, unknown>) => (key: string) => values[key];

test("no rules: the field shows", () => {
  assert.equal(isVisible({}, read({})), true);
});

test("showWhen: all keys must match one accepted value", () => {
  const rules = { showWhen: { resource: ["message"], operation: ["send", "edit"] } };
  assert.equal(isVisible(rules, read({ resource: "message", operation: "edit" })), true);
  assert.equal(isVisible(rules, read({ resource: "chat", operation: "edit" })), false);
});

test("showWhen list: one condition is enough", () => {
  const rules: ShowRules = { showWhen: [{ operation: ["a"] }, { mode: ["x"] }] };
  assert.equal(isVisible(rules, read({ operation: "b", mode: "x" })), true);
  assert.equal(isVisible(rules, read({ operation: "b", mode: "y" })), false);
});

test("hideWhen wins over showWhen", () => {
  const rules = { showWhen: { a: [1] }, hideWhen: { b: [true] } };
  assert.equal(isVisible(rules, read({ a: 1, b: false })), true);
  assert.equal(isVisible(rules, read({ a: 1, b: true })), false);
});

test("operator objects", () => {
  const ge = { showWhen: { v: [{ _cnd: { gte: 1.1 } }] } };
  assert.equal(isVisible(ge, read({ v: 1.2 })), true);
  assert.equal(isVisible(ge, read({ v: 1 })), false);
  const not = { showWhen: { v: [{ _cnd: { not: "x" } }] } };
  assert.equal(isVisible(not, read({ v: "y" })), true);
  assert.equal(isVisible(not, read({ v: "x" })), false);
  const exists = { showWhen: { v: [{ _cnd: { exists: true } }] } };
  assert.equal(isVisible(exists, read({ v: "" })), true);
  assert.equal(isVisible(exists, read({})), false);
  const between = { showWhen: { v: [{ _cnd: { between: { from: 2, to: 4 } } }] } };
  assert.equal(isVisible(between, read({ v: 3 })), true);
  assert.equal(isVisible(between, read({ v: 5 })), false);
  const text = { showWhen: { v: [{ _cnd: { startsWith: "ab" } }] } };
  assert.equal(isVisible(text, read({ v: "abc" })), true);
  const re = { showWhen: { v: [{ _cnd: { regex: "^a.c$" } }] } };
  assert.equal(isVisible(re, read({ v: "abc" })), true);
  assert.equal(isVisible(re, read({ v: "abd" })), false);
});

test("an array value matches when one item matches", () => {
  const rules = { showWhen: { tags: ["a"] } };
  assert.equal(isVisible(rules, read({ tags: ["b", "a"] })), true);
  assert.equal(isVisible(rules, read({ tags: ["b"] })), false);
});

test("visibleCredentialTypes: a type with no rule always applies", () => {
  const rules = {
    token: { showWhen: { authentication: ["accessToken"] } },
    oauth: { showWhen: { authentication: ["oAuth2"] } },
  };
  const types = ["token", "oauth", "other"];
  assert.deepEqual(visibleCredentialTypes(types, rules, read({ authentication: "oAuth2" })), [
    "oauth",
    "other",
  ]);
  assert.deepEqual(visibleCredentialTypes(types, rules, read({ authentication: "accessToken" })), [
    "token",
    "other",
  ]);
  assert.deepEqual(visibleCredentialTypes(types, undefined, read({})), types);
});
