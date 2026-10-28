// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCredentialData } from "./credentials";
import { registry } from "./index";
import { buildQueries, type MysqlRunner, mysqlOptions, runQueries } from "./mysql";
import {
  addOrderBy,
  addWhere,
  buildInsert,
  buildUpdate,
  buildUpsert,
  qualifiedTable,
  quoteIdent,
  toMysqlParam,
} from "./mysql-sql";
import { readWhereClauses } from "./postgres-sql";

const parse = (value: Record<string, unknown>) => {
  const node = registry.get("mysql.database");
  assert.ok(node);
  return node.config.parse(value) as Parameters<typeof buildQueries>[0];
};

describe("mysqlOptions", () => {
  it("uses the usual defaults", () => {
    const options = mysqlOptions({ type: "mysql", data: { host: "db.x.io" } });
    assert.equal(options.port, 3306);
    assert.equal(options.ssl, undefined);
    assert.equal(options.password, undefined);
    assert.equal(options.connectTimeout, 10_000);
    assert.equal(options.decimalNumbers, false);
  });

  it("reads the login and SSL", () => {
    const data = { host: "h", user: "u", password: "p", database: "d", port: "3307", ssl: "true" };
    const options = mysqlOptions(
      { type: "mysql", data },
      { connectTimeout: 5, decimalNumbers: true },
    );
    assert.equal(options.port, 3307);
    assert.equal(options.user, "u");
    assert.equal(options.database, "d");
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    assert.equal(options.connectTimeout, 5000);
    assert.equal(options.decimalNumbers, true);
    assert.deepEqual(
      mysqlOptions({
        type: "mysql",
        data: { host: "h", ssl: "true", allowUnauthorizedCerts: "true" },
      }).ssl,
      { rejectUnauthorized: false },
    );
  });

  it("fails without a credential or a host", () => {
    assert.throws(() => mysqlOptions(null), /Pick a MySQL credential/);
    assert.throws(() => mysqlOptions({ type: "mysql", data: {} }), /no "host"/);
  });
});

describe("SQL builders", () => {
  it("quotes names with backticks", () => {
    assert.equal(quoteIdent("we`ird"), "`we``ird`");
    assert.equal(qualifiedTable("t", "d"), "`d`.`t`");
    assert.equal(qualifiedTable("t"), "`t`");
  });

  it("makes values for the driver", () => {
    assert.equal(toMysqlParam(true), 1);
    assert.equal(toMysqlParam({ a: 1 }), '{"a":1}');
    assert.equal(toMysqlParam(undefined), null);
    assert.equal(toMysqlParam(new Date("2024-01-02T03:04:05.678Z")), "2024-01-02 03:04:05.678");
  });

  it("adds where clauses with ? marks", () => {
    const clauses = readWhereClauses({
      values: [
        { column: "id", condition: ">", value: "5" },
        { column: "name", condition: "LIKE", value: "a%" },
        { column: "gone", condition: "IS NULL" },
      ],
    });
    const result = addWhere("SELECT * FROM `t`", clauses, [], "OR");
    assert.equal(
      result.query,
      "SELECT * FROM `t` WHERE `id` > ? OR `name` LIKE ? OR `gone` IS NULL",
    );
    assert.deepEqual(result.values, [5, "a%"]);
    assert.equal(
      addWhere(
        "D",
        readWhereClauses({ values: [{ column: "a", condition: "equal", value: "x" }] }),
        [],
        "AND",
      ).query,
      "D WHERE `a` = ?",
    );
  });

  it("adds sort rules", () => {
    assert.equal(
      addOrderBy("Q", [{ column: "a", direction: "DESC" }, { column: "b" }]),
      "Q ORDER BY `a` DESC, `b` ASC",
    );
  });

  it("builds insert, upsert, and update", () => {
    assert.deepEqual(buildInsert("`t`", { a: 1, b: "x" }), {
      query: "INSERT INTO `t` (`a`, `b`) VALUES (?, ?)",
      values: [1, "x"],
    });
    assert.equal(
      buildInsert("`t`", { a: 1 }, { ignore: true }).query,
      "INSERT IGNORE INTO `t` (`a`) VALUES (?)",
    );
    assert.deepEqual(buildUpsert("`t`", { id: 1, n: "x" }), {
      query:
        "INSERT INTO `t` (`id`, `n`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `id` = VALUES(`id`), `n` = VALUES(`n`)",
      values: [1, "x"],
    });
    assert.deepEqual(buildUpdate("`t`", { id: 1, n: "x" }, ["id"]), {
      query: "UPDATE `t` SET `n` = ? WHERE `id` = ?",
      values: ["x", 1],
    });
  });

  it("checks the update input", () => {
    assert.throws(() => buildUpdate("`t`", { a: 1 }, []), /match on/);
    assert.throws(() => buildUpdate("`t`", { a: 1 }, ["id"]), /no value for the match column "id"/);
    assert.throws(() => buildUpdate("`t`", { id: 1 }, ["id"]), /Add values to update/);
    assert.throws(() => buildUpsert("`t`", {}), /no values/);
  });
});

