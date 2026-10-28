// SPDX-License-Identifier: AGPL-3.0-only
import {
  defineNode,
  type ResolvedCredential,
  resolveConfig,
  resolveTemplate,
} from "@zerodot/engine";
import type { ConnectionOptions } from "mysql2/promise";
import { z } from "zod";
import {
  addOrderBy,
  addWhere,
  buildInsert,
  buildUpdate,
  buildUpsert,
  type MysqlQuery,
  qualifiedTable,
} from "./mysql-sql";
import { sortSpec, whereSpec } from "./postgres";
import {
  isRecord,
  queryParameterValues,
  type Row,
  readSortRules,
  readWhereClauses,
  replaceEmptyStrings,
  toItems,
} from "./postgres-sql";

export const MYSQL_CREDENTIAL_TYPES = ["mysql"];

const OPERATIONS = ["executeQuery", "insert", "upsert", "select", "update", "deleteTable"] as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The connection settings from a `mysql` credential. Empty means port
 * 3306 and no TLS. "SSL" uses TLS and checks the certificate. "Ignore SSL Issues" uses TLS and
 * does not check it.
 */
export function mysqlOptions(
  credential: ResolvedCredential | null,
  options: { connectTimeout?: number; decimalNumbers?: boolean } = {},
): ConnectionOptions {
  if (credential?.type !== "mysql") throw new Error("Pick a MySQL credential");
  const { data } = credential;
  const host = text(data.host);
  if (!host) throw new Error('The credential has no "host"');
  const connection: ConnectionOptions = {
    host,
    port: text(data.port) ? Number(data.port) : 3306,
    connectTimeout: (options.connectTimeout || 10) * 1000,
    // A big number stays exact as text. A DECIMAL is text unless the option asks for numbers.
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: options.decimalNumbers === true,
    // A date is text, so the time zone of the server does not change it.
    dateStrings: true,
  };
  const database = text(data.database);
  const user = text(data.user);
  const password = text(data.password);
  if (database) connection.database = database;
  if (user) connection.user = user;
  if (password) connection.password = password;
  if (data.allowUnauthorizedCerts === "true") connection.ssl = { rejectUnauthorized: false };
  else if (data.ssl === "true") connection.ssl = { rejectUnauthorized: true };
  return connection;
}

/** The editor imports this package for the node catalog. The driver loads on first use. */
export async function loadMysql() {
  return await import("mysql2/promise");
}

/** The part of a connection that the node uses. A test can fake it. */
export type MysqlRunner = {
  query(sql: string, values: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
};

type Batching = "transaction" | "independently";

/** The rows of one result. A statement without rows gives its header (`affectedRows`, ...). */
function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) {
    // Many statements give one result for each.
    return result.length > 0 && Array.isArray(result[0])
      ? result.flatMap(rowsOf)
      : (result as Row[]);
  }
  return isRecord(result) ? [{ ...result }] : [{ success: true }];
}

/**
 * Runs the queries. `transaction` rolls back all changes when a query fails. `independently` runs
 * one query after another without a transaction.
 */
export async function runQueries(
  connection: MysqlRunner,
  queries: MysqlQuery[],
  batching: Batching,
): Promise<Row[]> {
  const rows: Row[] = [];
  let failed = 0;
  try {
    if (batching === "transaction") await connection.beginTransaction();
    for (const [index, { query, values }] of queries.entries()) {
      failed = index;
      const [result] = await connection.query(query, values);
      rows.push(...rowsOf(result));
    }
    if (batching === "transaction") await connection.commit();
  } catch (error) {
    if (batching === "transaction") await connection.rollback().catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    const where = queries.length > 1 && batching === "independently" ? ` (item ${failed})` : "";
    throw new Error(`${message}${where}`, { cause: error });
  }
  return rows;
}

const option = (title: string) => ({ option: true, title });

