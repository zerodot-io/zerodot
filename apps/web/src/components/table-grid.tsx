// SPDX-License-Identifier: AGPL-3.0-only
import type { Filter, FilterOp } from "@zerodot/engine";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zerodot/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Json } from "../lib/json";
import { cellText, parseCell } from "../lib/table-values";
import {
  type ColumnJson,
  deleteRowsFn,
  queryRowsFn,
  type RowJson,
  type TableSummary,
  updateRowFn,
} from "../server/table-fns";
import { RowDialog } from "./row-dialog";

const PAGE_SIZE = 50;

type Condition = { field: string; op: string; value: string };
type Sort = { field: string; direction: "asc" | "desc" } | null;

const OPS_BY_TYPE: Record<ColumnJson["type"], string[]> = {
  string: ["eq", "neq", "contains", "empty", "notEmpty"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "empty", "notEmpty"],
  boolean: ["eq", "empty", "notEmpty"],
  json: ["contains", "empty", "notEmpty"],
};

const OP_LABEL: Record<string, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  empty: "is empty",
  notEmpty: "is not empty",
};

/** The filter the server takes, or the message about the first bad condition. */
function buildFilter(
  columns: ColumnJson[],
  conditions: Condition[],
): { filter: Filter | undefined } | { problem: string } {
  const parts: Filter[] = [];
  for (const c of conditions) {
    const column = columns.find((col) => col.key === c.field);
    if (!column) continue;
    if (c.op === "empty") parts.push({ field: c.field, op: "isNull" });
    else if (c.op === "notEmpty") parts.push({ field: c.field, op: "isNull", value: false });
    else {
      const parsed =
        c.op === "contains" && column.type === "string"
          ? { value: c.value }
          : parseCell(column.type, c.value);
      if ("problem" in parsed) return { problem: `${c.field}: ${parsed.problem}` };
      parts.push({ field: c.field, op: c.op as FilterOp, value: parsed.value });
    }
  }
  return { filter: parts.length > 0 ? { and: parts } : undefined };
}

function display(value: Json | undefined): string {
  if (value === null || value === undefined) return "";
  const text = cellText(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function Cell({
  column,
  row,
  canEdit,
  onSave,
}: {
  column: ColumnJson;
  row: RowJson;
  canEdit: boolean;
  onSave: (rowId: string, key: string, value: Json) => Promise<string | null>;
}) {
  const value = row[column.key];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  async function commit() {
    if (done.current) return;
    done.current = true;
    const parsed = parseCell(column.type, text);
    if ("problem" in parsed) {
      setError(parsed.problem);
      done.current = false;
      return;
    }
    if (JSON.stringify(parsed.value) === JSON.stringify(value ?? null)) {
      setEditing(false);
      return;
    }
    const problem = await onSave(row.id, column.key, parsed.value);
    if (problem) {
      setError(problem);
      done.current = false;
    } else setEditing(false);
  }

  if (column.type === "boolean") {
    return (
      <Switch
        aria-label={column.key}
        disabled={!canEdit}
        checked={value === true}
        onCheckedChange={(checked) => void onSave(row.id, column.key, checked)}
      />
    );
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1">
        <Input
          autoFocus
          aria-label={column.key}
          className="font-mono"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") {
              done.current = true;
              setEditing(false);
              setError(null);
            }
          }}
        />
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  }

  const shown = display(value);
  const startEdit = () => {
    done.current = false;
    setText(cellText(value));
    setError(null);
    setEditing(true);
  };
  return canEdit ? (
    <button
      type="button"
      className="block min-h-6 w-full text-left font-mono text-xs"
      onClick={startEdit}
    >
      {shown || <span className="text-muted-foreground">—</span>}
    </button>
  ) : (
    <span className="font-mono text-xs">
      {shown || <span className="text-muted-foreground">—</span>}
    </span>
  );
}

