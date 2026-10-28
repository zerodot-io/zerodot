// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, POLL_MAX_ITEMS } from "@zerodot/engine";
import { z } from "zod";
import { loadPostgres, POSTGRES_CREDENTIAL_TYPES, postgresOptions } from "./postgres";
import { qualified, quoteIdent, type Row } from "./postgres-sql";

/** Name of the extra column that holds the tracking value as text. */
const CURSOR_COLUMN = "__zerodot_cursor";

const config = z.object({
  schema: z.string().min(1).default("public").meta({ title: "Schema" }),
  table: z.string().min(1).meta({ title: "Table" }),
  trackingColumn: z.string().min(1).default("id").meta({
    title: "Tracking column",
    description:
      "A column with a value that only goes up, for example id or created_at. A row with a bigger value than the last one starts a run.",
  }),
  intervalSeconds: z.number().int().min(15).max(86_400).default(60).meta({
    title: "Check every (seconds)",
  }),
});

type PollQuery = { query: string; values: string[] };

/** The first poll reads where the table is. Later polls read the rows after the cursor. */
export function buildPollQuery(
  cfg: { schema: string; table: string; trackingColumn: string },
  cursor: string | null,
  firstPoll: boolean,
): PollQuery {
  const table = qualified(cfg.schema, cfg.table);
  const column = quoteIdent(cfg.trackingColumn);
  if (firstPoll) {
    return {
      query: `SELECT max(${column})::text AS ${quoteIdent(CURSOR_COLUMN)} FROM ${table}`,
      values: [],
    };
  }
  const select = `SELECT *, ${column}::text AS ${quoteIdent(CURSOR_COLUMN)} FROM ${table}`;
  const order = `ORDER BY ${column} ASC LIMIT ${POLL_MAX_ITEMS}`;
  return cursor === null
    ? { query: `${select} WHERE ${column} IS NOT NULL ${order}`, values: [] }
    : { query: `${select} WHERE ${column} > $1 ${order}`, values: [cursor] };
}

export default defineNode({
  type: "trigger.postgres",
  label: "On new Postgres row",
  description: "Check a table on a timer and start a run for each new row",
  category: "trigger",
  app: "Postgres",
  icon: "Database",
  iconUrl: "/icons/postgresql.svg",
  config,
  defaultConfig: { schema: "public", table: "", trackingColumn: "id", intervalSeconds: 60 },
  credentialTypes: POSTGRES_CREDENTIAL_TYPES,
  ports: { in: [], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.table === "string" && cfg.table !== "" ? cfg.table : undefined),
  // The input is the row that started the run.
  run: ({ input }) => ({ port: "out", data: input }),
  async poll({ config: cfg, credential, cursor, firstPoll, signal }) {
    const postgres = await loadPostgres();
    const sql = postgres(postgresOptions(credential));
    const abort = () => void sql.end({ timeout: 0 });
    signal.addEventListener("abort", abort, { once: true });
    try {
      const last = typeof cursor === "string" ? cursor : null;
      const { query, values } = buildPollQuery(cfg, last, firstPoll);
      const rows = [...(await sql.unsafe(query, values))] as Row[];
      if (firstPoll) {
        const value = rows[0]?.[CURSOR_COLUMN];
        return { items: [], cursor: typeof value === "string" ? value : null };
      }
      const items = rows.map((row) => {
        const { [CURSOR_COLUMN]: key, ...data } = row;
        if (typeof key !== "string") throw new Error("A row has no value in the tracking column");
        return { key, data };
      });
      return { items, cursor: items.at(-1)?.key ?? last };
    } finally {
      signal.removeEventListener("abort", abort);
      await sql.end({ timeout: 5 });
    }
  },
});