const MAPPED = ["insert", "update", "upsert"];
const WHERE_RULES = [
  { operation: ["select"] },
  { operation: ["deleteTable"], deleteCommand: ["delete"] },
];

const config = z.object({
  operation: z
    .enum(OPERATIONS)
    .default("insert")
    .meta({
      title: "Operation",
      labels: {
        executeQuery: "Execute SQL",
        insert: "Insert",
        upsert: "Insert or Update",
        select: "Select",
        update: "Update",
        deleteTable: "Delete",
      },
      hints: {
        executeQuery: "Execute an SQL query",
        insert: "Insert rows in a table",
        upsert: "Insert rows in a table, or update the row when a unique key matches",
        select: "Select rows from a table",
        update: "Update rows in a table",
        deleteTable: "Delete an entire table or rows in a table",
      },
    }),
  database: z
    .string()
    .default("")
    .meta({
      title: "Database",
      description: "The database of the table. Empty means the database of the credential.",
      hideWhen: { operation: ["executeQuery"] },
    }),
  table: z
    .string()
    .default("")
    .meta({
      title: "Table",
      description: "The table you want to work on",
      hideWhen: { operation: ["executeQuery"] },
    }),
  query: z
    .string()
    .default("")
    .meta({
      title: "Query",
      ui: "code",
      placeholder: "e.g. SELECT id, name FROM product WHERE quantity > ? AND price <= ?",
      description:
        "The SQL query to execute. You can use expressions and ? marks to refer to the 'Query Parameters' set in options below.",
      showWhen: { operation: ["executeQuery"] },
    }),
  deleteCommand: z
    .enum(["truncate", "delete", "drop"])
    .default("delete")
    .meta({
      title: "Command",
      labels: { truncate: "Truncate", delete: "Delete", drop: "Drop" },
      hints: {
        truncate: "Only removes the table's data and preserves the table's structure",
        delete:
          "Delete the rows that match the 'Select Rows' conditions below. At least one condition is required.",
        drop: "Deletes the table's data and also the table's structure permanently",
      },
      showWhen: { operation: ["deleteTable"] },
    }),
  dataMode: z
    .enum(["autoMapInputData", "defineBelow"])
    .default("autoMapInputData")
    .meta({
      title: "Data Mode",
      labels: {
        autoMapInputData: "Auto-Map Input Data to Columns",
        defineBelow: "Map Each Column Manually",
      },
      hints: {
        autoMapInputData:
          "Use when node input properties names exactly match the table column names",
        defineBelow: "Set the value for each destination column manually",
      },
      showWhen: { operation: MAPPED },
    }),
  columns: z
    .record(z.string(), z.unknown())
    .optional()
    .meta({
      title: "Columns",
      ui: "fields",
      description:
        "Column names and their values. A value can use expressions, and reads the item with $item.",
      showWhen: { operation: MAPPED, dataMode: ["defineBelow"] },
    }),
  matchingColumns: z
    .array(z.string())
    .optional()
    .meta({
      title: "Column to Match On",
      description:
        "The columns to compare when finding the rows to update. The input must have a value for each of them.",
      showWhen: { operation: ["update"] },
    }),
  returnAll: z
    .boolean()
    .default(false)
    .meta({
      title: "Return All",
      description: "Whether to return all results or only up to a given limit",
      showWhen: { operation: ["select"] },
    }),
  limit: z
    .number()
    .int()
    .min(1)
    .default(50)
    .meta({
      title: "Limit",
      description: "Max number of results to return",
      showWhen: { operation: ["select"], returnAll: [false] },
    }),
  where: z.record(z.string(), z.unknown()).optional().meta({
    title: "Select Rows",
    ui: "field-collection",
    fieldSpec: whereSpec,
    showWhen: WHERE_RULES,
  }),
  combineConditions: z
    .enum(["AND", "OR"])
    .default("AND")
    .meta({
      title: "Combine Conditions",
      description:
        'How to combine the conditions defined in "Select Rows": AND requires all conditions to be true, OR requires at least one condition to be true',
      labels: { AND: "AND", OR: "OR" },
      hints: {
        AND: "Only rows that meet all the conditions are selected",
        OR: "Rows that meet at least one condition are selected",
      },
      showWhen: WHERE_RULES,
    }),
  sort: z
    .record(z.string(), z.unknown())
    .optional()
    .meta({
      title: "Sort",
      ui: "field-collection",
      fieldSpec: sortSpec,
      showWhen: { operation: ["select"] },
    }),
  connectionTimeout: z
    .number()
    .min(1)
    .default(10)
    .meta({
      ...option("Connection Timeout"),
      description: "Number of seconds reserved for connecting to the database",
    }),
  queryBatching: z
    .enum(["transaction", "independently"])
    .default("transaction")
    .meta({
      ...option("Query Batching"),
      description: "The way queries should be sent to the database",
      labels: { transaction: "Transaction", independently: "Independent" },
      hints: {
        transaction:
          "Execute all queries in a transaction, if a failure occurs, all changes are rolled back",
        independently: "Execute one query after the other. A failure does not undo earlier queries",
      },
    }),
  queryReplacement: z
    .string()
    .optional()
    .meta({
      ...option("Query Parameters"),
      placeholder: "e.g. value1,value2,value3",
      description:
        "Comma-separated list of the values you want to use as query parameters. Each expression gives one value, also when the value contains commas. To give more than one value from an expression, return an array. Reference them in your query as ? marks.",
      showWhen: { operation: ["executeQuery"] },
    }),
  decimalNumbers: z
    .boolean()
    .default(false)
    .meta({
      ...option("Decimals as Numbers"),
      description: "Whether to return DECIMAL columns as numbers, and not as text",
    }),
  ignoreConflict: z
    .boolean()
    .default(false)
    .meta({
      ...option("Skip on Conflict"),
      description:
        "Whether to skip the row and not throw an error if a unique key is violated (INSERT IGNORE)",
      showWhen: { operation: ["insert"] },
    }),
  replaceEmptyStrings: z
    .boolean()
    .default(false)
    .meta({
      ...option("Replace Empty Strings with NULL"),
      description:
        "Whether to replace empty strings with NULL in input, could be useful when data come from spreadsheet",
      showWhen: { operation: [...MAPPED, "executeQuery"] },
    }),
});

