// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCredentialData } from "./credentials";
import { registry } from "./index";
import { postgresOptions } from "./postgres";
import { installStatements, listenNames, removeStatements, toListenItem } from "./postgres-listen";
import {
  addReturning,
  addSortRules,
  addWhereClauses,
  bindQuotedParameters,
  checkItemAgainstSchema,
  convertValues,
  isSelectQuery,
  parsePostgresError,
  queryParameterValues,
  quoteIdent,
  readWhereClauses,
  replaceEmptyStrings,
  toItems,
} from "./postgres-sql";
import { buildPollQuery } from "./postgres-trigger";

const columns = [
  { column_name: "id", data_type: "integer", is_nullable: "NO" },
  { column_name: "name", data_type: "text", is_nullable: "YES" },
  { column_name: "tags", data_type: "ARRAY", is_nullable: "YES" },
  { column_name: "meta", data_type: "jsonb", is_nullable: "YES" },
];

describe("postgresOptions", () => {
  it("uses the usual defaults", () => {
    const options = postgresOptions({ type: "postgres", data: { host: "db.x.io" } });
    assert.equal(options.port, 5432);
    assert.equal(options.database, "postgres");
    assert.equal(options.username, "postgres");
    assert.equal(options.ssl, undefined);
    assert.equal(options.password, undefined);
    assert.equal(options.connect_timeout, 30);
  });

  it("reads the login, SSL, and options", () => {
    const data = {
      host: "h",
      user: "u",
      password: "p",
      database: "d",
      port: "6543",
      ssl: "require",
    };
    const options = postgresOptions(
      { type: "postgres", data },
      { connectionTimeout: 5, delayClosingIdleConnection: 20 },
    );
    assert.equal(options.port, 6543);
    assert.equal(options.username, "u");
    assert.equal(options.password, "p");
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
    assert.equal(options.connect_timeout, 5);
    assert.equal(options.keep_alive, 20);
  });

  it("ignores certificate errors on request", () => {
    const data = { host: "h", ssl: "disable", allowUnauthorizedCerts: "true" };
    assert.deepEqual(postgresOptions({ type: "postgres", data }).ssl, {
      rejectUnauthorized: false,
    });
  });

  it("parses large numbers only when asked", () => {
    const credential = { type: "postgres", data: { host: "h" } };
    assert.equal(postgresOptions(credential).types?.bigint, undefined);
    const types = postgresOptions(credential, { largeNumbersOutput: "numbers" }).types;
    assert.equal(types?.bigint?.parse("42"), 42);
    assert.equal(types?.numeric?.parse("1.5"), 1.5);
  });

  it("fails without a credential, a host, or with a bad mode", () => {
    assert.throws(() => postgresOptions(null), /Pick a Postgres credential/);
    assert.throws(() => postgresOptions({ type: "postgres", data: {} }), /no "host"/);
    assert.throws(
      () => postgresOptions({ type: "postgres", data: { host: "h", ssl: "x" } }),
      /Unknown SSL mode/,
    );
  });
});

describe("SQL builders", () => {
  it("quotes names", () => {
    assert.equal(quoteIdent('we"ird'), '"we""ird"');
  });

  it("adds where clauses with parameters", () => {
    const clauses = readWhereClauses({
      values: [
        { column: "id", condition: ">", value: "5" },
        { column: "name", condition: "LIKE", value: "a%" },
        { column: "gone", condition: "IS NULL" },
      ],
    });
    const result = addWhereClauses("SELECT * FROM t", clauses, [], "OR");
    assert.equal(
      result.query,
      'SELECT * FROM t WHERE "id" > $1 OR "name" LIKE $2 OR "gone" IS NULL',
    );
    assert.deepEqual(result.values, [5, "a%"]);
  });

  it("maps equal to =", () => {
    const clauses = readWhereClauses({ values: [{ column: "a", condition: "equal", value: "x" }] });
    assert.equal(addWhereClauses("D", clauses, [], "AND").query, 'D WHERE "a" = $1');
  });

  it("rejects a condition that is not in the list", () => {
    assert.throws(
      () => readWhereClauses({ values: [{ column: "a", condition: "= 1; DROP", value: "x" }] }),
      /Invalid where clause/,
    );
  });

  it("adds sort rules and returning", () => {
    const rules = [{ column: "a", direction: "DESC" }, { column: "b" }];
    assert.equal(addSortRules("Q", rules), 'Q ORDER BY "a" DESC, "b" ASC');
    assert.equal(addReturning("Q", []), "Q RETURNING *");
    assert.equal(addReturning("Q", ["a", "b"]), 'Q RETURNING "a", "b"');
  });
});

