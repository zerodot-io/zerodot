// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { loadPostgres, POSTGRES_CREDENTIAL_TYPES, postgresOptions } from "./postgres";
import { qualified, quoteIdent } from "./postgres-sql";

const EVENTS = ["INSERT", "UPDATE", "DELETE"] as const;

/** A NOTIFY payload can hold less than 8000 bytes. A bigger row is sent without its data. */
const MAX_PAYLOAD_BYTES = 7900;

const config = z.object({
  schema: z.string().min(1).default("public").meta({ title: "Schema" }),
  table: z.string().min(1).meta({ title: "Table" }),
  events: z
    .array(z.enum(EVENTS))
    .min(1)
    .default(["INSERT"])
    .meta({
      title: "Events",
      labels: { INSERT: "Insert", UPDATE: "Update", DELETE: "Delete" },
      hints: {
        INSERT: "A row is added to the table",
        UPDATE: "A row of the table changes. The run gets the new and the old row",
        DELETE: "A row is removed from the table",
      },
    }),
});

type ListenConfig = z.output<typeof config>;

/** Names of what the node makes in the database. They are the same each time the node starts. */
export function listenNames(workflowId: string, nodeId: string) {
  const id = createHash("sha256").update(`${workflowId}:${nodeId}`).digest("hex").slice(0, 16);
  return { channel: `zerodot_${id}`, function: `zerodot_${id}`, trigger: `zerodot_${id}` };
}

/** The SQL that makes the function and the trigger. The names are made of hex, so they are safe. */
export function installStatements(
  cfg: Pick<ListenConfig, "schema" | "table" | "events">,
  names: ReturnType<typeof listenNames>,
): string[] {
  const fn = qualified(cfg.schema, names.function);
  const table = qualified(cfg.schema, cfg.table);
  const full = `json_build_object('txid', txid_current(), 'event', TG_OP, 'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'row', CASE WHEN TG_OP = 'DELETE' THEN row_to_json(OLD) ELSE row_to_json(NEW) END, 'old', CASE WHEN TG_OP = 'UPDATE' THEN row_to_json(OLD) END)::text`;
  const short = `json_build_object('txid', txid_current(), 'event', TG_OP, 'schema', TG_TABLE_SCHEMA, 'table', TG_TABLE_NAME, 'truncated', true)::text`;
  return [
    // A failing function would fail the write of the user, so it never raises an error.
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $zerodot$
DECLARE payload text;
BEGIN
  payload := ${full};
  IF octet_length(payload) > ${MAX_PAYLOAD_BYTES} THEN payload := ${short}; END IF;
  PERFORM pg_notify('${names.channel}', payload);
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$zerodot$`,
    `DROP TRIGGER IF EXISTS ${quoteIdent(names.trigger)} ON ${table}`,
    `CREATE TRIGGER ${quoteIdent(names.trigger)} AFTER ${cfg.events.join(" OR ")} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  ];
}

export function removeStatements(
  cfg: Pick<ListenConfig, "schema" | "table">,
  names: ReturnType<typeof listenNames>,
): string[] {
  return [
    `DROP TRIGGER IF EXISTS ${quoteIdent(names.trigger)} ON ${qualified(cfg.schema, cfg.table)}`,
    `DROP FUNCTION IF EXISTS ${qualified(cfg.schema, names.function)}()`,
  ];
}

/** Turns the text of a notification into the item of a run. The key is the same for one event. */
export function toListenItem(payload: string): { key: string; data: unknown } {
  let data: unknown = payload;
  try {
    data = JSON.parse(payload);
  } catch {
    // Not from this node. Pass the text on.
  }
  return { key: createHash("sha256").update(payload).digest("hex").slice(0, 32), data };
}

export default defineNode({
  type: "trigger.postgres_listen",
  label: "On Postgres event",
  description: "Start a run at once when a row is added, changed or removed",
  category: "trigger",
  app: "Postgres",
  icon: "Database",
  iconUrl: "/icons/postgresql.svg",
  config,
  defaultConfig: { schema: "public", table: "", events: ["INSERT"] },
  credentialTypes: POSTGRES_CREDENTIAL_TYPES,
  ports: { in: [], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.table === "string" && cfg.table !== "" ? cfg.table : undefined),
  // The input is the event that started the run.
  run: ({ input }) => ({ port: "out", data: input }),
  async listen({ config: cfg, credential, workflow, node, signal, emit, fail }) {
    const names = listenNames(workflow.id, node.id);
    const postgres = await loadPostgres();
    const sql = postgres(postgresOptions(credential));
    const abort = () => void sql.end({ timeout: 0 });
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (const statement of installStatements(cfg, names)) await sql.unsafe(statement);
      // Events go to the runs in the order they came.
      let chain: Promise<void> = Promise.resolve();
      const listener = await sql.listen(names.channel, (payload) => {
        chain = chain
          .then(() => emit(toListenItem(payload)))
          .catch((error) => fail(error instanceof Error ? error : new Error(String(error))));
      });
      return {
        async close({ remove }) {
          signal.removeEventListener("abort", abort);
          try {
            await listener.unlisten();
            await chain;
            if (remove)
              for (const statement of removeStatements(cfg, names)) await sql.unsafe(statement);
          } finally {
            await sql.end({ timeout: 5 });
          }
        },
      };
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await sql.end({ timeout: 5 });
      throw error;
    }
  },
});
