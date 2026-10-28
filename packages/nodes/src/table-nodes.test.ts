// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TableRow, TableStore } from "@zerodot/engine";
import { catalog, registry } from "./index";

const signal = new AbortController().signal;
const row = (id: string): TableRow => ({ id, createdAt: "t", updatedAt: "t", name: id });

type Call = { method: string; args: unknown[] };

function fakeStore(calls: Call[]): TableStore {
  const record =
    <T>(method: string, result: T) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return result;
    };
  return {
    insert: record("insert", [row("a"), row("b")]),
    query: record("query", { rows: [row("a")], nextCursor: "next" }),
    get: record("get", null),
    update: record("update", { count: 3, rows: [row("a")] }),
    upsert: record("upsert", { row: row("a"), created: true }),
    delete: record("delete", { count: 2 }),
  } as TableStore;
}

function run(type: string, config: Record<string, unknown>, tables: TableStore | null) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  return definition.run({
    config: definition.config.parse(config),
    input: null,
    credential: null,
    signal,
    scope: {},
    sandbox: null,
    tables,
  });
}

describe("table nodes", () => {
  it("are in the catalog with a table picker", () => {
    for (const type of ["insert", "query", "get", "get_all", "update", "upsert", "delete"]) {
      const entry = catalog.find((n) => n.type === `table.${type}`);
      assert.ok(entry, type);
      const schema = entry.configSchema as { properties: Record<string, { ui?: string }> };
      assert.equal(schema.properties.table?.ui, "table");
    }
  });

  it("table.insert wraps one row in a list and returns the rows", async () => {
    const calls: Call[] = [];
    const result = await run("table.insert", { table: "t", rows: { name: "x" } }, fakeStore(calls));
    assert.deepEqual(calls[0], { method: "insert", args: ["t", [{ name: "x" }]] });
    assert.equal((result.data as { count: number }).count, 2);
    await run("table.insert", { table: "t", rows: [{ a: 1 }, { a: 2 }] }, fakeStore(calls));
    assert.deepEqual(calls[1]?.args[1], [{ a: 1 }, { a: 2 }]);
    await assert.rejects(
      async () => run("table.insert", { table: "t", rows: [1] }, fakeStore([])),
      /must be an object/,
    );
  });

  it("table.query passes filter, sort, limit, and cursor; an empty filter means none", async () => {
    const calls: Call[] = [];
    const filter = { and: [{ field: "a", op: "eq", value: 1 }] };
    const result = await run(
      "table.query",
      { table: "t", filter, sort: [{ field: "a" }], limit: 5, cursor: "c" },
      fakeStore(calls),
    );
    assert.deepEqual(calls[0]?.args[1], {
      filter,
      sort: [{ field: "a", direction: "asc" }],
      limit: 5,
      cursor: "c",
    });
    assert.deepEqual(result.data, { count: 1, rows: [row("a")], nextCursor: "next" });
    await run("table.query", { table: "t", filter: {} }, fakeStore(calls));
    assert.equal((calls[1]?.args[1] as { filter?: unknown } | undefined)?.filter, undefined);
    await assert.rejects(
      async () =>
        run("table.query", { table: "t", filter: { field: "a", op: "like" } }, fakeStore([])),
      /filter is not valid/,
    );
  });

  it("table.get_all reads every page, and honors limit, filter, and sort", async () => {
    const calls: Call[] = [];
    const pages = [
      { rows: [row("a"), row("b")], nextCursor: "c1" },
      { rows: [row("c")], nextCursor: null },
    ];
    const store = {
      query: async (...args: unknown[]) => {
        calls.push({ method: "query", args });
        return pages[calls.length - 1];
      },
    } as unknown as TableStore;
    const filter = { field: "a", op: "eq", value: 1 };
    const result = await run(
      "table.get_all",
      { table: "t", filter, sort: [{ field: "a", direction: "desc" }] },
      store,
    );
    assert.deepEqual(result.data, { count: 3, rows: [row("a"), row("b"), row("c")] });
    assert.equal(calls.length, 2);
    assert.equal((calls[1]?.args[1] as { cursor?: string }).cursor, "c1");
    assert.deepEqual((calls[0]?.args[1] as { sort?: unknown }).sort, [
      { field: "a", direction: "desc" },
    ]);

    const limited: Call[] = [];
    const two = {
      query: async (...args: unknown[]) => {
        limited.push({ method: "query", args });
        return { rows: [row("a"), row("b")], nextCursor: "more" };
      },
    } as unknown as TableStore;
    const part = await run("table.get_all", { table: "t", limit: 2 }, two);
    assert.equal((limited[0]?.args[1] as { limit: number }).limit, 2);
    assert.equal(limited.length, 1);
    assert.equal((part.data as { count: number }).count, 2);
  });

  it("table.get_all fails when the table has more rows than the cap", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => row(String(i)));
    const store = {
      query: async () => ({ rows: big, nextCursor: "more" }),
    } as unknown as TableStore;
    await assert.rejects(async () => run("table.get_all", { table: "t" }, store), /more than/);
    const capped = await run("table.get_all", { table: "t", limit: 1000 }, store);
    assert.equal((capped.data as { count: number }).count, 1000);
  });

  it("column fields and row fields ask the editor for table columns", () => {
    const props = (type: string) =>
      (
        catalog.find((n) => n.type === type)?.configSchema as {
          properties: Record<string, { ui?: string; prefill?: string; idOption?: boolean }>;
        }
      ).properties;
    assert.equal(props("table.get").by?.ui, "table-column");
    assert.equal(props("table.get").by?.idOption, true);
    assert.equal(props("table.upsert").column?.ui, "table-column");
    assert.equal(props("table.upsert").row?.prefill, "columns");
    assert.equal(props("table.insert").rows?.prefill, "columns");
  });

  it("table.get returns found false for a missing row", async () => {
    const result = await run("table.get", { table: "t", by: "email", value: "x" }, fakeStore([]));
    assert.deepEqual(result.data, { found: false, row: null });
    await assert.rejects(async () => run("table.get", { table: "t" }, fakeStore([])), /value/);
  });

  it("table.update, upsert, and delete pass their options", async () => {
    const calls: Call[] = [];
    const store = fakeStore(calls);
    await run("table.update", { table: "t", all: true, set: { a: 1 }, increment: { n: 2 } }, store);
    assert.deepEqual(calls[0]?.args[1], {
      filter: undefined,
      all: true,
      set: { a: 1 },
      increment: { n: 2 },
    });
    const upsert = await run(
      "table.upsert",
      { table: "t", column: "email", row: { email: "e" }, increment: { n: 1 } },
      store,
    );
    assert.deepEqual(calls[1]?.args[1], {
      column: "email",
      row: { email: "e" },
      increment: { n: 1 },
    });
    assert.equal((upsert.data as { created: boolean }).created, true);
    const del = await run(
      "table.delete",
      { table: "t", filter: { field: "a", op: "isNull" } },
      store,
    );
    assert.deepEqual(del.data, { count: 2 });
  });

  it("fail clearly without a table store, and reject an empty table", async () => {
    await assert.rejects(
      async () => run("table.delete", { table: "t", all: true }, null),
      /no table store/,
    );
    const definition = registry.get("table.query");
    assert.equal(definition?.config.safeParse({ table: "" }).success, false);
  });
});
