// SPDX-License-Identifier: AGPL-3.0-only
// Pure helpers of the Postgres node. They build SQL text and values. Nothing here connects.

export type Param = string | number | boolean | null;
export type Row = Record<string, unknown>;
export type Query = { query: string; values: Param[] };

/** A column of a table, from `information_schema.columns`. */
export type ColumnInfo = {
  column_name: string;
  data_type: string;
  is_nullable: string;
};

export const isRecord = (value: unknown): value is Row =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A name of a schema, table, or column, quoted for SQL. A double quote doubles. */
export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** `schema.table`, both quoted. */
export const qualified = (schema: string, table: string): string =>
  `${quoteIdent(schema)}.${quoteIdent(table)}`;

export const WHERE_OPERATORS = [
  "equal",
  "!=",
  "LIKE",
  ">",
  "<",
  ">=",
  "<=",
  "IS NULL",
  "IS NOT NULL",
] as const;

export type WhereClause = { column: string; condition: string; value?: unknown };
export type SortRule = { column: string; direction?: string };

const OPERATOR_SET = new Set<string>([...WHERE_OPERATORS, "="]);

/** The `where` option: `{ values: [{ column, condition, value }] }`. */
export function readWhereClauses(where: unknown): WhereClause[] {
  if (!isRecord(where) || !Array.isArray(where.values)) return [];
  return where.values.map((clause) => {
    if (
      !isRecord(clause) ||
      typeof clause.column !== "string" ||
      clause.column === "" ||
      typeof clause.condition !== "string" ||
      !OPERATOR_SET.has(clause.condition)
    ) {
      throw new Error("Invalid where clause");
    }
    return { column: clause.column, condition: clause.condition, value: clause.value };
  });
}

/** The `sort` option: `{ values: [{ column, direction }] }`. */
export function readSortRules(sort: unknown): SortRule[] {
  if (!isRecord(sort) || !Array.isArray(sort.values)) return [];
  return sort.values.filter(isRecord).flatMap((rule) =>
    typeof rule.column === "string" && rule.column !== ""
      ? [
          {
            column: rule.column,
            direction: typeof rule.direction === "string" ? rule.direction : undefined,
          },
        ]
      : [],
  );
}

