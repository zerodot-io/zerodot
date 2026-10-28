// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Column, checkRow, columnsSchema, filterConditions, filterSchema } from "./tables";

const columns: Column[] = [
  { key: "name", type: "string", required: true, unique: false },
  { key: "count", type: "number", required: false, unique: false, default: 0 },
  { key: "at", type: "date", required: false, unique: false },
];

describe("checkRow", () => {
  it("fills defaults and normalizes dates", () => {
    const result = checkRow(columns, { name: "a", at: "2026-01-02" }, "insert");
    assert.deepEqual(result, {
      ok: true,
      data: { name: "a", count: 0, at: "2026-01-02T00:00:00.000Z" },
    });
  });

  it("names the column in a type error", () => {
    const result = checkRow(columns, { name: "a", count: "x" }, "insert");
    assert.deepEqual(result, { ok: false, message: 'Column "count" must be a number' });
  });

  it("needs required columns on insert, not on patch", () => {
    assert.equal(checkRow(columns, {}, "insert").ok, false);
    assert.deepEqual(checkRow(columns, { count: 2 }, "patch"), { ok: true, data: { count: 2 } });
  });

  it("keeps null in a patch and rejects it for a required column", () => {
    assert.deepEqual(checkRow(columns, { at: null }, "patch"), { ok: true, data: { at: null } });
    assert.equal(checkRow(columns, { name: null }, "patch").ok, false);
  });

  it("rejects unknown columns and big rows", () => {
    assert.deepEqual(checkRow(columns, { name: "a", nope: 1 }, "insert"), {
      ok: false,
      message: 'Unknown column "nope"',
    });
    const big = checkRow(columns, { name: "x".repeat(70_000) }, "insert");
    assert.equal(big.ok, false);
  });
});

describe("columnsSchema", () => {
  it("rejects reserved and repeated keys, and a unique json column", () => {
    assert.equal(columnsSchema.safeParse([{ key: "id", type: "string" }]).success, false);
    assert.equal(
      columnsSchema.safeParse([
        { key: "a", type: "string" },
        { key: "a", type: "number" },
      ]).success,
      false,
    );
    assert.equal(
      columnsSchema.safeParse([{ key: "a", type: "json", unique: true }]).success,
      false,
    );
    assert.equal(
      columnsSchema.safeParse([{ key: "a", type: "number", default: "x" }]).success,
      false,
    );
    assert.equal(columnsSchema.safeParse([{ key: "a", type: "number", default: 1 }]).success, true);
  });
});

describe("filters", () => {
  it("parses nested and/or and counts conditions", () => {
    const filter = filterSchema.parse({
      and: [{ field: "a", op: "eq", value: 1 }, { or: [{ field: "b", op: "isNull" }] }],
    });
    assert.equal(filterConditions(filter).length, 2);
  });

  it("rejects a filter that is too deep", () => {
    let filter: unknown = { field: "a", op: "eq", value: 1 };
    for (let i = 0; i < 5; i++) filter = { and: [filter] };
    assert.throws(() => filterConditions(filterSchema.parse(filter)));
  });

  it("rejects an unknown operator", () => {
    assert.equal(filterSchema.safeParse({ field: "a", op: "like", value: "x" }).success, false);
  });
});
