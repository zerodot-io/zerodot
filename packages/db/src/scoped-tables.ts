// SPDX-License-Identifier: AGPL-3.0-only
import {
  type Column,
  type ColumnType,
  checkRow,
  columnSchema,
  columnsSchema,
  DEFAULT_TABLE_MAX_ROWS,
  type Filter,
  ISO_DATE_PATTERN,
  MAX_INSERT_ROWS,
  MAX_QUERY_ROWS,
  MAX_ROW_BYTES,
  MAX_TABLES,
  type RowPage,
  type RowQuery,
  TableError,
  type TableRow,
  type TableStore,
  tableNameSchema,
  type UpdateInput,
  type UpsertInput,
} from "@zerodot/engine";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import type { Db } from "./client";
import { dataTable, dataTableRow, dataTableUnique } from "./schema";
import { ConflictError } from "./scoped-credentials";
import { compileFilter, compileSort, isUuid, jsonb } from "./table-query";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export type DataTableRow = typeof dataTable.$inferSelect;

export type AlterOp =
  | { op: "add"; column: unknown }
  | { op: "rename"; key: string; to: string }
  | { op: "retype"; key: string; type: ColumnType }
  | { op: "drop"; key: string };

/** `rows` of a change holds this many rows at most. `count` is the total. */
const RETURNED_ROWS = 100;
const INSERT_CHUNK = 500;

type RawRow = {
  id: string;
  data: unknown;
  created_at: string;
  updated_at: string;
  ts?: string;
  total?: number | string;
  bytes?: number | string;
};

/** Columns of a row query. The dates are ISO text in UTC. `ts` keeps the full precision. */
const ROW_COLUMNS = sql`r.id, r.data::text as data, r.created_at::text as ts,
  to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
  to_char(r.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at`;

function pgError(error: unknown): { code?: string; detail?: string } {
  const e = error as { code?: string; detail?: string; cause?: { code?: string; detail?: string } };
  return e?.code ? e : (e?.cause ?? {});
}

function parseData(raw: unknown): Record<string, unknown> {
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  return (value ?? {}) as Record<string, unknown>;
}

function toRow(columns: readonly Column[], raw: RawRow): TableRow {
  const data = parseData(raw.data);
  const row: TableRow = { id: raw.id, createdAt: raw.created_at, updatedAt: raw.updated_at };
  for (const column of columns) row[column.key] = data[column.key] ?? null;
  return row;
}

const rowsOf = (result: unknown): RawRow[] => Array.from(result as ArrayLike<RawRow>);

