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
} from "@zerodot/ui";
import { type FormEvent, useState } from "react";
import { createTableFn, type TableSummary } from "../server/table-fns";
import { type ColumnDraft, ColumnFields, emptyColumn } from "./column-fields";

export function TableDialog({
  projectSlug,
  onClose,
  onCreated,
}: {
  projectSlug: string;
  onClose: () => void;
  onCreated: (table: TableSummary) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>([emptyColumn()]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const table = await createTableFn({
        data: { projectSlug, name, description, columns: columns.filter((c) => c.key !== "") },
      });
      onCreated(table);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the table");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New data table</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="table-name">Name</FieldLabel>
            <Input
              id="table-name"
              value={name}
              required
              placeholder="seen_ids"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="table-description">Description</FieldLabel>
            <Input
              id="table-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="font-medium">Columns</span>
            {columns.map((column, index) => (
              <ColumnFields
                // biome-ignore lint/suspicious/noArrayIndexKey: the list has no ids, rows are edited in place
                key={index}
                value={column}
                onChange={(next) =>
                  setColumns((all) => all.map((c, i) => (i === index ? next : c)))
                }
                onRemove={
                  columns.length > 1
                    ? () => setColumns((all) => all.filter((_, i) => i !== index))
                    : undefined
                }
              />
            ))}
            <div>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setColumns((all) => [...all, emptyColumn()])}
              >
                Add column
              </Button>
            </div>
            <p className="text-muted-foreground">
              Every row also has id, createdAt, and updatedAt.
            </p>
          </div>
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
              Create table
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
