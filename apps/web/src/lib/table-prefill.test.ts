// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { columnOptions, prefillRow } from "./table-prefill";

const email = { key: "email", unique: true };
const name = { key: "name", unique: false };
const plan = { key: "plan", unique: false };

describe("prefillRow", () => {
  it("adds every column with an empty value", () => {
    assert.deepEqual(prefillRow(undefined, [], [email, name]), { email: "", name: "" });
    assert.deepEqual(prefillRow({}, [], [email]), { email: "" });
  });

  it("keeps values and adds only the missing columns", () => {
    assert.deepEqual(prefillRow({ email: "a@b.c" }, [], [email, name]), {
      email: "a@b.c",
      name: "",
    });
  });

  it("drops empty keys of the old table when the table changes", () => {
    assert.deepEqual(prefillRow({ email: "", name: "x" }, [email, name], [plan]), {
      name: "x",
      plan: "",
    });
  });

  it("leaves a list of rows alone", () => {
    assert.equal(prefillRow([{ a: 1 }], [], [email]), undefined);
  });
});

describe("columnOptions", () => {
  it("lists unique columns, with id when allowed", () => {
    const columns = [email, name];
    assert.deepEqual(columnOptions(columns, "unique", true), ["id", "email"]);
    assert.deepEqual(columnOptions(columns, "unique", false), ["email"]);
    assert.deepEqual(columnOptions(columns, "all", false), ["email", "name"]);
  });
});