describe("buildQueries", () => {
  const items = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
  ];

  it("makes one query for each item", () => {
    const queries = buildQueries(
      parse({ operation: "insert", table: "t", database: "d" }),
      items,
      {},
    );
    assert.equal(queries.length, 2);
    assert.equal(queries[1]?.query, "INSERT INTO `d`.`t` (`id`, `name`) VALUES (?, ?)");
    assert.deepEqual(queries[1]?.values, [2, "b"]);
  });

  it("maps columns by hand", () => {
    const cfg = parse({
      operation: "insert",
      table: "t",
      dataMode: "defineBelow",
      columns: { who: "{{ $item.name }}" },
    });
    const queries = buildQueries(cfg, items, {});
    assert.equal(queries[0]?.query, "INSERT INTO `t` (`who`) VALUES (?)");
    assert.deepEqual(queries[0]?.values, ["a"]);
  });

  it("builds update and upsert", () => {
    const update = buildQueries(
      parse({ operation: "update", table: "t", matchingColumns: ["id"] }),
      items,
      {},
    );
    assert.equal(update[0]?.query, "UPDATE `t` SET `name` = ? WHERE `id` = ?");
    const upsert = buildQueries(parse({ operation: "upsert", table: "t" }), items, {});
    assert.match(upsert[0]?.query ?? "", /ON DUPLICATE KEY UPDATE/);
  });

  it("selects with conditions, sort, and limit", () => {
    const cfg = parse({
      operation: "select",
      table: "t",
      limit: 5,
      where: { values: [{ column: "id", condition: ">=", value: "2" }] },
      sort: { values: [{ column: "id", direction: "DESC" }] },
    });
    const [query] = buildQueries(cfg, [{}], {});
    assert.equal(query?.query, "SELECT * FROM `t` WHERE `id` >= ? ORDER BY `id` DESC LIMIT ?");
    assert.deepEqual(query?.values, [2, 5]);
    const all = buildQueries(parse({ operation: "select", table: "t", returnAll: true }), [{}], {});
    assert.equal(all[0]?.query, "SELECT * FROM `t`");
  });

  it("deletes, truncates, and drops, and never deletes all rows by accident", () => {
    const where = { values: [{ column: "id", condition: "equal", value: "1" }] };
    assert.equal(
      buildQueries(
        parse({ operation: "deleteTable", table: "t", deleteCommand: "delete", where }),
        [{}],
        {},
      )[0]?.query,
      "DELETE FROM `t` WHERE `id` = ?",
    );
    assert.throws(
      () =>
        buildQueries(
          parse({ operation: "deleteTable", table: "t", deleteCommand: "delete" }),
          [{}],
          {},
        ),
      /at least one condition/,
    );
    assert.equal(
      buildQueries(
        parse({ operation: "deleteTable", table: "t", deleteCommand: "truncate" }),
        [{}],
        {},
      )[0]?.query,
      "TRUNCATE TABLE `t`",
    );
    assert.equal(
      buildQueries(
        parse({ operation: "deleteTable", table: "t", deleteCommand: "drop" }),
        [{}],
        {},
      )[0]?.query,
      "DROP TABLE IF EXISTS `t`",
    );
  });

  it("runs a query with parameters for each item", () => {
    const cfg = parse({
      operation: "executeQuery",
      query: "SELECT * FROM t WHERE id = ? AND n = ?",
      queryReplacement: "={{ $item.id }},x",
    });
    const queries = buildQueries(cfg, [{ id: 7 }], {});
    assert.equal(queries[0]?.query, "SELECT * FROM t WHERE id = ? AND n = ?");
    assert.ok(queries[0]?.values.length);
  });

  it("asks for a query or a table", () => {
    assert.throws(
      () => buildQueries(parse({ operation: "executeQuery" }), [{}], {}),
      /Write a query/,
    );
    assert.throws(() => buildQueries(parse({ operation: "select" }), [{}], {}), /Pick a table/);
  });
});

