// SPDX-License-Identifier: AGPL-3.0-only

import { Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge, Button, Sheet, SheetContent, SheetHeader, SheetTitle, Spinner } from "@zerodot/ui";
import { useEffect, useState } from "react";
import { catalogByType } from "../../lib/flow";
import type { Json } from "../../lib/json";
import { getVersionFn, listVersionsFn, restoreVersionFn } from "../../server/fns";
import { NodeIcon } from "../node-icon";

type VersionItem = Awaited<ReturnType<typeof listVersionsFn>>[number];
type VersionDetail = Awaited<ReturnType<typeof getVersionFn>>;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Mark = "added" | "changed";

const MARK: Record<Mark, { ring: string; label: string; swatch: string }> = {
  added: { ring: "ring-emerald-500", label: "Comes back", swatch: "bg-emerald-500" },
  changed: { ring: "ring-amber-500", label: "Changes", swatch: "bg-amber-500" },
};

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "2 hours ago", "yesterday". Falls back to the date after a week. */
function ago(date: Date, now: number): string {
  const minutes = Math.round((date.getTime() - now) / 60_000);
  if (Math.abs(minutes) < 1) return "just now";
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return relative.format(days, "day");
  return date.toLocaleDateString();
}

/** Node size on the canvas, in canvas units. Only used to lay out the map. */
const NODE_W = 120;
const NODE_H = 60;