describe("items and values", () => {
  it("makes items from the input", () => {
    assert.deepEqual(toItems([{ a: 1 }, 2]), [{ a: 1 }, { value: 2 }]);
    assert.deepEqual(toItems({ a: 1 }), [{ a: 1 }]);
    assert.deepEqual(toItems(null), [{}]);
    assert.deepEqual(toItems([]), []);
  });

  it("replaces empty strings", () => {
    assert.deepEqual(replaceEmptyStrings({ a: "", b: "x", c: 0 }), { a: null, b: "x", c: 0 });
  });

  it("splits query parameters on commas without expressions", () => {
    assert.deepEqual(
      queryParameterValues("1, abc ,x", () => null),
      ["1", "abc", "x"],
    );
    assert.deepEqual(
      queryParameterValues(undefined, () => null),
      [],
    );
  });

  it("gives one value for each expression", () => {
    const values = queryParameterValues(
      "{{ a }}, {{ b }}, {{ c }}, {{ d }}",
      (expression) =>
        ({
          "{{ a }}": "x,y",
          "{{ b }}": [1, undefined, { k: 1 }],
          "{{ c }}": null,
          "{{ d }}": { z: 1 },
        })[expression],
    );
    assert.deepEqual(values, ["x,y", 1, null, '{"k":1}', null, '{"z":1}']);
  });

  it("binds a parameter in single quotes as text", () => {
    assert.deepEqual(bindQuotedParameters("SELECT '$1', '$2'", ["a"]), {
      query: "SELECT $2, $3",
      values: ["a", "$1", "$2"],
    });
  });

  it("checks an item against the table", () => {
    assert.throws(() => checkItemAgainstSchema({ nope: 1 }, columns), /does not exist/);
    assert.throws(() => checkItemAgainstSchema({ id: null }, columns), /not nullable/);
    assert.deepEqual(checkItemAgainstSchema({ id: 1 }, columns), { id: 1 });
  });

  it("converts arrays and objects", () => {
    const row = convertValues({ id: 1, tags: ['a"b', 2, true], meta: { k: 1 } }, columns);
    assert.deepEqual(row, { id: 1, tags: '{"a\\"b",2,"true"}', meta: '{"k":1}' });
    assert.equal(convertValues({ tags: '["x"]' }, columns).tags, '{"x"}');
    assert.equal(convertValues({ meta: "plain" }, columns).meta, '"plain"');
    assert.throws(
      () =>
        convertValues({ tags: 5 }, [
          { column_name: "tags", data_type: "ARRAY", is_nullable: "NO" },
        ]),
      /array/,
    );
  });
});

describe("isSelectQuery", () => {
  it("knows a SELECT from a change", () => {
    assert.equal(isSelectQuery("SELECT 1"), true);
    assert.equal(isSelectQuery("select 1; select 2"), true);
    assert.equal(isSelectQuery("WITH x AS (SELECT 1) UPDATE t SET a = 1"), false);
    assert.equal(isSelectQuery("SELECT 1; DELETE FROM t"), false);
    assert.equal(isSelectQuery("-- UPDATE\nSELECT 'DELETE'"), true);
  });
});

describe("parsePostgresError", () => {
  it("names the line of a syntax error", () => {
    const error = parsePostgresError(new Error('syntax error at or near "SELEC"'), [
      { query: "\nSELEC 1", values: [] },
    ]);
    assert.match(error.message, /^Syntax error at line 2 near "SELEC": Failed query:/);
  });
  it("explains a refused connection", () => {
    const error = parsePostgresError(new Error("connect ECONNREFUSED 127.0.0.1:1"), []);
    assert.equal(error.message, "Connection refused: 127.0.0.1:1");
  });
});

