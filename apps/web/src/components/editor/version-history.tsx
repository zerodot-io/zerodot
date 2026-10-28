// SPDX-License-Identifier: AGPL-3.0-only
import { Button, Sheet, SheetContent, SheetHeader, SheetTitle } from "@zerodot/ui";
import { useEffect, useState } from "react";
import type { Json } from "../../lib/json";
import { getVersionFn, listVersionsFn, restoreVersionFn } from "../../server/fns";

type VersionItem = Awaited<ReturnType<typeof listVersionsFn>>[number];
type VersionDetail = Awaited<ReturnType<typeof getVersionFn>>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** What restoring a version changes in the draft, as short lines. */
export function diffLines(diff: VersionDetail["diff"]): string[] {
  const lines: string[] = [];
  for (const n of diff.addedNodes) lines.push(`Adds ${n.name}`);
  for (const n of diff.removedNodes) lines.push(`Removes ${n.name}`);
  for (const n of diff.changedNodes) lines.push(`Changes ${n.name} (${n.fields.join(", ")})`);
  if (diff.addedEdges > 0) lines.push(`Adds ${plural(diff.addedEdges, "connection")}`);
  if (diff.removedEdges > 0) lines.push(`Removes ${plural(diff.removedEdges, "connection")}`);
  return lines;
}

export function VersionHistory({
  open,
  onOpenChange,
  container,
  projectSlug,
  workflowId,
  onRestored,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  projectSlug: string;
  workflowId: string;
  /** The draft now holds the restored graph. */
  onRestored: (draftGraph: Json, version: number) => void;
}) {
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setDetail(null);
    setConfirming(false);
    setError(null);
    listVersionsFn({ data: { projectSlug, workflowId } })
      .then(setVersions)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the versions"));
  }, [open, projectSlug, workflowId]);

  async function select(version: number) {
    setSelected(version);
    setDetail(null);
    setConfirming(false);
    setError(null);
    try {
      setDetail(await getVersionFn({ data: { projectSlug, workflowId, version } }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the version");
    }
  }

  async function restore() {
    if (selected === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await restoreVersionFn({
        data: { projectSlug, workflowId, version: selected },
      });
      onRestored(result.draftGraph, selected);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not restore the version");
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const lines = detail ? diffLines(detail.diff) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent container={container}>
        <SheetHeader>
          <SheetTitle>Version history</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {versions === null && !error && <p className="text-muted-foreground">Loading…</p>}
          {versions?.length === 0 && (
            <p className="text-muted-foreground">
              No version yet. Publish the workflow to save one.
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {versions?.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  aria-pressed={selected === v.version}
                  onClick={() => select(v.version)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left hover:bg-muted aria-pressed:bg-muted"
                >
                  <span className="font-medium">Version {v.version}</span>
                  <span className="text-muted-foreground">
                    {v.published ? "Live · " : ""}
                    {new Date(v.createdAt).toLocaleString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {selected !== null && detail && (
            <div className="flex flex-col gap-3 border-t pt-4">
              <span className="font-medium">
                Restoring version {detail.version} ({plural(detail.nodeCount, "node")})
              </span>
              {lines.length === 0 ? (
                <p className="text-muted-foreground">The draft is the same as this version.</p>
              ) : (
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              <p className="text-muted-foreground">
                This replaces the draft. The live version does not change until you publish.
              </p>
              {confirming ? (
                <div className="flex gap-2">
                  <Button disabled={busy} onClick={restore}>
                    Replace the draft
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="outline" onClick={() => setConfirming(true)}>
                  Restore to draft
                </Button>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
