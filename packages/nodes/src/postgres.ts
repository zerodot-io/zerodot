// SPDX-License-Identifier: AGPL-3.0-only
import {
  defineNode,
  type FieldSpec,
  type ResolvedCredential,
  resolveConfig,
  resolveTemplate,
} from "@zerodot/engine";
import type { Options, PostgresType, Sql } from "postgres";
import { z } from "zod";
import {
  addReturning,
  addSortRules,
  addWhereClauses,
  bindQuotedParameters,
  type ColumnInfo,
  checkItemAgainstSchema,
  convertValues,
  isRecord,
  isSelectQuery,
  type Param,
  parsePostgresError,
  type Query,
  qualified,
  queryParameterValues,
  quoteIdent,
  type Row,
  readSortRules,
  readWhereClauses,
  replaceEmptyStrings,
  toItems,
  toParam,
  WHERE_OPERATORS,
} from "./postgres-sql";

export const POSTGRES_CREDENTIAL_TYPES = ["postgres"];

const OPERATIONS = ["deleteTable", "executeQuery", "insert", "upsert", "select", "update"] as const;
type Operation = (typeof OPERATIONS)[number];

type ConnectionOptions = {
  connectionTimeout?: number;
  delayClosingIdleConnection?: number;
  largeNumbersOutput?: "numbers" | "text";
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The connection settings from a `postgres` credential.
 * The defaults are: port 5432, database and user `postgres`, SSL
 * `disable`. `allow` and `require` use TLS and check the certificate. "Ignore SSL Issues" uses TLS
 * and does not check it. DATE columns give text. BIGINT and NUMERIC give text, or numbers.
 */
export function postgresOptions(
  credential: ResolvedCredential | null,
  options: ConnectionOptions = {},
): Options<Record<string, PostgresType>> {
  if (credential?.type !== "postgres") throw new Error("Pick a Postgres credential");
  const { data } = credential;
  const host = text(data.host);
  if (!host) throw new Error('The credential has no "host"');
  const ssl = text(data.ssl) ?? "disable";
  if (!["disable", "allow", "require"].includes(ssl)) throw new Error(`Unknown SSL mode "${ssl}"`);
  const types: Record<string, PostgresType> = {
    // Text is JSON text already. The default would encode it a second time.
    json: {
      to: 114,
      from: [114, 3802],
      serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
      parse: (x: string) => JSON.parse(x) as unknown,
    },
    date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
  };
  if (options.largeNumbersOutput === "numbers") {
    types.bigint = {
      to: 20,
      from: [20],
      serialize: (x: unknown) => String(x),
      parse: (x: string) => Number.parseInt(x, 10),
    };
    types.numeric = {
      to: 1700,
      from: [1700],
      serialize: (x: unknown) => String(x),
      parse: (x: string) => Number.parseFloat(x),
    };
  }
  const connection: Options<Record<string, PostgresType>> = {
    host,
    port: text(data.port) ? Number(data.port) : 5432,
    database: text(data.database) ?? "postgres",
    username: text(data.user) ?? "postgres",
    max: 1,
    // A node run is short. A held connection would outlive it.
    idle_timeout: 1,
    connect_timeout: options.connectionTimeout || 30,
    // A notice (for example from DROP IF EXISTS) is not an error.
    onnotice: () => {},
    types,
  };
  if (options.delayClosingIdleConnection)
    connection.keep_alive = options.delayClosingIdleConnection;
  const password = text(data.password);
  if (password) connection.password = password;
  if (data.allowUnauthorizedCerts === "true") connection.ssl = { rejectUnauthorized: false };
  else if (ssl !== "disable") connection.ssl = { rejectUnauthorized: true };
  return connection;
}

/** The editor imports this package for the node catalog. The driver loads on first use. */
export async function loadPostgres() {
  return (await import("postgres")).default;
}

type Runner = Pick<Sql, "unsafe">;

/** The result sets of one call. A call with many statements gives one set for each. */
async function runOne(runner: Runner, { query, values }: Query): Promise<Row[][]> {
  const result: unknown[] = [...(await runner.unsafe(query, values))];
  return result.length > 0 && Array.isArray(result[0]) ? (result as Row[][]) : [result as Row[]];
}

type Batching = "single" | "transaction" | "independently";

/**
 * Runs the queries. `single` and `transaction` are one transaction: when a query fails, all
 * changes are rolled back. `independently` runs one query after another without a transaction.
 * A query that gives no rows gives `{ success: true }`, except a SELECT, which gives nothing.
 */
export async function runQueries(
  sql: Runner & Pick<Sql, "begin">,
  queries: Query[],
  batching: Batching,
): Promise<Row[]> {
  const rows: Row[] = [];
  let failed = 0;
  const forQuery = (sets: Row[][], query: Query): Row[] => {
    const own = sets.flat();
    return own.length > 0 ? own : isSelectQuery(query.query) ? [] : [{ success: true }];
  };
  try {
    if (batching === "independently") {
      for (const [index, query] of queries.entries()) {
        failed = index;
        rows.push(...forQuery(await runOne(sql, query), query));
      }
    } else {
      await sql.begin(async (transaction) => {
        const sets: Row[][] = [];
        for (const [index, query] of queries.entries()) {
          failed = index;
          const result = await runOne(transaction, query);
          if (batching === "transaction") rows.push(...forQuery(result, query));
          else sets.push(...result);
        }
        if (batching === "single") {
          const all = sets.flat();
          if (all.length > 0) rows.push(...all);
          else if (!queries.every((query) => isSelectQuery(query.query)))
            rows.push({ success: true });
        }
      });
    }
  } catch (error) {
    throw parsePostgresError(error, queries, batching === "single" ? undefined : failed);
  }
  return rows;
}

async function getTableSchema(
  runner: Runner,
  schema: string,
  table: string,
): Promise<ColumnInfo[]> {
  const columns = await runner.unsafe(
    "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2",
    [schema, table],
  );
  return [...columns] as unknown as ColumnInfo[];
}

async function doesRowExist(
  runner: Runner,
  schema: string,
  table: string,
  match: [string, Param][],
): Promise<boolean> {
  const values: Param[] = [];
  const where = match.map(([column, value]) => {
    values.push(toParam(value));
    return `${quoteIdent(column)} = $${values.length}`;
  });
  const result = await runner.unsafe(
    `SELECT EXISTS(SELECT 1 FROM ${qualified(schema, table)} WHERE ${where.join(" AND ")})`,
    values,
  );
  return (result[0] as Row | undefined)?.exists === true;
}

const CONDITION_LABELS: Record<string, string> = {
  equal: "Equal",
  "!=": "Not Equal",
  LIKE: "Like",
  ">": "Greater Than",
  "<": "Less Than",
  ">=": "Greater Than Or Equal",
  "<=": "Less Than Or Equal",
  "IS NULL": "Is Null",
  "IS NOT NULL": "Is Not Null",
};

export const whereSpec: FieldSpec = {
  name: "where",
  label: "Select Rows",
  kind: "fixed",
  multiple: true,
  description: "If not set, all rows will be selected",
  groups: [
    {
      name: "values",
      label: "Condition",
      fields: [
        { name: "column", label: "Column", kind: "string", placeholder: "e.g. ID" },
        {
          name: "condition",
          label: "Operator",
          kind: "options",
          default: "equal",
          description:
            "The operator to check the column against. When using 'LIKE' operator percent sign ( %) matches zero or more characters, underscore ( _ ) matches any single character.",
          options: WHERE_OPERATORS.map((value) => ({
            value,
            label: CONDITION_LABELS[value] ?? value,
          })),
        },
        {
          name: "value",
          label: "Value",
          kind: "string",
          hide: { condition: ["IS NULL", "IS NOT NULL"] },
        },
      ],
    },
  ],
};

export const sortSpec: FieldSpec = {
  name: "sort",
  label: "Sort",
  kind: "fixed",
  multiple: true,
  groups: [
    {
      name: "values",
      label: "Sort rule",
      fields: [
        { name: "column", label: "Column", kind: "string" },
        {
          name: "direction",
          label: "Direction",
          kind: "options",
          default: "ASC",
          options: [
            { value: "ASC", label: "ASC" },
            { value: "DESC", label: "DESC" },
          ],
        },
      ],
    },
  ],
};

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
        deleteTable: "Delete",
        executeQuery: "Execute Query",
        insert: "Insert",
        upsert: "Insert or Update",
        select: "Select",
        update: "Update",
      },
      hints: {
        deleteTable: "Delete an entire table or rows in a table",
        executeQuery: "Execute an SQL query",
        insert: "Insert rows in a table",
        upsert: "Insert or update rows in a table",
        select: "Select rows from a table",
        update: "Update rows in a table",
      },
    }),
  schema: z
    .string()
    .default("public")
    .meta({
      title: "Schema",
      placeholder: "e.g. public",
      description: "The schema that contains the table you want to work on",
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
      placeholder: "e.g. SELECT id, name FROM product WHERE quantity > $1 AND price <= $2",
      description:
        "The SQL query to execute. You can use expressions and $1, $2, $3, etc to refer to the 'Query Parameters' set in options below.",
      showWhen: { operation: ["executeQuery"] },
    }),
  deleteCommand: z
    .enum(["truncate", "delete", "drop"])
    .default("truncate")
    .meta({
      title: "Command",
      labels: { truncate: "Truncate", delete: "Delete", drop: "Drop" },
      hints: {
        truncate: "Only removes the table's data and preserves the table's structure",
        delete:
          "Delete the rows that match the 'Select Rows' conditions below. If no selection is made, all rows in the table are deleted.",
        drop: "Deletes the table's data and also the table's structure permanently",
      },
      showWhen: { operation: ["deleteTable"] },
    }),
  restartSequences: z
    .boolean()
    .default(false)
    .meta({
      title: "Restart Sequences",
      description: "Whether to reset identity (auto-increment) columns to their initial values",
      showWhen: { operation: ["deleteTable"], deleteCommand: ["truncate"] },
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
      showWhen: { operation: ["update", "upsert"] },
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
  cascade: z
    .boolean()
    .default(false)
    .meta({
      ...option("Cascade"),
      description:
        "Whether to drop all objects that depend on the table, such as views and sequences",
      showWhen: { operation: ["deleteTable"] },
      hideWhen: { deleteCommand: ["delete"] },
    }),
  connectionTimeout: z
    .number()
    .default(30)
    .meta({
      ...option("Connection Timeout"),
      description: "Number of seconds reserved for connecting to the database",
    }),
  delayClosingIdleConnection: z
    .number()
    .min(0)
    .default(0)
    .meta({
      ...option("Delay Closing Idle Connection"),
      description: "Number of seconds to wait before idle connection would be eligible for closing",
    }),
  queryBatching: z
    .enum(["single", "independently", "transaction"])
    .default("single")
    .meta({
      ...option("Query Batching"),
      description: "The way queries should be sent to the database",
      labels: { single: "Single Query", independently: "Independent", transaction: "Transaction" },
      hints: {
        single: "A single query for all incoming items",
        independently: "Execute one query per incoming item of the run",
        transaction:
          "Execute all queries in a transaction, if a failure occurs, all changes are rolled back",
      },
    }),
  queryReplacement: z
    .string()
    .optional()
    .meta({
      ...option("Query Parameters"),
      placeholder: "e.g. value1,value2,value3",
      description:
        "Comma-separated list of the values you want to use as query parameters. Each expression gives one value, also when the value contains commas. To give more than one value from an expression, return an array. Reference them in your query as $1, $2, $3…",
      showWhen: { operation: ["executeQuery"] },
    }),
  treatQueryParametersInSingleQuotesAsText: z
    .boolean()
    .default(false)
    .meta({
      ...option("Treat query parameters in single quotes as text"),
      description: "Whether to treat query parameters enclosed in single quotes as text e.g. '$1'",
      showWhen: { operation: ["executeQuery"] },
    }),
  outputColumns: z
    .array(z.string())
    .optional()
    .meta({
      ...option("Output Columns"),
      description: "The columns to return. Empty means all columns.",
      showWhen: { operation: ["select", "insert", "update", "upsert"] },
    }),
  largeNumbersOutput: z
    .enum(["numbers", "text"])
    .default("text")
    .meta({
      ...option("Output Large-Format Numbers As"),
      description: "Applies to NUMERIC and BIGINT columns only",
      labels: { numbers: "Numbers", text: "Text" },
      hints: {
        numbers: "",
        text: "Use this if you expect numbers longer than 16 digits (otherwise numbers may be incorrect)",
      },
    }),
  skipOnConflict: z
    .boolean()
    .default(false)
    .meta({
      ...option("Skip on Conflict"),
      description:
        "Whether to skip the row and do not throw error if a unique constraint or exclusion constraint is violated",
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

const needTable = (cfg: Config): { schema: string; table: string } => {
  if (!cfg.table) throw new Error("Pick a table");
  return { schema: cfg.schema || "public", table: cfg.table };
};

/** The row of an item for insert, update, and upsert. */
function readItem(
  cfg: Config,
  item: Row,
  evaluate: (value: unknown) => unknown,
  columns: ColumnInfo[],
): Row {
  let row: Row = item;
  if (cfg.dataMode === "defineBelow") {
    const mapped = evaluate(cfg.columns ?? {});
    row = isRecord(mapped) ? mapped : {};
  }
  return checkItemAgainstSchema(convertValues(row, columns), columns);
}

/** Builds the queries for the operation. One item gives one query. */
async function buildQueries(
  cfg: Config,
  items: Row[],
  scope: Record<string, unknown>,
  runner: Runner,
): Promise<Query[]> {
  const op: Operation = cfg.operation;
  const outputColumns = cfg.outputColumns ?? [];
  const queries: Query[] = [];
  const scopeOf = (i: number) => ({ ...scope, $item: items[i], $json: items[i], $index: i });
  const at = (i: number, build: () => Promise<Query> | Query) => async () => {
    try {
      return await build();
    } catch (error) {
      if (!(error instanceof Error) || items.length <= 1) throw error;
      throw new Error(`${error.message} (item ${i})`, { cause: error });
    }
  };

  if (op === "executeQuery") {
    if (!cfg.query) throw new Error("Write a query");
    for (const [i] of items.entries()) {
      queries.push(
        await at(i, () => {
          const itemScope = scopeOf(i);
          const rendered = resolveTemplate(cfg.query, itemScope);
          const values = queryParameterValues(cfg.queryReplacement, (expression) =>
            resolveTemplate(expression, itemScope),
          );
          const query = typeof rendered === "string" ? rendered : String(rendered ?? "");
          return !cfg.queryReplacement || cfg.treatQueryParametersInSingleQuotesAsText
            ? bindQuotedParameters(query, values)
            : { query, values };
        })(),
      );
    }
    return queries;
  }

  const { schema, table } = needTable(cfg);
  const target = qualified(schema, table);

  if (op === "deleteTable") {
    for (const [i] of items.entries()) {
      queries.push(
        await at(i, () => {
          if (cfg.deleteCommand === "drop") {
            return {
              query: `DROP TABLE IF EXISTS ${target}${cfg.cascade ? " CASCADE" : ""}`,
              values: [],
            };
          }
          if (cfg.deleteCommand === "truncate") {
            const identity = cfg.restartSequences ? " RESTART IDENTITY" : "";
            return {
              query: `TRUNCATE TABLE ${target}${identity}${cfg.cascade ? " CASCADE" : ""}`,
              values: [],
            };
          }
          return addWhereClauses(
            `DELETE FROM ${target}`,
            readWhereClauses(resolveConfig(cfg.where, scopeOf(i))),
            [],
            cfg.combineConditions,
          );
        })(),
      );
    }
    return queries;
  }

  if (op === "select") {
    const sortRules = readSortRules(cfg.sort);
    for (const [i] of items.entries()) {
      queries.push(
        await at(i, () => {
          const columns =
            outputColumns.length === 0 || outputColumns.includes("*")
              ? "*"
              : outputColumns.map(quoteIdent).join(", ");
          const where = addWhereClauses(
            `SELECT ${columns} FROM ${target}`,
            readWhereClauses(resolveConfig(cfg.where, scopeOf(i))),
            [],
            cfg.combineConditions,
          );
          let query = addSortRules(where.query, sortRules);
          const values = [...where.values];
          if (!cfg.returnAll) {
            values.push(Number(cfg.limit));
            query += ` LIMIT $${values.length}`;
          }
          return { query, values };
        })(),
      );
    }
    return queries;
  }

  // insert, update, upsert
  const columns = await getTableSchema(runner, schema, table);
  const matching = cfg.matchingColumns ?? [];
  if (op !== "insert" && matching.length === 0) throw new Error("Pick the columns to match on");
  for (const [i, original] of items.entries()) {
    queries.push(
      await at(i, async () => {
        const itemScope = scopeOf(i);
        const row = readItem(cfg, original, (value) => resolveConfig(value, itemScope), columns);
        const keys = Object.keys(row);
        const values = keys.map((key) => toParam(row[key]));

        if (op === "insert") {
          if (keys.length === 0) {
            return {
              query: addReturning(`INSERT INTO ${target} DEFAULT VALUES`, outputColumns),
              values: [],
            };
          }
          const conflict = cfg.skipOnConflict ? " ON CONFLICT DO NOTHING" : "";
          const marks = keys.map((_, n) => `$${n + 1}`).join(", ");
          return {
            query: addReturning(
              `INSERT INTO ${target}(${keys.map(quoteIdent).join(", ")}) VALUES(${marks})${conflict}`,
              outputColumns,
            ),
            values,
          };
        }

        if (op === "update") {
          const match: [string, Param][] = matching.map((column) => [column, toParam(row[column])]);
          if (!(await doesRowExist(runner, schema, table, match))) {
            const shown = match.map(([column, value]) => `${column}=${value}`).join(", ");
            throw new Error(
              `The row you are trying to update doesn't exist: No rows matching the provided values (${shown}) were found in the table "${table}".`,
            );
          }
          const updateColumns = keys.filter((key) => !matching.includes(key));
          if (updateColumns.length === 0) {
            throw new Error(
              "Add values to update to the input item or set the 'Data Mode' to 'Map Each Column Manually' to define the values to update.",
            );
          }
          const params: Param[] = [];
          const sets = updateColumns.map((key) => {
            params.push(toParam(row[key]));
            return `${quoteIdent(key)} = $${params.length}`;
          });
          const conditions = match.map(([column, value]) => {
            params.push(value);
            return `${quoteIdent(column)} = $${params.length}`;
          });
          return {
            query: addReturning(
              `UPDATE ${target} SET ${sets.join(", ")} WHERE ${conditions.join(" AND ")}`,
              outputColumns,
            ),
            values: params,
          };
        }

        // upsert
        const first = matching[0] as string;
        if (!row[first]) {
          throw new Error(
            "Column to match on not found in input item. Add a column to match on or set the 'Data Mode' to 'Map Each Column Manually' to define the value to match on.",
          );
        }
        if (keys.length === 1) {
          throw new Error(
            "Add values to update or insert to the input item or set the 'Data Mode' to 'Map Each Column Manually' to define the values to insert or update.",
          );
        }
        const marks = keys.map((_, n) => `$${n + 1}`).join(", ");
        const updateColumns = keys.filter((key) => !matching.includes(key));
        const updates = updateColumns.map(
          (key) => `${quoteIdent(key)} = EXCLUDED.${quoteIdent(key)}`,
        );
        const action = updates.length > 0 ? ` DO UPDATE SET ${updates.join(", ")}` : " DO NOTHING";
        return {
          query: addReturning(
            `INSERT INTO ${target}(${keys.map(quoteIdent).join(", ")}) VALUES(${marks}) ON CONFLICT (${matching.map(quoteIdent).join(", ")})${action}`,
            outputColumns,
          ),
          values,
        };
      })(),
    );
  }
  return queries;
}

export default defineNode({
  type: "postgres.database",
  label: "Postgres",
  description: "Get, add and update data in Postgres",
  category: "integration",
  app: "Postgres",
  // The names of the actions of the Postgres node.
  actions: [
    { label: "Delete table or rows", config: { operation: "deleteTable" } },
    { label: "Execute a SQL query", config: { operation: "executeQuery" } },
    { label: "Insert rows in a table", config: { operation: "insert" } },
    { label: "Insert or update rows in a table", config: { operation: "upsert" } },
    { label: "Select rows from a table", config: { operation: "select" } },
    { label: "Update rows in a table", config: { operation: "update" } },
  ],
  icon: "Database",
  iconUrl: "/icons/postgresql.svg",
  config,
  defaultConfig: { operation: "insert", schema: "public", table: "" },
  // These keys hold expressions that read one item, so they are resolved once for each item.
  rawConfigKeys: ["query", "queryReplacement", "columns", "where"],
  credentialTypes: POSTGRES_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.operation === "string" ? cfg.operation : undefined),
  // Each input item gives one query. An array is a list of items, an object is one
  // item. The output is the list of rows. A query without rows gives `{ success: true }`.
  async run({ config: cfg, input, credential, scope, signal }) {
    const original = toItems(input);
    if (original.length === 0) return { port: "out", data: [] };
    const items =
      cfg.replaceEmptyStrings &&
      ["insert", "update", "upsert", "executeQuery"].includes(cfg.operation)
        ? original.map(replaceEmptyStrings)
        : original;

    const postgres = await loadPostgres();
    const sql = postgres(postgresOptions(credential, cfg));
    const abort = () => void sql.end({ timeout: 0 });
    signal.addEventListener("abort", abort, { once: true });
    try {
      let queries: Query[];
      try {
        queries = await buildQueries(cfg, items, scope, sql);
      } catch (error) {
        throw parsePostgresError(error, []);
      }
      const rows = await runQueries(sql, queries, cfg.queryBatching);
      return { port: "out", data: rows };
    } finally {
      signal.removeEventListener("abort", abort);
      await sql.end({ timeout: 5 });
    }
  },
});