type Config = z.output<typeof config>;

const needTable = (cfg: Config): string => {
  if (!cfg.table) throw new Error("Pick a table");
  return qualifiedTable(cfg.table, cfg.database || undefined);
};

/** The row of an item for insert, update, and upsert. */
function readItem(cfg: Config, item: Row, evaluate: (value: unknown) => unknown): Row {
  if (cfg.dataMode !== "defineBelow") return item;
  const mapped = evaluate(cfg.columns ?? {});
  return isRecord(mapped) ? mapped : {};
}

/** Builds the queries for the operation. One item gives one query. */
export function buildQueries(
  cfg: Config,
  items: Row[],
  scope: Record<string, unknown>,
): MysqlQuery[] {
  const scopeOf = (i: number) => ({ ...scope, $item: items[i], $json: items[i], $index: i });
  const build = (i: number, make: () => MysqlQuery): MysqlQuery => {
    try {
      return make();
    } catch (error) {
      if (!(error instanceof Error) || items.length <= 1) throw error;
      throw new Error(`${error.message} (item ${i})`, { cause: error });
    }
  };

  if (cfg.operation === "executeQuery") {
    if (!cfg.query) throw new Error("Write a query");
    return items.map((_, i) =>
      build(i, () => {
        const itemScope = scopeOf(i);
        const rendered = resolveTemplate(cfg.query, itemScope);
        return {
          query: typeof rendered === "string" ? rendered : String(rendered ?? ""),
          values: queryParameterValues(cfg.queryReplacement, (expression) =>
            resolveTemplate(expression, itemScope),
          ),
        };
      }),
    );
  }

  const table = needTable(cfg);

  if (cfg.operation === "deleteTable") {
    return items.map((_, i) =>
      build(i, () => {
        if (cfg.deleteCommand === "drop")
          return { query: `DROP TABLE IF EXISTS ${table}`, values: [] };
        if (cfg.deleteCommand === "truncate")
          return { query: `TRUNCATE TABLE ${table}`, values: [] };
        const clauses = readWhereClauses(resolveConfig(cfg.where, scopeOf(i)));
        // A DELETE without a condition would remove every row. Truncate does that on purpose.
        if (clauses.length === 0) throw new Error("Add at least one condition to select the rows");
        return addWhere(`DELETE FROM ${table}`, clauses, [], cfg.combineConditions);
      }),
    );
  }

  if (cfg.operation === "select") {
    const sortRules = readSortRules(cfg.sort);
    return items.map((_, i) =>
      build(i, () => {
        const where = addWhere(
          `SELECT * FROM ${table}`,
          readWhereClauses(resolveConfig(cfg.where, scopeOf(i))),
          [],
          cfg.combineConditions,
        );
        const query = addOrderBy(where.query, sortRules);
        return cfg.returnAll
          ? { query, values: where.values }
          : { query: `${query} LIMIT ?`, values: [...where.values, Number(cfg.limit)] };
      }),
    );
  }

  // insert, update, upsert
  return items.map((original, i) =>
    build(i, () => {
      const itemScope = scopeOf(i);
      const row = readItem(cfg, original, (value) => resolveConfig(value, itemScope));
      if (cfg.operation === "insert") {
        return buildInsert(table, row, { ignore: cfg.ignoreConflict });
      }
      if (cfg.operation === "update") return buildUpdate(table, row, cfg.matchingColumns ?? []);
      return buildUpsert(table, row);
    }),
  );
}

