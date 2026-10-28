// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Switch,
  Textarea,
} from "@zerodot/ui";
import { type FormEvent, useState } from "react";
import type { Json } from "../lib/json";
import { parseCell } from "../lib/table-values";
import { insertRowsFn, type TableSummary } from "../server/table-fns";

/** Add one row. A field left empty stays empty (or takes the default of the column). */
export function RowDialog({
  projectSlug,
  table,
  onClose,
  onSaved,
}: {
  projectSlug: string;
  table: TableSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const row: Record<string, Json> = {};
    for (const column of table.columns) {
      if (column.type === "boolean") {
        if (column.key in flags) row[column.key] = flags[column.key] ?? false;
        continue;
      }
      const text = texts[column.key] ?? "";
      if (text === "") continue;
      const parsed = parseCell(column.type, text);
      if ("problem" in parsed) {
        setError(`${column.key}: ${parsed.problem}`);
        return;
      }
      row[column.key] = parsed.value;
    }
    setPending(true);
    try {
      await insertRowsFn({ data: { projectSlug, tableId: table.id, rows: [row] } });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the row");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add a row</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex max-h-[70svh] flex-col gap-3 overflow-y-auto">
          {table.columns.map((column) => {
            const id = `row-${column.key}`;
            return (
              <Field key={column.key}>
                <FieldLabel htmlFor={id}>
                  <span className="font-mono">{column.key}</span>
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    {column.type}
                    {column.required ? ", required" : ""}
                  </span>
                </FieldLabel>
                {column.type === "boolean" ? (
                  <Switch
                    id={id}
                    checked={flags[column.key] ?? false}
                    onCheckedChange={(checked) =>
                      setFlags((all) => ({ ...all, [column.key]: checked }))
                    }
                  />
                ) : column.type === "json" ? (
                  <Textarea
                    id={id}
                    rows={3}
                    spellCheck={false}
                    className="font-mono"
                    value={texts[column.key] ?? ""}
                    onChange={(event) =>
                      setTexts((all) => ({ ...all, [column.key]: event.target.value }))
                    }
                  />
                ) : (
                  <Input
                    id={id}
                    value={texts[column.key] ?? ""}
                    placeholder={column.default === undefined ? undefined : String(column.default)}
                    onChange={(event) =>
                      setTexts((all) => ({ ...all, [column.key]: event.target.value }))
                    }
                  />
                )}
              </Field>
            );
          })}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Add row
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
