// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { registry, validateGraphNodes } from "./index";

const signal = new AbortController().signal;

async function run(type: string, config: Record<string, unknown>, input: unknown = null) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  const result = await definition.run({
    config: definition.config.parse(config),
    input,
    credential: null,
    signal,
    scope: {},
    sandbox: null,
    tables: null,
  });
  return result.data;
}

const people = [
  { name: "a", age: 30, team: "x" },
  { name: "b", age: 10, team: "y" },
  { name: "c", age: 20, team: "x" },
  { name: "c", age: 20, team: "x" },
];

describe("data list nodes", () => {
  it("filter keeps items that match", async () => {
    const data = await run("data.filter", { list: people, condition: "{{ $item.age >= 20 }}" });
    assert.equal((data as unknown[]).length, 3);
  });

  it("limit keeps first or last", async () => {
    assert.deepEqual(await run("data.limit", { list: [1, 2, 3], max: 2 }), [1, 2]);
    assert.deepEqual(await run("data.limit", { list: [1, 2, 3], max: 2, keep: "last" }), [2, 3]);
  });

  it("sort orders by field", async () => {
    const data = (await run("data.sort", { list: people, field: "age", order: "descending" })) as {
      age: number;
    }[];
    assert.deepEqual(
      data.map((p) => p.age),
      [30, 20, 20, 10],
    );
  });

  it("removeDuplicates drops repeats", async () => {
    assert.equal(((await run("data.removeDuplicates", { list: people })) as unknown[]).length, 3);
    assert.equal(
      ((await run("data.removeDuplicates", { list: people, fields: ["team"] })) as unknown[])
        .length,
      2,
    );
  });

  it("aggregate collects fields", async () => {
    assert.deepEqual(await run("data.aggregate", { list: people, fields: ["name"] }), {
      name: ["a", "b", "c", "c"],
    });
  });

  it("summarize groups and counts", async () => {
    const data = await run("data.summarize", {
      list: people,
      groupBy: "team",
      summaries: [{ operation: "count" }, { operation: "sum", field: "age" }],
    });
    assert.deepEqual(data, [
      { team: "x", count: 3, sum_age: 70 },
      { team: "y", count: 1, sum_age: 10 },
    ]);
  });

  it("renameKeys renames in an object and in a list", async () => {
    assert.deepEqual(await run("data.renameKeys", { keys: { a: "b" } }, { a: 1 }), { b: 1 });
    assert.deepEqual(await run("data.renameKeys", { keys: { a: "b" } }, [{ a: 1 }]), [{ b: 1 }]);
  });

  it("replaceText replaces text in a field, in an object and in a list", async () => {
    const base = { field: "name", search: "a" };
    assert.deepEqual(
      await run("data.replaceText", { ...base, replacement: "b" }, { name: "banana", x: 1 }),
      { name: "bbnbnb", x: 1 },
    );
    assert.deepEqual(
      await run("data.replaceText", { ...base, replacement: "b", replaceAll: false }, [
        { name: "banana" },
      ]),
      [{ name: "bbnana" }],
    );
    assert.deepEqual(
      await run(
        "data.replaceText",
        { field: "a.b", search: "x", replacement: "y", outputField: "a.c" },
        { a: { b: "xx" } },
      ),
      { a: { b: "xx", c: "yy" } },
    );
  });

  it("replaceText treats text search as plain text and regex as a pattern", async () => {
    assert.equal(
      await run("data.replaceText", { search: "a.c", replacement: "$&!" }, "abc a.c"),
      "abc $&!",
    );
    assert.equal(
      await run(
        "data.replaceText",
        { search: "(\\d+)", regex: true, replacement: "<$1>" },
        "a12b3",
      ),
      "a<12>b<3>",
    );
    assert.equal(
      await run(
        "data.replaceText",
        { search: "HELLO", regex: true, flags: "i", replacement: "bye" },
        "hello",
      ),
      "bye",
    );
  });

  it("replaceText skips a missing field, fails on non-text, and checks the pattern", async () => {
    assert.deepEqual(await run("data.replaceText", { field: "n", search: "a" }, { x: 1 }), {
      x: 1,
    });
    await assert.rejects(
      run("data.replaceText", { field: "n", search: "a" }, { n: 5 }),
      /not text/,
    );
    const definition = registry.get("data.replaceText");
    assert.equal(definition?.config.safeParse({ search: "(", regex: true }).success, false);
    assert.equal(
      definition?.config.safeParse({ search: "a", regex: true, flags: "g" }).success,
      false,
    );
  });

  it("crypto hashes", async () => {
    const data = await run(
      "data.crypto",
      { action: "hash", value: "abc", outputField: "h" },
      { x: 1 },
    );
    assert.deepEqual(data, {
      x: 1,
      h: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });
});

describe("data.merge", () => {
  it("appends", async () => {
    assert.deepEqual(
      await run("data.merge", { mode: "append" }, { input1: [1], input2: [2] }),
      [1, 2],
    );
  });
  it("combines by field", async () => {
    const data = await run(
      "data.merge",
      { mode: "combineByField", field1: "id", field2: "id" },
      {
        input1: [
          { id: 1, a: 1 },
          { id: 2, a: 2 },
        ],
        input2: [{ id: 1, b: 9 }],
      },
    );
    assert.deepEqual(data, [{ id: 1, a: 1, b: 9 }]);
  });
  it("chooses a branch", async () => {
    assert.equal(
      await run("data.merge", { mode: "chooseBranch", output: "input2" }, { input2: 5 }),
      5,
    );
  });
  it("chooses nothing when the chosen branch was skipped", async () => {
    assert.equal(await run("data.merge", { mode: "chooseBranch" }, { input2: 5 }), null);
  });
  it("appends when one input is missing", async () => {
    assert.deepEqual(await run("data.merge", { mode: "append" }, { input2: [{ a: 1 }] }), [
      { a: 1 },
    ]);
  });
  it("combines by position and keeps the longer list", async () => {
    const data = await run(
      "data.merge",
      { mode: "combineByPosition" },
      { input1: [{ a: 1 }, { a: 2 }], input2: [{ b: 1 }] },
    );
    assert.deepEqual(data, [{ a: 1, b: 1 }, { a: 2 }]);
  });
  it("keeps items without a match with keepAll", async () => {
    const data = await run(
      "data.merge",
      { mode: "combineByField", field1: "id", field2: "id", join: "keepAll" },
      { input1: [{ id: 1 }, { id: 2 }], input2: [{ id: 1, b: 9 }] },
    );
    assert.deepEqual(data, [{ id: 1, b: 9 }, { id: 2 }]);
  });
  it("has a join flag and two inputs", () => {
    const definition = registry.get("data.merge");
    assert.equal(definition?.join, true);
    assert.deepEqual(definition?.ports.in, ["input1", "input2"]);
  });
});

describe("validateGraphNodes fan-in", () => {
  const n = (id: string, type: string) => ({
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    config: {},
    credentialId: null,
    pinned: null,
    onError: "fail" as const,
  });
  const e = (id: string, from: string, to: string, toPort: string) => ({
    id,
    from,
    fromPort: "out",
    to,
    toPort,
  });

  it("accepts fan-out and a merge with two inputs", () => {
    const problems = validateGraphNodes({
      schema: 1,
      nodes: [n("t", "trigger.manual"), n("a", "flow.noop"), n("m", "data.merge")],
      edges: [e("1", "t", "a", "in"), e("2", "a", "m", "input1"), e("3", "t", "m", "input2")],
    });
    assert.deepEqual(problems, []);
  });
  it("rejects a diamond into a node that is not a merge", () => {
    const problems = validateGraphNodes({
      schema: 1,
      nodes: [n("t", "trigger.manual"), n("a", "flow.noop"), n("b", "flow.noop")],
      edges: [e("1", "t", "a", "in"), e("2", "t", "b", "in"), e("3", "a", "b", "in")],
    });
    assert.equal(problems.length, 1);
  });
});

describe("data.dateTime", () => {
  it("adds, formats and diffs", async () => {
    assert.deepEqual(
      await run("data.dateTime", {
        action: "add",
        date: "2026-01-31T00:00:00Z",
        amount: 1,
        unit: "days",
      }),
      { result: "2026-02-01T00:00:00.000Z" },
    );
    assert.deepEqual(
      await run("data.dateTime", {
        action: "format",
        date: "2026-03-04T05:06:07Z",
        pattern: "DD/MM/YYYY HH:mm",
      }),
      { result: "04/03/2026 05:06" },
    );
    assert.deepEqual(
      await run("data.dateTime", {
        action: "difference",
        date: "2026-01-01T00:00:00Z",
        other: "2026-01-11T00:00:00Z",
        unit: "days",
      }),
      { result: 10 },
    );
  });
});