/** A small map of one version: its nodes as icons, its edges as lines. */
function VersionMap({ detail }: { detail: VersionDetail }) {
  if (detail.nodes.length === 0) {
    return (
      <div className="grid h-28 place-items-center rounded-lg bg-muted/50 text-muted-foreground">
        No nodes
      </div>
    );
  }
  const marks = new Map<string, Mark>();
  for (const n of detail.diff.addedNodes) marks.set(n.id, "added");
  for (const n of detail.diff.changedNodes) marks.set(n.id, "changed");
  const xs = detail.nodes.map((n) => n.x);
  const ys = detail.nodes.map((n) => n.y);
  const minX = Math.min(...xs) - NODE_W / 2;
  const minY = Math.min(...ys) - NODE_H / 2;
  const width = Math.max(...xs) - minX + NODE_W * 1.5;
  const height = Math.max(...ys) - minY + NODE_H * 1.5;
  // Center of a node, in percent of the map.
  const at = (n: { x: number; y: number }) => ({
    left: ((n.x - minX + NODE_W / 2) / width) * 100,
    top: ((n.y - minY + NODE_H / 2) / height) * 100,
  });
  const byId = new Map(detail.nodes.map((n) => [n.id, n]));
  return (
    <div
      className="relative overflow-hidden rounded-lg bg-muted/50 bg-[radial-gradient(var(--color-border)_1px,transparent_1px)] bg-size-[12px_12px]"
      style={{ aspectRatio: `${Math.max(width / height, 1.6)}`, maxHeight: 180 }}
    >
      <svg
        aria-hidden="true"
        className="absolute inset-0 size-full text-muted-foreground/50"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
      >
        {detail.edges.map((e) => {
          const from = byId.get(e.from);
          const to = byId.get(e.to);
          if (!from || !to) return null;
          const a = at(from);
          const b = at(to);
          const mid = (a.left + b.left) / 2;
          return (
            <path
              key={`${e.from}-${e.to}`}
              d={`M ${a.left} ${a.top} C ${mid} ${a.top}, ${mid} ${b.top}, ${b.left} ${b.top}`}
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {detail.nodes.map((n) => {
        const entry = catalogByType.get(n.type);
        const mark = marks.get(n.id);
        const pos = at(n);
        return (
          <span
            key={n.id}
            title={n.name}
            className={`absolute grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-lg border bg-card shadow-xs ${mark ? `ring-2 ring-offset-1 ring-offset-background ${MARK[mark].ring}` : ""}`}
            style={{ left: `${pos.left}%`, top: `${pos.top}%` }}
          >
            <NodeIcon
              name={entry?.icon ?? "CircleIcon"}
              src={entry?.iconUrl}
              variant="tile"
              category={entry?.category}
              className="size-4"
            />
          </span>
        );
      })}
    </div>
  );
}

/** What restoring changes, as marked rows. */
function Changes({ diff }: { diff: VersionDetail["diff"] }) {
  const rows: { key: string; sign: string; tone: string; text: string }[] = [
    ...diff.addedNodes.map((n) => ({
      key: `a-${n.id}`,
      sign: "+",
      tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
      text: n.name,
    })),
    ...diff.changedNodes.map((n) => ({
      key: `c-${n.id}`,
      sign: "~",
      tone: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
      text: `${n.name} · ${n.fields.join(", ")}`,
    })),
    ...diff.removedNodes.map((n) => ({
      key: `r-${n.id}`,
      sign: "−",
      tone: "bg-red-500/15 text-red-700 dark:text-red-400",
      text: n.name,
    })),
  ];
  const edges = [
    diff.addedEdges > 0 && `+${plural(diff.addedEdges, "connection")}`,
    diff.removedEdges > 0 && `−${plural(diff.removedEdges, "connection")}`,
  ].filter((x): x is string => typeof x === "string");
  if (rows.length === 0 && edges.length === 0) {
    return <p className="text-muted-foreground">The draft is the same as this version.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.key} className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={`grid size-5 shrink-0 place-items-center rounded font-mono ${row.tone}`}
            >
              {row.sign}
            </span>
            <span className="sr-only">
              {row.sign === "+" ? "Adds" : row.sign === "~" ? "Changes" : "Removes"}
            </span>
            <span className="truncate">{row.text}</span>
          </li>
        ))}
      </ul>
      {edges.length > 0 && <p className="text-muted-foreground">{edges.join(", ")}</p>}
    </div>
  );
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

  const now = Date.now();

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
          {versions === null && !error && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner />
              Loading versions
            </p>
          )}
          {versions?.length === 0 && (
            <p className="text-muted-foreground">
              No version yet. Publish the workflow to save one.
            </p>
          )}
          {versions && versions.length > 0 && (
            <ol className="relative flex flex-col">
              <span
                aria-hidden="true"
                className="absolute top-4 bottom-4 left-[15px] w-px bg-border"
              />
              {versions.map((v) => {
                const on = selected === v.version;
                const at = new Date(v.createdAt);
                return (
                  <li key={v.version} className="relative flex flex-col">
                    <button
                      type="button"
                      aria-expanded={on}
                      onClick={() => (on ? setSelected(null) : void select(v.version))}
                      className={`flex w-full items-center gap-3 rounded-lg py-2 pr-2 pl-[11px] text-left transition-colors duration-150 ease-out hover:bg-muted ${on ? "bg-muted" : ""}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`relative size-2.5 shrink-0 rounded-full ring-4 ring-card ${
                          v.published
                            ? "bg-emerald-500"
                            : on
                              ? "bg-foreground"
                              : "border border-muted-foreground/50 bg-card"
                        }`}
                      />
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="font-medium">Version {v.version}</span>
                        {v.published && <Badge variant="secondary">Live</Badge>}
                      </span>
                      <span className="text-muted-foreground" title={at.toLocaleString()}>
                        {ago(at, now)}
                      </span>
                    </button>
                    {on && (
                      <div className="flex flex-col gap-3 pt-2 pb-4 pl-8">
                        {!detail ? (
                          <p className="flex items-center gap-2 text-muted-foreground">
                            <Spinner />
                            Loading version
                          </p>
                        ) : (
                          <>
                            <VersionMap detail={detail} />
                            <div className="flex items-center gap-3 text-muted-foreground">
                              <span>{plural(detail.nodeCount, "node")}</span>
                              {(Object.keys(MARK) as Mark[]).map((m) => (
                                <span key={m} className="flex items-center gap-1.5">
                                  <span
                                    aria-hidden="true"
                                    className={`size-2 rounded-full ${MARK[m].swatch}`}
                                  />
                                  {MARK[m].label}
                                </span>
                              ))}
                            </div>
                            <Changes diff={detail.diff} />
                            <p className="text-pretty text-muted-foreground">
                              Restoring replaces the draft. The live version does not change until
                              you publish.
                            </p>
                            {confirming ? (
                              <div className="flex gap-2">
                                <Button disabled={busy} onClick={restore}>
                                  {busy && <Spinner />}
                                  Replace the draft
                                </Button>
                                <Button
                                  variant="outline"
                                  disabled={busy}
                                  onClick={() => setConfirming(false)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            ) : (
                              <Button
                                variant="outline"
                                className="self-start"
                                onClick={() => setConfirming(true)}
                              >
                                <HugeiconsIcon icon={Undo02Icon} />
                                Restore to draft
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
