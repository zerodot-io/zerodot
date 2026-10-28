// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { formatCsvLine } from "@zerodot/engine";
import { Button, Input } from "@zerodot/ui";
import { useState } from "react";
import { ColumnsDialog } from "../components/columns-dialog";
import { CsvImportDialog } from "../components/csv-import-dialog";
import { TableGrid } from "../components/table-grid";
import {
  deleteTableFn,
  getTableFn,
  queryRowsFn,
  renameTableFn,
  type TableSummary,
} from "../server/table-fns";

export const Route = createFileRoute("/p/$projectSlug/tables/$tableId")({
  loader: ({ params }) =>
    getTableFn({ data: { projectSlug: params.projectSlug, tableId: params.tableId } }),
  component: TablePage,
});

async function exportCsv(projectSlug: string, table: TableSummary) {
  const lines = [formatCsvLine(table.columns.map((c) => c.key))];
  let cursor: string | null = null;
  do {
    const page: Awaited<ReturnType<typeof queryRowsFn>> = await queryRowsFn({
      data: { projectSlug, tableId: table.id, query: { limit: 1000, cursor } },
    });
    for (const row of page.rows) lines.push(formatCsvLine(table.columns.map((c) => row[c.key])));
    cursor = page.nextCursor;
  } while (cursor);
  const url = URL.createObjectURL(new Blob([`${lines.join("\r\n")}\r\n`], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${table.name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function TablePage() {
  const loaded = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const { project } = Route.useRouteContext();
  const router = useRouter();
  const navigate = useNavigate();
  const isAdmin = project.role.split(",").some((r) => r === "owner" || r === "admin");
  const [table, setTable] = useState(loaded);
  const [dialog, setDialog] = useState<"columns" | "import" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // A new import or delete changes what the grid shows. Remount it.
  const [gridKey, setGridKey] = useState(0);

  async function refreshCount() {
    setTable(await getTableFn({ data: { projectSlug, tableId: table.id } }));
  }

  async function rename() {
    if (renaming === null) return;
    try {
      setTable(await renameTableFn({ data: { projectSlug, tableId: table.id, name: renaming } }));
      setRenaming(null);
      setMessage(null);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not rename");
    }
  }

  async function remove() {
    if (!window.confirm(`Delete "${table.name}" and its ${table.rowCount} rows?`)) return;
    try {
      await deleteTableFn({ data: { projectSlug, tableId: table.id } });
      await router.invalidate();
      await navigate({ to: "/p/$projectSlug/tables", params: { projectSlug } });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Could not delete");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <Link
            to="/p/$projectSlug/tables"
            params={{ projectSlug }}
            className="text-muted-foreground text-xs"
          >
            ← Data tables
          </Link>
          {renaming === null ? (
            <h1 className="font-semibold text-lg">{table.name}</h1>
          ) : (
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <Input
                autoFocus
                aria-label="Table name"
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
              />
              <Button type="submit">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
            </form>
          )}
          <span className="text-muted-foreground text-xs tabular-nums">
            {table.rowCount} {table.rowCount === 1 ? "row" : "rows"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => void exportCsv(projectSlug, table)}>
            Export CSV
          </Button>
          <Button variant="outline" onClick={() => setDialog("import")}>
            Import CSV
          </Button>
          {isAdmin && (
            <>
              <Button variant="ghost" onClick={() => setDialog("columns")}>
                Columns
              </Button>
              <Button variant="ghost" onClick={() => setRenaming(table.name)}>
                Rename
              </Button>
              <Button variant="ghost" className="text-destructive" onClick={remove}>
                Delete
              </Button>
            </>
          )}
        </div>
      </div>
      {table.description && <p className="text-muted-foreground">{table.description}</p>}
      {message && (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      )}
      {table.columns.length === 0 ? (
        <p className="text-muted-foreground">This table has no columns. Add one with Columns.</p>
      ) : (
        <TableGrid
          key={`${table.id}:${gridKey}:${table.columns.map((c) => `${c.key}/${c.type}`).join(",")}`}
          projectSlug={projectSlug}
          table={table}
          canEdit
          onCountChanged={() => void refreshCount()}
        />
      )}
      {dialog === "columns" && (
        <ColumnsDialog
          projectSlug={projectSlug}
          table={table}
          onClose={() => setDialog(null)}
          onChanged={setTable}
        />
      )}
      {dialog === "import" && (
        <CsvImportDialog
          projectSlug={projectSlug}
          table={table}
          onClose={() => setDialog(null)}
          onImported={() => {
            setGridKey((k) => k + 1);
            void refreshCount();
          }}
        />
      )}
    </main>
  );
}
