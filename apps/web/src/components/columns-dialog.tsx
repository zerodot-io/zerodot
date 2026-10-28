// SPDX-License-Identifier: AGPL-3.0-only
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zerodot/ui";
import { useState } from "react";
import { alterTableFn, type ColumnJson, type TableSummary } from "../server/table-fns";
import { COLUMN_TYPES, type ColumnDraft, ColumnFields, emptyColumn } from "./column-fields";

type Op = Parameters<typeof alterTableFn>[0]["data"]["ops"][number];

/** Add, rename, retype, and delete columns. Each change is saved at once. */
export function ColumnsDialog({
  projectSlug,
  table,
  onClose,
  onChanged,
}: {
  projectSlug: string;
  table: TableSummary;
  onClose: () => void;
  onChanged: (table: TableSummary) => void;
}) {
  const [draft, setDraft] = useState<ColumnDraft>(emptyColumn());
  const [renaming, setRenaming] = useState<{ key: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function apply(op: Op): Promise<boolean> {
    setError(null);
    setPending(true);
    try {
      onChanged(await alterTableFn({ data: { projectSlug, tableId: table.id, ops: [op] } }));
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the columns");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function drop(column: ColumnJson) {
    if (!window.confirm(`Delete column "${column.key}" and its values in every row?`)) return;
    await apply({ op: "drop", key: column.key });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Columns of {table.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {table.columns.map((column) => (
            <div key={column.key} className="flex items-center gap-2">
              {renaming?.key === column.key ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await apply({ op: "rename", key: column.key, to: renaming.to })) {
                      setRenaming(null);
                    }
                  }}
                >
                  <Input
                    autoFocus
                    aria-label="New key"
                    className="font-mono"
                    value={renaming.to}
                    onChange={(event) => setRenaming({ key: column.key, to: event.target.value })}
                  />
                  <Button type="submit" disabled={pending}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </Button>
                </form>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-mono font-medium">
                    {column.key}
                  </span>
                  <Select
                    value={column.type}
                    onValueChange={(type) =>
                      type && type !== column.type
                        ? void apply({
                            op: "retype",
                            key: column.key,
                            type: type as ColumnJson["type"],
                          })
                        : undefined
                    }
                  >
                    <SelectTrigger aria-label={`Type of ${column.key}`} className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COLUMN_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {type}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {column.required && <Badge variant="secondary">required</Badge>}
                  {column.unique && <Badge variant="secondary">unique</Badge>}
                  <Button
                    variant="ghost"
                    onClick={() => setRenaming({ key: column.key, to: column.key })}
                  >
                    Rename
                  </Button>
                  <Button variant="ghost" onClick={() => drop(column)}>
                    Delete
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
        <form
          className="flex flex-col gap-2 border-t pt-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (draft.key && (await apply({ op: "add", column: draft }))) setDraft(emptyColumn());
          }}
        >
          <span className="font-medium">Add a column</span>
          <ColumnFields value={draft} onChange={setDraft} />
          <div>
            <Button type="submit" disabled={pending || draft.key === ""}>
              Add column
            </Button>
          </div>
        </form>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
