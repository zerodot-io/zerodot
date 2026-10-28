// SPDX-License-Identifier: AGPL-3.0-only
import { csvCellValue, parseCsv } from "@zerodot/engine";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zerodot/ui";
import { useState } from "react";
import type { Json } from "../lib/json";
import { insertRowsFn, type TableSummary } from "../server/table-fns";

const SKIP = "__skip__";
const BATCH = 500;
const MAX_CSV_BYTES = 20 * 1024 * 1024;

/** Step 1: pick a file. Step 2: map the CSV headers to columns. Then import in batches. */
export function CsvImportDialog({
  projectSlug,
  table,
  onClose,
  onImported,
}: {
  projectSlug: string;
  table: TableSummary;
  onClose: () => void;
  onImported: () => void;
}) {
  const [csv, setCsv] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);

  const headers = csv?.[0] ?? [];
  const dataRows = csv?.slice(1) ?? [];

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_CSV_BYTES) {
      setError("The file is larger than 20 MB");
      return;
    }
    const parsed = parseCsv(await file.text());
    if (parsed.length < 2) {
      setError("The file needs a header line and at least one row");
      return;
    }
    const head = parsed[0] ?? [];
    setCsv(parsed);
    setMapping(
      Object.fromEntries(
        table.columns.map((c) => [
          c.key,
          head.find((h) => h.trim().toLowerCase() === c.key.toLowerCase()) ?? SKIP,
        ]),
      ),
    );
  }

  async function run() {
    setError(null);
    const mapped = table.columns.filter((c) => mapping[c.key] && mapping[c.key] !== SKIP);
    if (mapped.length === 0) {
      setError("Map at least one column");
      return;
    }
    const rows: Record<string, Json>[] = [];
    const problems: string[] = [];
    for (const [index, cells] of dataRows.entries()) {
      const row: Record<string, Json> = {};
      for (const column of mapped) {
        const at = headers.indexOf(mapping[column.key] ?? "");
        const value = csvCellValue(column.type, cells[at] ?? "");
        if (value === undefined) {
          problems.push(`Line ${index + 2}: "${column.key}" is not a valid ${column.type}`);
        } else if (value !== null) {
          row[column.key] = value as Json;
        }
      }
      rows.push(row);
    }
    if (problems.length > 0) {
      setError(
        `${problems.slice(0, 5).join(". ")}${problems.length > 5 ? `. ${problems.length - 5} more.` : ""}`,
      );
      return;
    }
    let done = 0;
    setProgress(0);
    try {
      for (let i = 0; i < rows.length; i += BATCH) {
        await insertRowsFn({
          data: { projectSlug, tableId: table.id, rows: rows.slice(i, i + BATCH) },
        });
        done = Math.min(i + BATCH, rows.length);
        setProgress(done);
      }
      onImported();
      onClose();
    } catch (caught) {
      onImported();
      const message = caught instanceof Error ? caught.message : "Could not import";
      setError(
        `${done} of ${rows.length} rows were added. Lines ${done + 2} to ${Math.min(done + BATCH, rows.length) + 1} failed: ${message}`,
      );
      setProgress(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && progress === null && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import CSV into {table.name}</DialogTitle>
        </DialogHeader>
        {!csv ? (
          <div className="flex flex-col gap-2">
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="CSV file"
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
            <p className="text-muted-foreground">
              The first line holds the headers. An empty cell stays empty, or takes the default.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">
              {dataRows.length} {dataRows.length === 1 ? "row" : "rows"}. Pick the CSV header for
              each column.
            </p>
            {table.columns.map((column) => (
              <div key={column.key} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate font-mono">{column.key}</span>
                <Select
                  value={mapping[column.key] ?? SKIP}
                  onValueChange={(value) =>
                    value && setMapping((all) => ({ ...all, [column.key]: value }))
                  }
                >
                  <SelectTrigger aria-label={`Header for ${column.key}`} className="min-w-0 flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={SKIP}>Skip</SelectItem>
                    {headers.map((h, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: headers can repeat
                      <SelectItem key={i} value={h}>
                        {h}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          {progress !== null && (
            <span className="text-muted-foreground">
              {progress} of {dataRows.length}
            </span>
          )}
          <Button variant="ghost" onClick={onClose} disabled={progress !== null}>
            Cancel
          </Button>
          {csv && (
            <Button onClick={run} disabled={progress !== null}>
              Import
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