/** A value for a bind parameter. Postgres converts the text to the type of the column. */
export function toParam(value: unknown): Param {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/**
 * Adds ` WHERE ...` to a query. A numeric value for `>`, `<`, `>=`, `<=` is a number. A column
 * name is quoted. A value is a parameter. The condition is checked against a fixed list.
 */
export function addWhereClauses(
  query: string,
  clauses: WhereClause[],
  values: Param[],
  combineConditions: string,
): Query {
  if (clauses.length === 0) return { query, values };
  const combineWith = combineConditions === "OR" ? "OR" : "AND";
  const params = [...values];
  const parts = clauses.map((clause) => {
    const condition = clause.condition === "equal" ? "=" : clause.condition;
    const column = quoteIdent(clause.column);
    if (condition === "IS NULL" || condition === "IS NOT NULL") return `${column} ${condition}`;
    let value = clause.value;
    if ([">", "<", ">=", "<="].includes(condition)) {
      const numeric = Number(value);
      if (String(value).trim() !== "" && !Number.isNaN(numeric)) value = numeric;
    }
    params.push(toParam(value));
    return `${column} ${condition} $${params.length}`;
  });
  return { query: `${query} WHERE ${parts.join(` ${combineWith} `)}`, values: params };
}

export function addSortRules(query: string, rules: SortRule[]): string {
  if (rules.length === 0) return query;
  const parts = rules.map(
    (rule) => `${quoteIdent(rule.column)} ${rule.direction === "DESC" ? "DESC" : "ASC"}`,
  );
  return `${query} ORDER BY ${parts.join(", ")}`;
}

/** `RETURNING *`, or the listed columns. An empty list is all columns. */
export function addReturning(query: string, outputColumns: string[]): string {
  if (outputColumns.length === 0 || outputColumns.includes("*")) return `${query} RETURNING *`;
  return `${query} RETURNING ${outputColumns.map(quoteIdent).join(", ")}`;
}

/** `{ "a": "" }` becomes `{ "a": null }`. The top level only. */
export function replaceEmptyStrings(item: Row): Row {
  return Object.fromEntries(
    Object.entries(item).map(([key, value]) => [key, value === "" ? null : value]),
  );
}

/** The items of a node run. A list is the items. One object is one item. Null is one empty item. */
export function toItems(input: unknown): Row[] {
  if (Array.isArray(input)) return input.map((item) => (isRecord(item) ? item : { value: item }));
  if (isRecord(input)) return [input];
  if (input === null || input === undefined) return [{}];
  return [{ value: input }];
}

/** Values for `$1`, `$2`... from the text of "Query Parameters". Commas split it. */
export function stringToArray(text: string): string[] {
  return text
    .split(",")
    .filter((entry) => entry)
    .map((entry) => entry.trim());
}

/** The `{{ }}` parts of a text. */
export const getResolvables = (text: string): string[] => text.match(/\{\{[\s\S]*?\}\}/g) ?? [];

/**
 * The values for the query parameters of one item. Each expression gives one value, also when
 * the value has commas. An expression that gives a list gives one value for each element. A
 * missing value is NULL. Without an expression the text splits on commas.
 */
export function queryParameterValues(
  raw: string | undefined,
  evaluate: (expression: string) => unknown,
): Param[] {
  if (!raw) return [];
  const resolvables = getResolvables(raw);
  if (resolvables.length === 0) return stringToArray(raw);
  const values: Param[] = [];
  for (const resolvable of resolvables) {
    const evaluated = evaluate(resolvable);
    if (Array.isArray(evaluated)) {
      for (const element of evaluated) {
        if (element === undefined) values.push(null);
        else if (typeof element === "object" && element !== null)
          values.push(JSON.stringify(element));
        else values.push(toParam(element));
      }
    } else if (evaluated === null || evaluated === undefined) {
      values.push(null);
    } else {
      values.push(typeof evaluated === "object" ? JSON.stringify(evaluated) : String(evaluated));
    }
  }
  return values;
}

/**
 * A query can hold `'$1'` in single quotes. Without "Query Parameters", or with the option on,
 * each one becomes a bind parameter with the text `$1` as its value.
 */
export function bindQuotedParameters(query: string, values: Param[]): Query {
  let text = query;
  const params = [...values];
  for (const literal of query.match(/'\$[0-9]+'/g) ?? []) {
    text = text.replace(literal, `$${params.length + 1}`);
    params.push(literal.replace(/'/g, ""));
  }
  return { query: text, values: params };
}

/** The problems of an item that has a column the table lacks, or a null for a column without null. */
export function checkItemAgainstSchema(item: Row, columns: ColumnInfo[]): Row {
  if (columns.length === 0) return item;
  const schema = new Map(columns.map((c) => [c.column_name, c.is_nullable === "YES"]));
  for (const key of Object.keys(item)) {
    const nullable = schema.get(key);
    if (nullable === undefined) {
      throw new Error(`Column '${key}' does not exist in selected table`);
    }
    if (item[key] === null && !nullable) {
      throw new Error(`Column '${key}' is not nullable`);
    }
  }
  return item;
}

/**
 * Prepares the values for the column types. An ARRAY column wants `{a,b}` text. A JSON column
 * and any other object value want JSON text. Returns a new object.
 */
export function convertValues(item: Row, columns: ColumnInfo[]): Row {
  const result: Row = { ...item };
  const types = new Map(columns.map((c) => [c.column_name, c]));
  for (const [key, original] of Object.entries(result)) {
    const column = types.get(key);
    let value = original;
    if (column?.data_type.toUpperCase() === "ARRAY") {
      if (typeof value === "string") {
        try {
          value = JSON.parse(value);
        } catch {
          throw new Error(`Column '${key}' has to be an array`);
        }
      }
      if (Array.isArray(value)) {
        const entries = value.map((entry) => {
          if (typeof entry === "number") return entry;
          let text = entry;
          if (typeof text === "boolean") text = String(text);
          if (typeof text === "object" && text !== null) text = JSON.stringify(text);
          if (typeof text === "string") return `"${text.replace(/"/g, '\\"')}"`;
          return text;
        });
        result[key] = `{${entries.join(",")}}`;
        continue;
      }
      if (column.is_nullable === "NO") {
        throw new Error(`Column '${key}' has to be an array`);
      }
      continue;
    }
    if (column && ["json", "jsonb"].includes(column.data_type.toLowerCase())) {
      // Text that is not JSON is a JSON string.
      if (typeof value === "string") {
        try {
          JSON.parse(value);
        } catch {
          value = JSON.stringify(value);
        }
      }
    }
    result[key] = toParam(value);
  }
  return result;
}

// Strip comments and string literals, so they cannot change how a statement is classified.
const isEStringPrefix = (query: string, quoteIndex: number): boolean => {
  if (quoteIndex === 0) return false;
  const prev = query[quoteIndex - 1];
  if (prev !== "E" && prev !== "e") return false;
  if (quoteIndex === 1) return true;
  return !/[A-Za-z0-9_]/.test(query[quoteIndex - 2] ?? "");
};

const stripStringsAndComments = (query: string): string => {
  const len = query.length;
  let out = "";
  let i = 0;
  while (i < len) {
    const c = query[i] as string;
    const next = query[i + 1];
    if (c === "/" && next === "*") {
      const end = query.indexOf("*/", i + 2);
      i = end === -1 ? len : end + 2;
      out += " ";
      continue;
    }
    if (c === "-" && next === "-") {
      const newline = query.indexOf("\n", i + 2);
      i = newline === -1 ? len : newline;
      out += " ";
      continue;
    }
    if (c === "'") {
      const allowBackslashEscape = isEStringPrefix(query, i);
      i++;
      while (i < len) {
        if (allowBackslashEscape && query[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        if (query[i] === "'") {
          if (query[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += "''";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < len && query[i] !== '"') {
        if (query[i] === "\\" && i + 1 < len) {
          i += 2;
          continue;
        }
        i++;
      }
      if (i < len) i++;
      out += '""';
      continue;
    }
    if (c === "$") {
      const tag = query.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = query.indexOf(tag, i + tag.length);
        i = end === -1 ? len : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
};

const TOP_LEVEL_COMMANDS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"]);

// The first command word outside parentheses. `WITH x AS (...) UPDATE ...` is UPDATE.
const findTopLevelCommand = (statement: string): string | null => {
  const upper = statement.toUpperCase();
  let depth = 0;
  let i = 0;
  while (i < statement.length) {
    const c = statement[i] as string;
    if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      if (depth > 0) depth--;
      i++;
    } else if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < statement.length && /[A-Za-z0-9_]/.test(statement[j] as string)) j++;
      const word = upper.slice(i, j);
      if (TOP_LEVEL_COMMANDS.has(word)) return word;
      i = j;
    } else {
      i++;
    }
  }
  return null;
};

/** True when every statement of the query is a SELECT. Then "no rows" is an empty result. */
export function isSelectQuery(query: string): boolean {
  const statements = stripStringsAndComments(query)
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length === 0) return true;
  return statements.every((statement) => findTopLevelCommand(statement) === "SELECT");
}

type DriverError = Error & { detail?: string; hint?: string };

/** An error with a clear text, and the detail or the failed query. */
export function parsePostgresError(error: unknown, queries: Query[], itemIndex?: number): Error {
  const source: DriverError = error instanceof Error ? error : new Error(String(error));
  let message = source.message;
  const index = itemIndex ?? 0;

  if (message.includes("syntax error at or near") && queries.length) {
    const snippet = message.match(/syntax error at or near "(.*)"/)?.[1];
    if (snippet) {
      const failedIndex = queries.findIndex((q) => q.query.includes(snippet));
      if (failedIndex !== -1) {
        const lines = (queries[failedIndex]?.query ?? "").split("\n");
        const line = lines.findIndex((l) => l.includes(snippet));
        message = `Syntax error at line ${line + 1} near "${snippet}"`;
      }
    }
  }

  let description: string | undefined = source.detail || source.hint;
  if (!description && queries[index]?.query) description = `Failed query: ${queries[index].query}`;

  for (const [code, text] of [
    ["ECONNREFUSED", "Connection refused"],
    ["ENOTFOUND", "Host not found"],
    ["ETIMEDOUT", "Connection timed out"],
  ] as const) {
    if (source.message.includes(code)) {
      message = text;
      description = source.message.split(`${code} `)[1]?.trim() ?? description;
    }
  }
  return new Error(description ? `${message}: ${description}` : message, { cause: error });
}
