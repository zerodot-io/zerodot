// SPDX-License-Identifier: AGPL-3.0-only

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import {
  Badge,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Spinner,
} from "@zerodot/ui";
import { useCallback, useEffect, useState } from "react";
import { formatDuration, formatTime } from "../../lib/format";
import { listRunsFn } from "../../server/fns";
import { StatusLabel } from "../status-dot";

type Run = Awaited<ReturnType<typeof listRunsFn>>["items"][number];

/** The latest runs of one workflow, next to the canvas. It updates while it is open. */
export function RunsSheet({
  open,
  onOpenChange,
  container,
  projectSlug,
  workflowId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  container: HTMLElement | null;
  projectSlug: string;
  workflowId: string;
}) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await listRunsFn({ data: { projectSlug, workflowId } });
      setRuns(page.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the runs");
    }
  }, [projectSlug, workflowId]);

  useEffect(() => {
    if (!open) return;
    void load();
    const source = new EventSource(`/api/p/${projectSlug}/events`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    };
    for (const name of ["run.started", "run.waiting", "run.finished"]) {
      source.addEventListener(name, refresh);
    }
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [open, load, projectSlug]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent container={container}>
        <SheetHeader>
          <SheetTitle>Runs</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {runs === null && !error && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Spinner />
              Loading runs
            </p>
          )}
          {runs?.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>No runs yet. Run the workflow to see it here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {runs && runs.length > 0 && (
            <>
              <ul className="-mx-2 flex flex-col">
                {runs.map((run) => (
                  <li key={run.id}>
                    <Link
                      to="/p/$projectSlug/runs/$runId"
                      params={{ projectSlug, runId: run.id }}
                      className="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-150 ease-out hover:bg-muted"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <StatusLabel status={run.status} />
                          {run.mode === "test" && <Badge variant="secondary">test</Badge>}
                        </span>
                        <span className="truncate text-muted-foreground">
                          {run.triggerName ?? run.triggerType} ·{" "}
                          {formatTime(run.startedAt ?? run.createdAt)}
                        </span>
                      </span>
                      <span className="shrink-0 text-muted-foreground tabular-nums">
                        {formatDuration(run.startedAt, run.finishedAt)}
                      </span>
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        aria-hidden="true"
                        className="size-4 shrink-0 text-muted-foreground/60 transition-colors duration-150 group-hover:text-foreground"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                to="/p/$projectSlug/runs"
                params={{ projectSlug }}
                search={{ wf: workflowId }}
                className="self-start text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
              >
                All runs, with filters
              </Link>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