describe("postgres credential and node", () => {
  it("validates the credential fields", () => {
    assert.equal(validateCredentialData("postgres", { host: "h", ssl: "allow" }), null);
    assert.match(validateCredentialData("postgres", { port: "5432" }) ?? "", /host/);
    assert.match(validateCredentialData("postgres", { host: "h", ssl: "x" }) ?? "", /ssl/);
  });
  it("is in the registry with its operations", () => {
    const node = registry.get("postgres.database");
    assert.ok(node);
    const parsed = node.config.parse({}) as { operation: string; schema: string };
    assert.equal(parsed.operation, "insert");
    assert.equal(parsed.schema, "public");
    assert.equal(node.config.safeParse({ operation: "x" }).success, false);
  });
});

describe("buildPollQuery", () => {
  const cfg = { schema: "public", table: "orders", trackingColumn: "id" };

  it("reads the newest value on the first poll", () => {
    const { query, values } = buildPollQuery(cfg, null, true);
    assert.match(query, /max\("id"\)::text/);
    assert.deepEqual(values, []);
  });

  it("reads the rows after the cursor, oldest first", () => {
    const { query, values } = buildPollQuery(cfg, "42", false);
    assert.match(query, /WHERE "id" > \$1 ORDER BY "id" ASC LIMIT 1000/);
    assert.deepEqual(values, ["42"]);
  });

  it("reads all rows when the table was empty", () => {
    const { query, values } = buildPollQuery(cfg, null, false);
    assert.match(query, /IS NOT NULL/);
    assert.deepEqual(values, []);
  });

  it("is a poll trigger", () => {
    const definition = registry.get("trigger.postgres");
    assert.equal(definition?.category, "trigger");
    assert.equal(typeof definition?.poll, "function");
  });
});

describe("trigger.postgres_listen", () => {
  const names = listenNames("wf", "node");
  const cfg = { schema: "public", table: "orders", events: ["INSERT", "DELETE"] as const };

  it("makes safe names that do not change", () => {
    assert.match(names.channel, /^zerodot_[0-9a-f]{16}$/);
    assert.deepEqual(names, listenNames("wf", "node"));
    assert.notEqual(names.channel, listenNames("wf", "other").channel);
  });

  it("makes a function and a trigger for the events", () => {
    const [fn, drop, create] = installStatements({ ...cfg, events: [...cfg.events] }, names);
    assert.match(fn ?? "", /CREATE OR REPLACE FUNCTION "public"\."zerodot_[0-9a-f]+"\(\)/);
    assert.match(fn ?? "", /pg_notify\('zerodot_[0-9a-f]+', payload\)/);
    assert.match(drop ?? "", /DROP TRIGGER IF EXISTS/);
    assert.match(create ?? "", /AFTER INSERT OR DELETE ON "public"\."orders" FOR EACH ROW/);
  });

  it("quotes the table name", () => {
    const [, , create] = installStatements(
      { schema: "s", table: 'a"b', events: ["UPDATE"] },
      names,
    );
    assert.match(create ?? "", /ON "s"\."a""b"/);
  });

  it("removes the trigger and the function", () => {
    const [trigger, fn] = removeStatements(cfg, names);
    assert.match(trigger ?? "", /DROP TRIGGER IF EXISTS .* ON "public"\."orders"/);
    assert.match(fn ?? "", /DROP FUNCTION IF EXISTS "public"\."zerodot_[0-9a-f]+"\(\)/);
  });

  it("turns a notification into an item", () => {
    const one = toListenItem('{"event":"INSERT","row":{"id":1}}');
    assert.deepEqual(one.data, { event: "INSERT", row: { id: 1 } });
    assert.equal(one.key, toListenItem('{"event":"INSERT","row":{"id":1}}').key);
    assert.notEqual(one.key, toListenItem('{"event":"INSERT","row":{"id":2}}').key);
    assert.equal(toListenItem("plain").data, "plain");
  });

  it("is a listen trigger", () => {
    const definition = registry.get("trigger.postgres_listen");
    assert.equal(definition?.category, "trigger");
    assert.equal(typeof definition?.listen, "function");
    assert.equal(definition?.poll, undefined);
  });
});