/** The name of the column in a unique violation: Key (table_id, key, value)=(..., email, ...). */
function uniqueColumnOf(error: unknown): string | null {
  const detail = pgError(error).detail ?? "";
  return /\(table_id, key, value\)=\([^,]+, ([^,]+), /.exec(detail)?.[1] ?? null;
}

/** Zod errors become a TableError with the first message, so the user can read it. */
function parseOrThrow<T>(
  schema: {
    safeParse(
      value: unknown,
    ):
      | { success: true; data: T }
      | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const where = issue?.path.length ? ` (${issue.path.map(String).join(".")})` : "";
  throw new TableError(`${issue?.message ?? "The value is not valid"}${where}`);
}

function uniqueText(value: unknown): string {
  return JSON.stringify(value);
}

export function tables(db: Db, organizationId: string, options: { maxRows?: number } = {}) {
  const maxRows = options.maxRows ?? DEFAULT_TABLE_MAX_ROWS;
  const owned = (id: string) =>
    and(eq(dataTable.id, id), eq(dataTable.organizationId, organizationId));

  async function listAll(exec: Exec): Promise<DataTableRow[]> {
    return exec
      .select()
      .from(dataTable)
      .where(eq(dataTable.organizationId, organizationId))
      .orderBy(asc(dataTable.name));
  }

  const LOCKS = { share: "share", write: "no key update", alter: "update" } as const;

  /** The table for an id or a name. `lock` holds the table row until the transaction ends. */
  async function resolve(
    exec: Exec,
    ref: string,
    lock: keyof typeof LOCKS | null = null,
  ): Promise<DataTableRow> {
    const query = exec
      .select()
      .from(dataTable)
      .where(
        and(
          eq(dataTable.organizationId, organizationId),
          isUuid(ref) ? eq(dataTable.id, ref) : eq(dataTable.name, ref),
        ),
      );
    const [row] = lock ? await query.for(LOCKS[lock]) : await query;
    if (!row) throw new TableError(`Table "${ref}" does not exist`);
    return row;
  }

  const whereRows = (table: DataTableRow, filter: Filter | undefined): SQL => {
    const parts = [sql`r.table_id = ${table.id}::uuid`, sql`r.organization_id = ${organizationId}`];
    if (filter) parts.push(compileFilter(table.columns, filter));
    return sql.join(parts, sql` and `);
  };

  // ---- Reads ----

  async function queryRows(exec: Exec, table: DataTableRow, query: RowQuery): Promise<RowPage> {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_QUERY_ROWS);
    const sort = query.sort ?? [];
    const where = [whereRows(table, query.filter)];
    let offset = 0;
    if (query.cursor) {
      let cursor: { o?: number; ts?: string; id?: string };
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
      } catch {
        throw new TableError("The cursor is not valid");
      }
      if (sort.length > 0) {
        offset = Number.isInteger(cursor.o) && (cursor.o ?? 0) >= 0 ? (cursor.o ?? 0) : 0;
      } else if (cursor.ts && cursor.id && isUuid(cursor.id)) {
        where.push(sql`(r.created_at, r.id) > (${cursor.ts}::timestamptz, ${cursor.id}::uuid)`);
      } else {
        throw new TableError("The cursor is not valid");
      }
    }
    const order = sql.join(compileSort(table.columns, sort), sql`, `);
    const result = await exec.execute(sql`
      select ${ROW_COLUMNS} from data_table_row r
      where ${sql.join(where, sql` and `)}
      order by ${order} limit ${limit + 1} offset ${offset}`);
    const raws = rowsOf(result);
    const page = raws.slice(0, limit);
    const last = raws.length > limit ? page.at(-1) : undefined;
    let nextCursor: string | null = null;
    if (last) {
      const payload = sort.length > 0 ? { o: offset + limit } : { ts: last.ts, id: last.id };
      nextCursor = Buffer.from(JSON.stringify(payload)).toString("base64url");
    }
    return { rows: page.map((raw) => toRow(table.columns, raw)), nextCursor };
  }

  // ---- Writes. Each runs in one transaction. ----

  async function addRowCount(tx: Tx, table: DataTableRow, delta: number) {
    const result = await tx.execute(sql`
      update data_table set row_count = row_count + ${delta}
      where id = ${table.id}::uuid returning row_count`);
    const count = Number((rowsOf(result)[0] as unknown as { row_count: number }).row_count);
    if (delta > 0 && count > maxRows) {
      throw new TableError(`Table "${table.name}" can have ${maxRows} rows`);
    }
  }

  async function insertRows(
    tx: Tx,
    table: DataTableRow,
    inputs: Record<string, unknown>[],
    runId: string | null,
  ): Promise<TableRow[]> {
    if (inputs.length === 0) return [];
    if (inputs.length > MAX_INSERT_ROWS) {
      throw new TableError(`One call can add ${MAX_INSERT_ROWS} rows`);
    }
    const data = inputs.map((input, index) => {
      const checked = checkRow(table.columns, input, "insert");
      if (!checked.ok) {
        throw new TableError(
          inputs.length > 1 ? `Row ${index + 1}: ${checked.message}` : checked.message,
        );
      }
      return checked.data;
    });
    await addRowCount(tx, table, data.length);

    const inserted: {
      id: string;
      data: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    }[] = [];
    try {
      for (let i = 0; i < data.length; i += INSERT_CHUNK) {
        const chunk = data.slice(i, i + INSERT_CHUNK);
        const rows = await tx
          .insert(dataTableRow)
          .values(
            chunk.map((d) => ({
              tableId: table.id,
              organizationId,
              data: d,
              // `now()` is the same for every row of a statement. Paging needs insert order.
              createdAt: sql`clock_timestamp()`,
              createdByRunId: runId,
            })),
          )
          .returning();
        inserted.push(...rows);
      }
      const uniques = inserted.flatMap((row) =>
        table.columns
          .filter((c) => c.unique && row.data[c.key] !== undefined)
          .map((c) => ({
            tableId: table.id,
            key: c.key,
            value: uniqueText(row.data[c.key]),
            rowId: row.id,
          })),
      );
      for (let i = 0; i < uniques.length; i += INSERT_CHUNK) {
        await tx.insert(dataTableUnique).values(uniques.slice(i, i + INSERT_CHUNK));
      }
    } catch (error) {
      if (pgError(error).code === "23505") {
        const key = uniqueColumnOf(error);
        throw new TableError(
          key ? `Column "${key}" must be unique: this value exists` : "A value must be unique",
        );
      }
      throw error;
    }
    return inserted.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...Object.fromEntries(table.columns.map((c) => [c.key, row.data[c.key] ?? null])),
    }));
  }

  /** Checks `set` and `increment`. Returns the pieces of the change. */
  function planChange(table: DataTableRow, input: Pick<UpdateInput, "set" | "increment">) {
    const checked = checkRow(table.columns, input.set ?? {}, "patch");
    if (!checked.ok) throw new TableError(checked.message);
    const increments = Object.entries(input.increment ?? {});
    for (const [key, amount] of increments) {
      const column = table.columns.find((c) => c.key === key);
      if (!column) throw new TableError(`Unknown column "${key}"`);
      if (column.type !== "number") throw new TableError(`Column "${key}" is not a number`);
      if (column.unique)
        throw new TableError(`Column "${key}" is unique and cannot be incremented`);
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        throw new TableError(`The increment of "${key}" must be a number`);
      }
      if (key in checked.data) throw new TableError(`Column "${key}" is in set and in increment`);
    }
    const set: Record<string, unknown> = {};
    const clear: string[] = [];
    for (const [key, value] of Object.entries(checked.data)) {
      if (value === null) clear.push(key);
      else set[key] = value;
    }
    if (Object.keys(checked.data).length === 0 && increments.length === 0) {
      throw new TableError("Nothing to update: set a value or an increment");
    }
    const uniqueKeys = table.columns
      .filter((c) => c.unique && c.key in checked.data)
      .map((c) => c.key);
    return { set, clear, increments, uniqueKeys };
  }

  async function updateRows(
    tx: Tx,
    table: DataTableRow,
    input: UpdateInput,
  ): Promise<{ count: number; rows: TableRow[] }> {
    if (!input.filter && !input.all) {
      throw new TableError("Add a filter, or set all to true to change every row");
    }
    const plan = planChange(table, input);
    const where = whereRows(table, input.filter);

    // A unique value can go to one row only.
    let target = where;
    if (plan.uniqueKeys.length > 0) {
      const found = rowsOf(
        await tx.execute(sql`select r.id from data_table_row r where ${where} limit 2 for update`),
      );
      if (found.length > 1) {
        throw new TableError(
          `Column "${plan.uniqueKeys[0]}" is unique: the filter must match one row to change it`,
        );
      }
      if (found.length === 0) return { count: 0, rows: [] };
      target = sql`r.id = ${found[0]?.id}::uuid`;
    }

    let expression = sql`r.data`;
    if (plan.clear.length > 0) {
      expression = sql`(${expression} - ${sql`array[${sql.join(
        plan.clear.map((k) => sql`${k}::text`),
        sql`, `,
      )}]`})`;
    }
    if (Object.keys(plan.set).length > 0) expression = sql`(${expression} || ${jsonb(plan.set)})`;
    if (plan.increments.length > 0) {
      const pairs = plan.increments.flatMap(([key, amount]) => [
        sql`${key}::text`,
        sql`coalesce((r.data ->> ${key}::text)::numeric, 0) + ${String(amount)}::numeric`,
      ]);
      expression = sql`(${expression} || jsonb_build_object(${sql.join(pairs, sql`, `)}))`;
    }

    const result = await tx.execute(sql`
      with changed as (
        update data_table_row r set data = ${expression}, updated_at = now()
        where ${target}
        returning r.id, r.data, r.created_at, r.updated_at
      )
      select c.id, c.data::text as data, c.created_at::text as ts,
        to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
        to_char(c.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as updated_at,
        count(*) over () as total,
        (select max(octet_length(x.data::text)) from changed x) as bytes
      from changed c order by c.created_at, c.id limit ${RETURNED_ROWS}`);
    const raws = rowsOf(result);
    if (raws.length === 0) return { count: 0, rows: [] };
    if (Number(raws[0]?.bytes) > MAX_ROW_BYTES)
      throw new TableError("A row cannot be larger than 64 KB");

    if (plan.uniqueKeys.length > 0 && raws[0]) {
      const data = parseData(raws[0].data);
      await tx.execute(sql`
        delete from data_table_unique
        where row_id = ${raws[0].id}::uuid
          and key in (${sql.join(
            plan.uniqueKeys.map((k) => sql`${k}`),
            sql`, `,
          )})`);
      const values = plan.uniqueKeys
        .filter((k) => data[k] !== undefined)
        .map((k) => ({
          tableId: table.id,
          key: k,
          value: uniqueText(data[k]),
          rowId: raws[0]?.id ?? "",
        }));
      try {
        if (values.length > 0) await tx.insert(dataTableUnique).values(values);
      } catch (error) {
        if (pgError(error).code === "23505") {
          const key = uniqueColumnOf(error);
          throw new TableError(
            key ? `Column "${key}" must be unique: this value exists` : "A value must be unique",
          );
        }
        throw error;
      }
    }
    return {
      count: Number(raws[0]?.total ?? raws.length),
      rows: raws.map((raw) => toRow(table.columns, raw)),
    };
  }

  async function deleteRows(
    tx: Tx,
    table: DataTableRow,
    input: { filter?: Filter; all?: boolean },
  ): Promise<{ count: number }> {
    if (!input.filter && !input.all) {
      throw new TableError("Add a filter, or set all to true to delete every row");
    }
    const result = await tx.execute(sql`
      with gone as (delete from data_table_row r where ${whereRows(table, input.filter)} returning 1)
      select count(*)::int as n from gone`);
    const count = Number((rowsOf(result)[0] as unknown as { n: number }).n);
    if (count > 0) await addRowCount(tx, table, -count);
    return { count };
  }

  async function upsertRow(
    tx: Tx,
    table: DataTableRow,
    input: UpsertInput,
    runId: string | null,
  ): Promise<{ row: TableRow; created: boolean }> {
    const column = table.columns.find((c) => c.key === input.column);
    if (!column) throw new TableError(`Unknown column "${input.column}"`);
    if (!column.unique) throw new TableError(`Column "${input.column}" is not unique`);
    const keyCheck = checkRow(table.columns, { [column.key]: input.row[column.key] }, "patch");
    const keyValue = keyCheck.ok ? keyCheck.data[column.key] : undefined;
    if (!keyCheck.ok) throw new TableError(keyCheck.message);
    if (keyValue === undefined || keyValue === null) {
      throw new TableError(`The row needs a value for the unique column "${column.key}"`);
    }

    const existing = rowsOf(
      await tx.execute(sql`
        select row_id as id from data_table_unique
        where table_id = ${table.id}::uuid and key = ${column.key} and value = ${uniqueText(keyValue)}`),
    )[0];

    if (existing) {
      const { [column.key]: _same, ...set } = input.row;
      const hasChange =
        Object.keys(set).length > 0 || Object.keys(input.increment ?? {}).length > 0;
      const filter: Filter = { field: "id", op: "eq", value: existing.id };
      if (!hasChange) {
        const page = await queryRows(tx, table, { filter, limit: 1 });
        return { row: page.rows[0] as TableRow, created: false };
      }
      const changed = await updateRows(tx, table, { filter, set, increment: input.increment });
      return { row: changed.rows[0] as TableRow, created: false };
    }

    // New row: an increment starts from the default, or from 0.
    const row = { ...input.row };
    for (const [key, amount] of Object.entries(input.increment ?? {})) {
      const target = table.columns.find((c) => c.key === key);
      if (target?.type !== "number") throw new TableError(`Column "${key}" is not a number`);
      if (typeof amount !== "number" || !Number.isFinite(amount)) {
        throw new TableError(`The increment of "${key}" must be a number`);
      }
      if (key in row) throw new TableError(`Column "${key}" is in row and in increment`);
      const start = target.default;
      row[key] = (typeof start === "number" ? start : 0) + amount;
    }
    const [inserted] = await insertRows(tx, table, [row], runId);
    return { row: inserted as TableRow, created: true };
  }

  // ---- Public API ----

  const summary = (t: DataTableRow) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    columns: t.columns,
    rowCount: t.rowCount,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  });

  return {
    async list() {
      return (await listAll(db)).map(summary);
    },

    /** A table by id or name. Null when it does not exist. */
    async get(ref: string) {
      try {
        return summary(await resolve(db, ref));
      } catch (error) {
        if (error instanceof TableError) return null;
        throw error;
      }
    },

    async create(input: { name: string; description?: string; columns: unknown }) {
      const name = parseOrThrow(tableNameSchema, input.name);
      const columns = parseOrThrow(columnsSchema, input.columns) as Column[];
      return db.transaction(async (tx) => {
        const existing = await listAll(tx);
        if (existing.length >= MAX_TABLES) {
          throw new TableError(`A project can have ${MAX_TABLES} tables`);
        }
        try {
          const [row] = await tx
            .insert(dataTable)
            .values({ organizationId, name, description: input.description ?? "", columns })
            .returning();
          if (!row) throw new Error("insert returned no row");
          return summary(row);
        } catch (error) {
          if (pgError(error).code === "23505") throw new ConflictError(`Table "${name}" exists`);
          throw error;
        }
      });
    },

    async update(id: string, patch: { name?: string; description?: string }) {
      const values: Partial<typeof dataTable.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) values.name = parseOrThrow(tableNameSchema, patch.name);
      if (patch.description !== undefined) values.description = patch.description.slice(0, 500);
      try {
        const rows = await db.update(dataTable).set(values).where(owned(id)).returning();
        return rows[0] ? summary(rows[0]) : null;
      } catch (error) {
        if (pgError(error).code === "23505")
          throw new ConflictError(`Table "${patch.name}" exists`);
        throw error;
      }
    },

    async remove(id: string): Promise<boolean> {
      const rows = await db.delete(dataTable).where(owned(id)).returning({ id: dataTable.id });
      return rows.length > 0;
    },

    /** Add, rename, retype, or drop columns. All steps run in one transaction. */
    async alter(id: string, ops: AlterOp[]) {
      return db.transaction(async (tx) => {
        const table = await resolve(tx, id, "alter");
        let columns = [...table.columns];
        for (const op of ops) {
          if (op.op === "add") {
            const column = parseOrThrow(columnSchema, op.column) as Column;
            if (columns.some((c) => c.key === column.key)) {
              throw new TableError(`Column "${column.key}" exists`);
            }
            if (column.required && column.default === undefined && table.rowCount > 0) {
              throw new TableError("A required column needs a default when the table has rows");
            }
            columns = parseOrThrow(columnsSchema, [...columns, column]) as Column[];
            const backfill = checkRow([column], {}, "insert");
            if (backfill.ok && column.key in backfill.data) {
              await tx.execute(sql`
                update data_table_row r set data = r.data || ${jsonb(backfill.data)}
                where r.table_id = ${table.id}::uuid`);
            }
          } else if (op.op === "rename") {
            const column = columns.find((c) => c.key === op.key);
            if (!column) throw new TableError(`Unknown column "${op.key}"`);
            if (columns.some((c) => c.key === op.to))
              throw new TableError(`Column "${op.to}" exists`);
            columns = parseOrThrow(
              columnsSchema,
              columns.map((c) => (c.key === op.key ? { ...c, key: op.to } : c)),
            ) as Column[];
            await tx.execute(sql`
              update data_table_row r
              set data = (r.data - ${op.key}::text) || jsonb_build_object(${op.to}::text, r.data -> ${op.key}::text)
              where r.table_id = ${table.id}::uuid and jsonb_exists(r.data, ${op.key})`);
            await tx.execute(sql`
              update data_table_unique set key = ${op.to}
              where table_id = ${table.id}::uuid and key = ${op.key}`);
          } else if (op.op === "retype") {
            const column = columns.find((c) => c.key === op.key);
            if (!column) throw new TableError(`Unknown column "${op.key}"`);
            const next = columnsSchema.safeParse(
              columns.map((c) => (c.key === op.key ? { ...c, type: op.type } : c)),
            );
            if (!next.success) {
              throw new TableError(next.error.issues[0]?.message ?? "The type does not fit");
            }
            const fits = (() => {
              const value = sql`(r.data -> ${op.key}::text)`;
              switch (op.type) {
                case "string":
                  return sql`jsonb_typeof(${value}) = 'string'`;
                case "number":
                  return sql`jsonb_typeof(${value}) = 'number'`;
                case "boolean":
                  return sql`jsonb_typeof(${value}) = 'boolean'`;
                case "date":
                  return sql`(jsonb_typeof(${value}) = 'string' and (r.data ->> ${op.key}::text) ~ ${ISO_DATE_PATTERN.source})`;
                case "json":
                  return sql`true`;
              }
            })();
            const bad = rowsOf(
              await tx.execute(sql`
                select count(*)::int as total from data_table_row r
                where r.table_id = ${table.id}::uuid
                  and jsonb_exists(r.data, ${op.key}) and jsonb_typeof(r.data -> ${op.key}::text) <> 'null'
                  and not (${fits})`),
            )[0];
            if (Number(bad?.total) > 0) {
              throw new TableError(
                `${bad?.total} rows have a value in "${op.key}" that does not fit the type ${op.type}`,
              );
            }
            columns = next.data as Column[];
          } else {
            const column = columns.find((c) => c.key === op.key);
            if (!column) throw new TableError(`Unknown column "${op.key}"`);
            columns = columns.filter((c) => c.key !== op.key);
            await tx.execute(sql`
              update data_table_row r set data = r.data - ${op.key}::text
              where r.table_id = ${table.id}::uuid and jsonb_exists(r.data, ${op.key})`);
            await tx.execute(sql`
              delete from data_table_unique where table_id = ${table.id}::uuid and key = ${op.key}`);
          }
        }
        const [row] = await tx
          .update(dataTable)
          .set({ columns, updatedAt: new Date() })
          .where(owned(table.id))
          .returning();
        if (!row) throw new Error("update returned no row");
        return summary(row);
      });
    },

    async queryRows(ref: string, query: RowQuery): Promise<RowPage> {
      return queryRows(db, await resolve(db, ref), query);
    },

    async insertRows(ref: string, rows: Record<string, unknown>[], runId: string | null = null) {
      return db.transaction(async (tx) =>
        insertRows(tx, await resolve(tx, ref, "write"), rows, runId),
      );
    },

    async updateRows(ref: string, input: UpdateInput) {
      return db.transaction(async (tx) => updateRows(tx, await resolve(tx, ref, "share"), input));
    },

    async deleteRows(ref: string, input: { filter?: Filter; all?: boolean }) {
      return db.transaction(async (tx) => deleteRows(tx, await resolve(tx, ref, "write"), input));
    },

    /** The store for the table nodes. `runId` marks the rows that a run adds. */
    store(runId: string | null = null): TableStore {
      return {
        insert: (ref, rows) =>
          db.transaction(async (tx) =>
            insertRows(tx, await resolve(tx, ref, "write"), rows, runId),
          ),
        query: async (ref, query) => queryRows(db, await resolve(db, ref), query),
        async get(ref, by) {
          const table = await resolve(db, ref);
          if (by.field !== "id") {
            const column = table.columns.find((c) => c.key === by.field);
            if (!column) throw new TableError(`Unknown column "${by.field}"`);
            if (!column.unique) {
              throw new TableError(`Column "${by.field}" is not unique. Use table.query instead`);
            }
          }
          const page = await queryRows(db, table, {
            filter: { field: by.field, op: "eq", value: by.value },
            limit: 1,
          });
          return page.rows[0] ?? null;
        },
        update: (ref, input) =>
          db.transaction(async (tx) => updateRows(tx, await resolve(tx, ref, "share"), input)),
        upsert: (ref, input) =>
          db.transaction(async (tx) =>
            upsertRow(tx, await resolve(tx, ref, "write"), input, runId),
          ),
        delete: (ref, input) =>
          db.transaction(async (tx) => deleteRows(tx, await resolve(tx, ref, "write"), input)),
      };
    },
  };
}