describe("runQueries", () => {
  function runner(results: unknown[], failAt = -1): { connection: MysqlRunner; log: string[] } {
    const log: string[] = [];
    let index = 0;
    return {
      log,
      connection: {
        async query(sql) {
          log.push(sql);
          if (index === failAt) throw new Error("boom");
          return [results[index++], []];
        },
        async beginTransaction() {
          log.push("BEGIN");
        },
        async commit() {
          log.push("COMMIT");
        },
        async rollback() {
          log.push("ROLLBACK");
        },
      },
    };
  }
  const queries = [
    { query: "Q1", values: [] },
    { query: "Q2", values: [] },
  ];

  it("returns rows, and the header of a statement without rows", async () => {
    const { connection, log } = runner([[{ a: 1 }, { a: 2 }], { affectedRows: 3, insertId: 0 }]);
    const rows = await runQueries(connection, queries, "transaction");
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }, { affectedRows: 3, insertId: 0 }]);
    assert.deepEqual(log, ["BEGIN", "Q1", "Q2", "COMMIT"]);
  });

  it("rolls back a transaction when a query fails", async () => {
    const { connection, log } = runner([{ affectedRows: 1 }], 1);
    await assert.rejects(runQueries(connection, queries, "transaction"), /boom/);
    assert.deepEqual(log, ["BEGIN", "Q1", "Q2", "ROLLBACK"]);
  });

  it("runs independent queries without a transaction", async () => {
    const { connection, log } = runner([[], []]);
    await runQueries(connection, queries, "independently");
    assert.deepEqual(log, ["Q1", "Q2"]);
    const failing = runner([{ affectedRows: 1 }], 1);
    await assert.rejects(
      runQueries(failing.connection, queries, "independently"),
      /boom \(item 1\)/,
    );
  });
});

describe("mysql node and credential", () => {
  it("checks the credential data", () => {
    assert.equal(validateCredentialData("mysql", { host: "h", ssl: "true" }), null);
    assert.match(validateCredentialData("mysql", { host: "h", port: "x" }) ?? "", /port/);
    assert.match(validateCredentialData("mysql", { ssl: "true" }) ?? "", /host/);
  });

  it("is in the registry with its operations", () => {
    const node = registry.get("mysql.database");
    assert.ok(node);
    assert.equal(node.credentialTypes?.[0], "mysql");
    assert.equal(node.actions?.length, 6);
    const parsed = node.config.parse({}) as { operation: string };
    assert.equal(parsed.operation, "insert");
    assert.equal(node.config.safeParse({ operation: "x" }).success, false);
  });
});