export default defineNode({
  type: "mysql.database",
  label: "MySQL",
  description: "Get, add and update data in MySQL",
  category: "integration",
  app: "MySQL",
  // The names of the actions of the MySQL node.
  actions: [
    { label: "Delete table or rows", config: { operation: "deleteTable" } },
    { label: "Execute a SQL query", config: { operation: "executeQuery" } },
    { label: "Insert rows in a table", config: { operation: "insert" } },
    { label: "Insert or update rows in a table", config: { operation: "upsert" } },
    { label: "Select rows from a table", config: { operation: "select" } },
    { label: "Update rows in a table", config: { operation: "update" } },
  ],
  icon: "Database",
  iconUrl: "/icons/mysql.svg",
  config,
  defaultConfig: { operation: "insert", database: "", table: "" },
  // These keys hold expressions that read one item, so they are resolved once for each item.
  rawConfigKeys: ["query", "queryReplacement", "columns", "where"],
  credentialTypes: MYSQL_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.operation === "string" ? cfg.operation : undefined),
  // Each input item gives one query. The output is the list of rows. A statement
  // without rows gives its result header (`affectedRows`, `insertId`, ...).
  async run({ config: cfg, input, credential, scope, signal }) {
    const original = toItems(input);
    if (original.length === 0) return { port: "out", data: [] };
    const items =
      cfg.replaceEmptyStrings &&
      ["insert", "update", "upsert", "executeQuery"].includes(cfg.operation)
        ? original.map(replaceEmptyStrings)
        : original;
    const queries = buildQueries(cfg, items, scope);

    const mysql = await loadMysql();
    const connection = await mysql.createConnection(mysqlOptions(credential, cfg));
    const abort = () => connection.destroy();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const rows = await runQueries(connection, queries, cfg.queryBatching);
      return { port: "out", data: rows };
    } finally {
      signal.removeEventListener("abort", abort);
      await connection.end().catch(() => connection.destroy());
    }
  },
});
