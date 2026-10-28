// SPDX-License-Identifier: AGPL-3.0-only
import type { Column } from "@zerodot/engine";
import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

export const dataTable = pgTable(
  "data_table",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    columns: jsonb("columns").$type<Column[]>().notNull().default(sql`'[]'::jsonb`),
    /** Kept up to date by the row writes. A writer locks this row to check the row limit. */
    rowCount: integer("row_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("data_table_name_unique").on(t.organizationId, t.name),
    index("data_table_org_idx").on(t.organizationId),
  ],
);

export const dataTableRow = pgTable(
  "data_table_row",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tableId: uuid("table_id")
      .notNull()
      .references(() => dataTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Column values. A column without a value has no key. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByRunId: uuid("created_by_run_id"),
  },
  (t) => [
    index("data_table_row_page_idx").on(t.tableId, t.createdAt, t.id),
    index("data_table_row_data_idx").using("gin", t.data),
  ],
);

/**
 * Values of the columns marked `unique`. JSONB cannot hold a unique index for one key,
 * so each value of a unique column has a row here. A null value has no row.
 */
export const dataTableUnique = pgTable(
  "data_table_unique",
  {
    tableId: uuid("table_id")
      .notNull()
      .references(() => dataTable.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** The value as JSON text. */
    value: text("value").notNull(),
    rowId: uuid("row_id")
      .notNull()
      .references(() => dataTableRow.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.tableId, t.key, t.value] }),
    index("data_table_unique_row_idx").on(t.rowId),
  ],
);
