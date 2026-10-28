// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { TableError } from "@zerodot/engine";
import { createDb, forOrganization } from "./index";
import { resetDatabase, seedOrganization } from "./testing";

const url = process.env.DATABASE_URL;

async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof TableError, `expected TableError, got ${String(error)}`);
    assert.match(error.message, pattern);
    return true;
  });
}

describe("data tables", { skip: !url }, () => {
  const handle = createDb(url ?? "postgres://unused");
  const { db } = handle;
  const a = () => forOrganization(db, "o1", { tableMaxRows: 50 });
  const b = () => forOrganization(db, "o2");

  before(async () => {
    await resetDatabase(handle);
    await seedOrganization(handle, "o1");
    await seedOrganization(handle, "o2");
  });
  after(() => handle.close());

  async function makeTable(name: string) {
    return a().tables.create({
      name,
      columns: [
        { key: "email", type: "string", unique: true },
        { key: "name", type: "string", required: true },
        { key: "score", type: "number", default: 0 },
        { key: "active", type: "boolean" },
        { key: "seenAt", type: "date" },
        { key: "meta", type: "json" },
      ],
    });
  }

  it("creates tables and isolates organizations", async () => {
    const t = await makeTable("people");
    assert.equal(t.columns.length, 6);
    assert.equal((await a().tables.list()).length, 1);
    assert.equal((await b().tables.list()).length, 0);
    assert.equal(await b().tables.get(t.id), null);
    await rejects(b().tables.queryRows(t.id, {}), /does not exist/);
    await assert.rejects(makeTable("people"), /exists/);
    assert.equal((await a().tables.get("people"))?.id, t.id);
  });

  it("inserts rows with defaults and null for a missing value", async () => {
    const t = await makeTable("insert_t");
    const [row] = await a().tables.insertRows(t.id, [{ name: "Ann", email: "ann@x.io" }]);
    assert.equal(row?.name, "Ann");
    assert.equal(row?.score, 0);
    assert.equal(row?.active, null);
    assert.match(String(row?.createdAt), /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.equal((await a().tables.get(t.id))?.rowCount, 1);
  });

  it("names the column and row number on a wrong value", async () => {
    const t = await makeTable("bad_t");
    await rejects(
      a().tables.insertRows(t.id, [{ name: "ok" }, { name: "x", score: "many" }]),
      /Row 2: Column "score" must be a number/,
    );
    await rejects(a().tables.insertRows(t.id, [{ score: 1 }]), /Column "name" is required/);
    assert.equal((await a().tables.get(t.id))?.rowCount, 0);
  });

  it("keeps unique columns unique and rolls back", async () => {
    const t = await makeTable("unique_t");
    await a().tables.insertRows(t.id, [{ name: "A", email: "a@x.io" }]);
    await rejects(
      a().tables.insertRows(t.id, [
        { name: "B", email: "b@x.io" },
        { name: "C", email: "a@x.io" },
      ]),
      /Column "email" must be unique/,
    );
    assert.equal((await a().tables.get(t.id))?.rowCount, 1);
    // Rows without a value do not clash.
    await a().tables.insertRows(t.id, [{ name: "N1" }, { name: "N2" }]);
    assert.equal((await a().tables.queryRows(t.id, {})).rows.length, 3);
  });

  it("enforces the row limit", async () => {
    const t = await makeTable("limit_t");
    await a().tables.insertRows(
      t.id,
      Array.from({ length: 50 }, (_, i) => ({ name: `n${i}` })),
    );
    await rejects(a().tables.insertRows(t.id, [{ name: "one more" }]), /can have 50 rows/);
    assert.equal((await a().tables.get(t.id))?.rowCount, 50);
  });

  describe("queries", () => {
    let id = "";
    before(async () => {
      const t = await makeTable("query_t");
      id = t.id;
      await a().tables.insertRows(id, [
        {
          name: "Ann",
          score: 10,
          active: true,
          email: "ann@x.io",
          seenAt: "2026-01-01",
          meta: { tags: ["a", "b"] },
        },
        { name: "Bob", score: 5, active: false, email: "bob@x.io", seenAt: "2026-02-01" },
        { name: "Cy", score: 7, email: "cy@y.io", meta: { tags: ["c"] } },
        { name: "Di", score: 1, active: true },
      ]);
    });
    const names = async (query: Parameters<ReturnType<typeof a>["tables"]["queryRows"]>[1]) =>
      (await a().tables.queryRows(id, query)).rows.map((r) => r.name);

    it("filters with the fixed operators", async () => {
      assert.deepEqual(await names({ filter: { field: "score", op: "gt", value: 5 } }), [
        "Ann",
        "Cy",
      ]);
      assert.deepEqual(await names({ filter: { field: "score", op: "lte", value: 5 } }), [
        "Bob",
        "Di",
      ]);
      assert.deepEqual(await names({ filter: { field: "name", op: "eq", value: "Bob" } }), ["Bob"]);
      assert.deepEqual(await names({ filter: { field: "name", op: "neq", value: "Bob" } }), [
        "Ann",
        "Cy",
        "Di",
      ]);
      assert.deepEqual(await names({ filter: { field: "name", op: "in", value: ["Ann", "Di"] } }), [
        "Ann",
        "Di",
      ]);
      assert.deepEqual(await names({ filter: { field: "email", op: "contains", value: "X.IO" } }), [
        "Ann",
        "Bob",
      ]);
      assert.deepEqual(await names({ filter: { field: "active", op: "isNull" } }), ["Cy"]);
      assert.deepEqual(await names({ filter: { field: "active", op: "isNull", value: false } }), [
        "Ann",
        "Bob",
        "Di",
      ]);
      assert.deepEqual(
        await names({ filter: { field: "seenAt", op: "gte", value: "2026-02-01" } }),
        ["Bob"],
      );
      assert.deepEqual(
        await names({ filter: { field: "meta", op: "contains", value: { tags: ["a"] } } }),
        ["Ann"],
      );
    });

    it("combines with and / or", async () => {
      const filter = {
        or: [
          {
            and: [
              { field: "active", op: "eq" as const, value: true },
              { field: "score", op: "gt" as const, value: 5 },
            ],
          },
          { field: "name", op: "eq" as const, value: "Cy" },
        ],
      };
      assert.deepEqual(await names({ filter }), ["Ann", "Cy"]);
    });

    it("treats a quote in a value as data", async () => {
      const filter = { field: "name", op: "eq" as const, value: "x' or '1'='1" };
      assert.deepEqual(await names({ filter }), []);
    });

    it("rejects an unknown column, a wrong value, and a bad operator", async () => {
      await rejects(
        names({ filter: { field: "nope", op: "eq", value: 1 } }),
        /Unknown column "nope"/,
      );
      await rejects(names({ filter: { field: "score", op: "eq", value: "x" } }), /"score".*number/);
      await rejects(names({ filter: { field: "active", op: "gt", value: true } }), /does not work/);
    });

    it("sorts and pages", async () => {
      assert.deepEqual(await names({ sort: [{ field: "score", direction: "desc" }] }), [
        "Ann",
        "Cy",
        "Bob",
        "Di",
      ]);
      const first = await a().tables.queryRows(id, {
        sort: [{ field: "score", direction: "asc" }],
        limit: 3,
      });
      assert.deepEqual(
        first.rows.map((r) => r.name),
        ["Di", "Bob", "Cy"],
      );
      assert.ok(first.nextCursor);
      const second = await a().tables.queryRows(id, {
        sort: [{ field: "score", direction: "asc" }],
        limit: 3,
        cursor: first.nextCursor,
      });
      assert.deepEqual(
        second.rows.map((r) => r.name),
        ["Ann"],
      );
      assert.equal(second.nextCursor, null);
    });

    it("pages with a keyset cursor in insert order", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<ReturnType<typeof a>["tables"]["queryRows"]>> =
          await a().tables.queryRows(id, { limit: 3, cursor });
        seen.push(...page.rows.map((r) => String(r.name)));
        cursor = page.nextCursor;
      } while (cursor);
      assert.deepEqual(seen, ["Ann", "Bob", "Cy", "Di"]);
    });

    it("gets a row by id or a unique column", async () => {
      const store = a().tables.store();
      const byEmail = await store.get(id, { field: "email", value: "bob@x.io" });
      assert.equal(byEmail?.name, "Bob");
      assert.equal((await store.get(id, { field: "id", value: byEmail?.id }))?.name, "Bob");
      assert.equal(await store.get(id, { field: "email", value: "none@x.io" }), null);
      await rejects(store.get(id, { field: "name", value: "Bob" }), /not unique/);
    });
  });

  describe("updates", () => {
    it("updates matching rows, and needs a filter or all", async () => {
      const t = await makeTable("update_t");
      await a().tables.insertRows(t.id, [
        { name: "A", score: 1 },
        { name: "B", score: 2 },
        { name: "C", score: 3 },
      ]);
      const store = a().tables.store();
      await rejects(store.update(t.id, { set: { score: 0 } }), /set all to true/);
      const result = await store.update(t.id, {
        filter: { field: "score", op: "gte", value: 2 },
        set: { active: true },
      });
      assert.equal(result.count, 2);
      assert.deepEqual(
        result.rows.map((r) => r.name),
        ["B", "C"],
      );
      const all = await store.update(t.id, { all: true, set: { score: 9 } });
      assert.equal(all.count, 3);
      assert.ok(result.rows[0] && all.rows[0] && all.rows[0].updatedAt >= result.rows[0].updatedAt);
    });

    it("clears a column with null, and keeps required columns", async () => {
      const t = await makeTable("clear_t");
      await a().tables.insertRows(t.id, [{ name: "A", active: true }]);
      const store = a().tables.store();
      const r = await store.update(t.id, { all: true, set: { active: null } });
      assert.equal(r.rows[0]?.active, null);
      await rejects(store.update(t.id, { all: true, set: { name: null } }), /required/);
    });

    it("increments in the database without losing counts", async () => {
      const t = await makeTable("incr_t");
      const [row] = await a().tables.insertRows(t.id, [{ name: "counter", score: 0 }]);
      const store = a().tables.store();
      await Promise.all(
        Array.from({ length: 25 }, () =>
          store.update(t.id, {
            filter: { field: "id", op: "eq", value: row?.id },
            increment: { score: 2 },
          }),
        ),
      );
      const got = await store.get(t.id, { field: "id", value: row?.id });
      assert.equal(got?.score, 50);
      await rejects(store.update(t.id, { all: true, increment: { name: 1 } }), /not a number/);
      await rejects(
        store.update(t.id, { all: true, set: { score: 1 }, increment: { score: 1 } }),
        /set and in increment/,
      );
    });

    it("changes a unique value for one row only", async () => {
      const t = await makeTable("uq_update_t");
      const rows = await a().tables.insertRows(t.id, [
        { name: "A", email: "a@x.io" },
        { name: "B", email: "b@x.io" },
      ]);
      const store = a().tables.store();
      await rejects(
        store.update(t.id, { all: true, set: { email: "z@x.io" } }),
        /must match one row/,
      );
      await rejects(
        store.update(t.id, {
          filter: { field: "id", op: "eq", value: rows[1]?.id },
          set: { email: "a@x.io" },
        }),
        /must be unique/,
      );
      await store.update(t.id, {
        filter: { field: "id", op: "eq", value: rows[0]?.id },
        set: { email: "new@x.io" },
      });
      assert.equal((await store.get(t.id, { field: "email", value: "new@x.io" }))?.name, "A");
      assert.equal(await store.get(t.id, { field: "email", value: "a@x.io" }), null);
      // The old value is free again.
      await store.insert(t.id, [{ name: "C", email: "a@x.io" }]);
    });

    it("rejects a row that grows over 64 KB", async () => {
      const t = await a().tables.create({ name: "big_t", columns: [{ key: "a", type: "string" }] });
      await a().tables.insertRows(t.id, [{ a: "x".repeat(40_000) }]);
      await rejects(
        a()
          .tables.store()
          .update(t.id, { all: true, set: { a: "y".repeat(70_000) } }),
        /64 KB/,
      );
    });
  });

  describe("upsert", () => {
    it("inserts, then updates on a match, and counts in parallel", async () => {
      const t = await makeTable("upsert_t");
      const store = a().tables.store("11111111-1111-4111-8111-111111111111");
      const first = await store.upsert(t.id, {
        column: "email",
        row: { email: "k@x.io", name: "K" },
        increment: { score: 1 },
      });
      assert.equal(first.created, true);
      assert.equal(first.row.score, 1);
      const second = await store.upsert(t.id, {
        column: "email",
        row: { email: "k@x.io" },
        increment: { score: 1 },
      });
      assert.equal(second.created, false);
      assert.equal(second.row.score, 2);
      assert.equal(second.row.id, first.row.id);
      await Promise.all(
        Array.from({ length: 10 }, () =>
          store.upsert(t.id, {
            column: "email",
            row: { email: "p@x.io", name: "P" },
            increment: { score: 1 },
          }),
        ),
      );
      assert.equal((await store.get(t.id, { field: "email", value: "p@x.io" }))?.score, 10);
      assert.equal((await a().tables.queryRows(t.id, {})).rows.length, 2);
    });

    it("needs a unique column with a value", async () => {
      const t = await makeTable("upsert_bad_t");
      const store = a().tables.store();
      await rejects(store.upsert(t.id, { column: "name", row: { name: "x" } }), /not unique/);
      await rejects(store.upsert(t.id, { column: "email", row: { name: "x" } }), /needs a value/);
    });
  });

  describe("delete", () => {
    it("deletes matching rows, keeps the count, and needs a filter or all", async () => {
      const t = await makeTable("delete_t");
      await a().tables.insertRows(t.id, [
        { name: "A", email: "a@x.io", score: 1 },
        { name: "B", email: "b@x.io", score: 2 },
      ]);
      const store = a().tables.store();
      await rejects(store.delete(t.id, {}), /set all to true/);
      const gone = await store.delete(t.id, { filter: { field: "score", op: "eq", value: 1 } });
      assert.equal(gone.count, 1);
      assert.equal((await a().tables.get(t.id))?.rowCount, 1);
      await store.insert(t.id, [{ name: "A2", email: "a@x.io" }]); // unique value is free
      assert.equal((await store.delete(t.id, { all: true })).count, 2);
      assert.equal((await a().tables.get(t.id))?.rowCount, 0);
    });

    it("removes a table with its rows", async () => {
      const t = await makeTable("drop_t");
      await a().tables.insertRows(t.id, [{ name: "A" }]);
      assert.equal(await b().tables.remove(t.id), false);
      assert.equal(await a().tables.remove(t.id), true);
      await rejects(a().tables.queryRows(t.id, {}), /does not exist/);
    });
  });

  describe("alter", () => {
    it("adds, renames, retypes, and drops columns", async () => {
      const t = await a().tables.create({
        name: "alter_t",
        columns: [
          { key: "k", type: "string", unique: true },
          { key: "n", type: "number" },
        ],
      });
      await a().tables.insertRows(t.id, [
        { k: "one", n: 1 },
        { k: "two", n: 2 },
      ]);

      await a().tables.alter(t.id, [
        { op: "add", column: { key: "flag", type: "boolean", required: true, default: false } },
      ]);
      let rows = (await a().tables.queryRows(t.id, {})).rows;
      assert.equal(rows[0]?.flag, false);
      await rejects(
        a().tables.alter(t.id, [
          { op: "add", column: { key: "need", type: "string", required: true } },
        ]),
        /needs a default/,
      );

      await a().tables.alter(t.id, [{ op: "rename", key: "k", to: "key" }]);
      rows = (await a().tables.queryRows(t.id, {})).rows;
      assert.equal(rows[0]?.key, "one");
      assert.equal(rows[0]?.k, undefined);
      // The unique index follows the rename.
      assert.equal((await a().tables.store().get(t.id, { field: "key", value: "two" }))?.n, 2);
      await rejects(
        a()
          .tables.store()
          .insert(t.id, [{ key: "two" }]),
        /Column "key" must be unique/,
      );

      await rejects(
        a().tables.alter(t.id, [{ op: "retype", key: "n", type: "boolean" }]),
        /does not fit/,
      );
      await a().tables.alter(t.id, [{ op: "retype", key: "n", type: "json" }]);
      assert.equal((await a().tables.get(t.id))?.columns.find((c) => c.key === "n")?.type, "json");

      await a().tables.alter(t.id, [{ op: "drop", key: "key" }]);
      rows = (await a().tables.queryRows(t.id, {})).rows;
      assert.equal(rows[0]?.key, undefined);
      assert.equal(rows[0]?.n, 1);
    });

    it("undoes all steps when one fails", async () => {
      const t = await a().tables.create({
        name: "alter_fail_t",
        columns: [{ key: "a", type: "string" }],
      });
      await rejects(
        a().tables.alter(t.id, [
          { op: "add", column: { key: "b", type: "string" } },
          { op: "rename", key: "nope", to: "c" },
        ]),
        /Unknown column/,
      );
      assert.deepEqual(
        (await a().tables.get(t.id))?.columns.map((c) => c.key),
        ["a"],
      );
    });
  });

  it("marks rows added by a run", async () => {
    const t = await a().tables.create({ name: "run_t", columns: [{ key: "a", type: "string" }] });
    const runId = "22222222-2222-4222-8222-222222222222";
    await a()
      .tables.store(runId)
      .insert(t.id, [{ a: "x" }]);
    const result = await db.execute(
      (await import("drizzle-orm"))
        .sql`select created_by_run_id from data_table_row where table_id = ${t.id}::uuid`,
    );
    assert.equal((Array.from(result)[0] as { created_by_run_id: string }).created_by_run_id, runId);
  });
});