export function TableGrid({
  projectSlug,
  table,
  canEdit,
  onCountChanged,
}: {
  projectSlug: string;
  table: TableSummary;
  canEdit: boolean;
  onCountChanged: () => void;
}) {
  const [rows, setRows] = useState<RowJson[]>([]);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [next, setNext] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  const [draft, setDraft] = useState<Condition[]>([]);
  const [applied, setApplied] = useState<Filter | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const page = cursors.length - 1;

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const result = await queryRowsFn({
          data: {
            projectSlug,
            tableId: table.id,
            query: {
              ...(applied ? { filter: applied } : {}),
              ...(sort ? { sort: [sort] } : {}),
              limit: PAGE_SIZE,
              cursor,
            },
          },
        });
        setRows(result.rows);
        setNext(result.nextCursor);
        setSelected(new Set());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not load the rows");
      } finally {
        setLoading(false);
      }
    },
    [projectSlug, table.id, applied, sort],
  );

  // A new filter, sort, or table starts at the first page.
  useEffect(() => {
    setCursors([null]);
    void load(null);
  }, [load]);

  async function saveCell(rowId: string, key: string, value: Json): Promise<string | null> {
    try {
      const updated = await updateRowFn({
        data: { projectSlug, tableId: table.id, rowId, set: { [key]: value } },
      });
      setRows((all) => all.map((r) => (r.id === rowId ? updated : r)));
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : "Could not save";
    }
  }

  async function removeSelected() {
    const ids = [...selected];
    if (!window.confirm(`Delete ${ids.length} ${ids.length === 1 ? "row" : "rows"}?`)) return;
    try {
      await deleteRowsFn({ data: { projectSlug, tableId: table.id, ids } });
      onCountChanged();
      await load(cursors[page] ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete");
    }
  }

  function applyFilters() {
    const built = buildFilter(table.columns, draft);
    if ("problem" in built) {
      setError(built.problem);
      return;
    }
    setApplied(built.filter);
  }

  function toggleSort(field: string) {
    setSort((current) =>
      current?.field !== field
        ? { field, direction: "asc" }
        : current.direction === "asc"
          ? { field, direction: "desc" }
          : null,
    );
  }

  const addCondition = () => {
    const first = table.columns[0];
    if (first)
      setDraft((all) => [
        ...all,
        { field: first.key, op: OPS_BY_TYPE[first.type][0] ?? "eq", value: "" },
      ]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {draft.map((c, index) => {
          const column = table.columns.find((col) => col.key === c.field) ?? table.columns[0];
          const ops = column ? OPS_BY_TYPE[column.type] : [];
          const needsValue = c.op !== "empty" && c.op !== "notEmpty";
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no ids
            <div key={index} className="flex items-center gap-2">
              <Select
                value={c.field}
                onValueChange={(field) => {
                  const next = table.columns.find((col) => col.key === field);
                  if (!field || !next) return;
                  setDraft((all) =>
                    all.map((x, i) =>
                      i === index ? { field, op: OPS_BY_TYPE[next.type][0] ?? "eq", value: "" } : x,
                    ),
                  );
                }}
              >
                <SelectTrigger aria-label="Column" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {table.columns.map((col) => (
                    <SelectItem key={col.key} value={col.key}>
                      {col.key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={c.op}
                onValueChange={(op) =>
                  op && setDraft((all) => all.map((x, i) => (i === index ? { ...x, op } : x)))
                }
              >
                <SelectTrigger aria-label="Operator" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ops.map((op) => (
                    <SelectItem key={op} value={op}>
                      {OP_LABEL[op]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {needsValue && (
                <Input
                  aria-label="Value"
                  className="w-56"
                  value={c.value}
                  onChange={(event) =>
                    setDraft((all) =>
                      all.map((x, i) => (i === index ? { ...x, value: event.target.value } : x)),
                    )
                  }
                  onKeyDown={(event) => event.key === "Enter" && applyFilters()}
                />
              )}
              <Button
                variant="ghost"
                onClick={() => {
                  const rest = draft.filter((_, i) => i !== index);
                  setDraft(rest);
                  if (rest.length === 0) setApplied(undefined);
                }}
              >
                Remove
              </Button>
            </div>
          );
        })}
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={addCondition}>
            Add filter
          </Button>
          {draft.length > 0 && <Button onClick={applyFilters}>Apply</Button>}
          <div className="flex-1" />
          {selected.size > 0 && canEdit && (
            <Button variant="ghost" onClick={removeSelected}>
              Delete {selected.size} {selected.size === 1 ? "row" : "rows"}
            </Button>
          )}
          {canEdit && <Button onClick={() => setAdding(true)}>Add row</Button>}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}

      <Table>
        <TableHeader>
          <TableRow>
            {canEdit && <TableHead className="w-8" />}
            {table.columns.map((column) => (
              <TableHead key={column.key}>
                <button
                  type="button"
                  className="font-mono font-medium"
                  disabled={column.type === "json"}
                  onClick={() => toggleSort(column.key)}
                >
                  {column.key}
                  {sort?.field === column.key && (sort.direction === "asc" ? " ↑" : " ↓")}
                </button>
              </TableHead>
            ))}
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              {canEdit && (
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label="Select row"
                    checked={selected.has(row.id)}
                    onChange={(event) =>
                      setSelected((all) => {
                        const copy = new Set(all);
                        if (event.target.checked) copy.add(row.id);
                        else copy.delete(row.id);
                        return copy;
                      })
                    }
                  />
                </TableCell>
              )}
              {table.columns.map((column) => (
                <TableCell key={column.key}>
                  <Cell column={column} row={row} canEdit={canEdit} onSave={saveCell} />
                </TableCell>
              ))}
              <TableCell className="text-muted-foreground">
                {new Date(row.createdAt).toLocaleString()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {!loading && rows.length === 0 && (
        <p className="text-muted-foreground">
          {applied ? "No rows match the filter." : "No rows yet."}
        </p>
      )}

      <div className="flex items-center justify-between">
        <span className="text-muted-foreground">Page {page + 1}</span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={page === 0 || loading}
            onClick={() => {
              const back = cursors.slice(0, -1);
              setCursors(back);
              void load(back[back.length - 1] ?? null);
            }}
          >
            Previous
          </Button>
          <Button
            variant="ghost"
            disabled={!next || loading}
            onClick={() => {
              setCursors((all) => [...all, next]);
              void load(next);
            }}
          >
            Next
          </Button>
        </div>
      </div>

      {adding && (
        <RowDialog
          projectSlug={projectSlug}
          table={table}
          onClose={() => setAdding(false)}
          onSaved={() => {
            onCountChanged();
            void load(cursors[page] ?? null);
          }}
        />
      )}
    </div>
  );
}
