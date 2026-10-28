// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, redirect, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  toast,
} from "@zerodot/ui";
import { Bar, BarChart, BarXAxis, ChartTooltip, Grid, LineSparkline } from "@zerodot/ui/charts";
import {
  Copy,
  Download,
  EllipsisVertical,
  ExternalLink,
  History,
  Plus,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { type ChangeEvent, type ReactNode, useRef, useState } from "react";
import { ConfirmDialog } from "../components/confirm-dialog";
import { FEED_TOOLTIP, TooltipPanel } from "../components/tooltip-panel";
import { formatAge } from "../lib/admin-format";
import { formatMs, formatPercent } from "../lib/insights";
import {
  createWorkflowFn,
  deleteWorkflowFn,
  duplicateWorkflowFn,
  exportWorkflowFn,
  importWorkflowFn,
  listWorkflowsFn,
  setActiveFn,
} from "../server/fns";
import { getInsightsFn } from "../server/insights-fns";

export const Route = createFileRoute("/p/$projectSlug/workflows/")({
  head: () => ({ meta: [{ title: "Workflows · zerodot" }] }),
  validateSearch: (raw: Record<string, unknown>): { all?: true } => ({
    all: raw.all === true || raw.all === "true" ? true : undefined,
  }),
  loaderDeps: ({ search }) => ({ all: search.all }),
  loader: async ({ params, deps }) => {
    const workflows = await listWorkflowsFn({ data: { projectSlug: params.projectSlug } });
    // Open the canvas of the latest workflow. With none, or when asked for all, show the list.
    const [latest] = workflows;
    if (latest && !deps.all) {
      throw redirect({
        to: "/p/$projectSlug/workflows/$workflowId",
        params: { projectSlug: params.projectSlug, workflowId: latest.id },
      });
    }
    // The glance is optional. The list still shows when the stats fail.
    const insights = await getInsightsFn({
      data: { projectSlug: params.projectSlug, range: "24h", workflowIds: [], includeTest: false },
    }).catch(() => null);
    return { workflows, insights };
  },
  component: Workflows,
});

type View = "all" | "active" | "inactive" | "failing";
type SortKey = "name" | "runs" | "failed" | "recent";

const VIEWS: { value: View; label: string }[] = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "inactive", label: "Inactive" },
  { value: "failing", label: "Failing" },
];
const SORTS: { value: SortKey; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "runs", label: "Most runs" },
  { value: "failed", label: "Most failures" },
  { value: "recent", label: "Last run" },
];

const hourLabel = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function Stat({
  label,
  value,
  hint,
  bad,
}: {
  label: string;
  value: string;
  hint?: string;
  bad?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5 p-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-lg font-semibold tabular-nums ${bad ? "text-destructive" : ""}`}>
        {value}
      </span>
      <span className="min-h-lh text-muted-foreground">{hint}</span>
    </div>
  );
}

function ChartCard({
  title,
  legend,
  children,
}: {
  title: string;
  legend: { label: string; swatch: string }[];
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">{title}</h2>
        <ul className="flex gap-3 text-muted-foreground">
          {legend.map((l) => (
            <li key={l.label} className="flex items-center gap-1.5">
              <span aria-hidden="true" className={`size-2 rounded-sm ${l.swatch}`} />
              {l.label}
            </li>
          ))}
        </ul>
      </div>
      {children}
    </section>
  );
}

function Glance({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Last 24 hours"
      className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl border sm:grid-flow-col sm:auto-cols-fr sm:divide-y-0"
    >
      {children}
    </section>
  );
}

function Workflows() {
  const { workflows, insights } = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [imported, setImported] = useState<{
    id: string;
    name: string;
    missingVariables: string[];
    clearedCredentials: string[];
  } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [sort, setSort] = useState<SortKey>("name");
  // What the user just switched, until the loader sends fresh data.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const isActive = (w: { id: string; active: boolean }) => override[w.id] ?? w.active;

  async function onToggle(id: string, next: boolean, published: boolean) {
    if (next && !published) {
      toast.warning("Publish the workflow before you activate it");
      return;
    }
    setOverride((prev) => ({ ...prev, [id]: next }));
    try {
      await setActiveFn({ data: { projectSlug, workflowId: id, active: next } });
      await router.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the state");
    } finally {
      setOverride((prev) => {
        const { [id]: _done, ...rest } = prev;
        return rest;
      });
    }
  }

  async function onDuplicate(id: string, name: string) {
    try {
      await duplicateWorkflowFn({
        data: { projectSlug, workflowId: id, name: `${name} copy`.slice(0, 120) },
      });
      await router.invalidate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not duplicate the workflow");
    }
  }

  async function onExport(id: string, name: string) {
    try {
      const file = await exportWorkflowFn({ data: { projectSlug, workflowId: id } });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${name.replace(/[^\w-]+/g, "-")}.zerodot.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not export the workflow");
    }
  }

  async function onDelete(id: string) {
    setDeleting(true);
    try {
      await deleteWorkflowFn({ data: { projectSlug, workflowId: id } });
      await router.invalidate();
      setToDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete the workflow");
    } finally {
      setDeleting(false);
    }
  }

  const kpis = insights?.kpis.current;
  const rows = new Map((insights?.table ?? []).map((r) => [r.workflowId, r]));
  const activeCount = workflows.filter(isActive).length;
  const now = Date.now();

  const matches = (w: (typeof workflows)[number], v: View) =>
    v === "all" ||
    (v === "active" && isActive(w)) ||
    (v === "inactive" && !isActive(w)) ||
    (v === "failing" && (rows.get(w.id)?.failed ?? 0) > 0);
  const needle = query.trim().toLowerCase();
  const visible = workflows
    .filter(
      (w) =>
        matches(w, view) &&
        (!needle ||
          w.name.toLowerCase().includes(needle) ||
          w.tags.some((t) => t.toLowerCase().includes(needle))),
    )
    .sort((a, b) => {
      const ra = rows.get(a.id);
      const rb = rows.get(b.id);
      switch (sort) {
        case "runs":
          return (rb?.runs ?? 0) - (ra?.runs ?? 0) || a.name.localeCompare(b.name);
        case "failed":
          return (rb?.failed ?? 0) - (ra?.failed ?? 0) || a.name.localeCompare(b.name);
        case "recent":
          return (
            (rb?.lastRunAt?.getTime() ?? 0) - (ra?.lastRunAt?.getTime() ?? 0) ||
            a.name.localeCompare(b.name)
          );
        default:
          return a.name.localeCompare(b.name);
      }
    });

  const series = insights?.series ?? [];
  // A flat line for a workflow that did not run, so the rows stay aligned.
  const idleTrend = series.length > 1 ? series.map(() => 0) : [0, 0];
  const chartData = series.map((p) => ({
    name: hourLabel(p.bucket),
    succeeded: p.succeeded,
    failed: p.failed,
    other: Math.max(0, p.runs - p.succeeded - p.failed),
    seconds: p.avgMs === null ? 0 : Math.round(p.avgMs / 1000),
    ms: p.avgMs ?? 0,
  }));

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImported(null);
    setProblem(null);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const result = await importWorkflowFn({ data: { projectSlug, file: parsed } });
      setImported(result);
      await router.invalidate();
    } catch (error) {
      setProblem(
        error instanceof SyntaxError
          ? "This file is not valid JSON"
          : error instanceof Error
            ? error.message
            : "Could not import the file",
      );
    }
  }

  /** Creates a workflow with a free default name. One renames it in the editor. */
  async function onCreate() {
    const taken = new Set(workflows.map((w) => w.name));
    let name = "Untitled workflow";
    for (let i = 2; taken.has(name); i++) name = `Untitled workflow ${i}`;
    setPending(true);
    try {
      const created = await createWorkflowFn({ data: { projectSlug, name } });
      await router.navigate({
        to: "/p/$projectSlug/workflows/$workflowId",
        params: { projectSlug, workflowId: created.id },
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the workflow");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">Workflows</h1>
          <span className="text-muted-foreground">
            {workflows.length} total, {activeCount} active
          </span>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            Import
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Import a .zerodot.json file"
            onChange={onImport}
          />
          <Button type="button" disabled={pending} onClick={() => void onCreate()}>
            {pending ? <Spinner /> : <Plus />}
            New workflow
          </Button>
        </div>
      </div>

      {kpis && (
        <Glance>
          <Stat
            label="Runs, 24h"
            value={kpis.runs.toLocaleString()}
            hint={`${kpis.succeeded} ok`}
          />
          <Stat
            label="Failure rate"
            value={kpis.failureRate === null ? "–" : formatPercent(kpis.failureRate)}
            hint={`${kpis.failed} failed`}
            bad={kpis.failed > 0 && (kpis.failureRate ?? 0) > 0.1}
          />
          <Stat
            label="Avg run time"
            value={kpis.avgMs === null ? "–" : formatMs(kpis.avgMs)}
            hint="finished runs"
          />
          <Stat
            label="Run time p95"
            value={kpis.p95Ms === null ? "–" : `~${formatMs(kpis.p95Ms)}`}
            hint="finished runs"
          />
        </Glance>
      )}

      {chartData.length > 1 && (kpis?.runs ?? 0) > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartCard
            title="Runs per hour"
            legend={[
              { label: "Succeeded", swatch: "bg-emerald-500" },
              { label: "Failed", swatch: "bg-red-500" },
              { label: "Other", swatch: "bg-foreground/70" },
            ]}
          >
            <BarChart
              data={chartData}
              xDataKey="name"
              stacked
              aspectRatio="2.2 / 1"
              aria-label={`Runs for each hour in the last 24 hours. ${kpis?.succeeded ?? 0} succeeded, ${kpis?.failed ?? 0} failed.`}
            >
              <Grid horizontal />
              <Bar dataKey="succeeded" fill="var(--chart-positive)" />
              <Bar dataKey="failed" fill="var(--chart-negative)" />
              <Bar dataKey="other" fill="var(--chart-foreground-muted)" />
              <BarXAxis maxLabels={6} />
              <ChartTooltip
                {...FEED_TOOLTIP}
                content={({ point }) => (
                  <TooltipPanel
                    title={String(point.name)}
                    rows={[
                      {
                        key: "ok",
                        label: "Succeeded",
                        value: String(point.succeeded),
                        color: "var(--chart-positive)",
                      },
                      {
                        key: "bad",
                        label: "Failed",
                        value: String(point.failed),
                        color: "var(--chart-negative)",
                      },
                      {
                        key: "other",
                        label: "Other",
                        value: String(point.other),
                        color: "var(--chart-foreground-muted)",
                      },
                    ]}
                  />
                )}
              />
            </BarChart>
          </ChartCard>
          <ChartCard
            title="Average run time per hour"
            legend={[{ label: "Seconds", swatch: "bg-foreground/70" }]}
          >
            <BarChart
              data={chartData}
              xDataKey="name"
              aspectRatio="2.2 / 1"
              aria-label="Average run time for each hour in the last 24 hours, in seconds."
            >
              <Grid horizontal />
              <Bar dataKey="seconds" fill="var(--chart-foreground-muted)" />
              <BarXAxis maxLabels={6} />
              <ChartTooltip
                {...FEED_TOOLTIP}
                content={({ point }) => (
                  <TooltipPanel
                    title={String(point.name)}
                    rows={[
                      {
                        key: "s",
                        label: "Average",
                        value: formatMs(Number(point.ms)),
                        color: "var(--chart-foreground-muted)",
                      },
                    ]}
                  />
                )}
              />
            </BarChart>
          </ChartCard>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Filter workflows" className="flex gap-1">
          {VIEWS.map((o) => {
            const on = o.value === view;
            const count = workflows.filter((w) => matches(w, o.value)).length;
            return (
              <button
                key={o.value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setView(o.value)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 transition-colors duration-150 ease-out hover:text-foreground ${on ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {o.label}
                <span
                  className={`tabular-nums ${o.value === "failing" && count > 0 ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name or tag"
            aria-label="Search workflows"
            className="min-w-0 flex-1 sm:w-48 sm:flex-none"
          />
          <Select
            items={SORTS}
            value={sort}
            onValueChange={(v) => {
              const next = SORTS.find((o) => o.value === v);
              if (next) setSort(next.value);
            }}
          >
            <SelectTrigger aria-label="Sort workflows" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {problem && (
        <p role="alert" className="text-destructive">
          {problem}
        </p>
      )}
      {imported && (
        <div role="status" className="relative flex flex-col gap-1 rounded-lg border p-3 pr-10">
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setImported(null)}
            className="absolute top-2 right-2 grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <X className="size-4" />
          </button>
          <span>
            Imported{" "}
            <Link
              to="/p/$projectSlug/workflows/$workflowId"
              params={{ projectSlug, workflowId: imported.id }}
              className="font-medium"
            >
              {imported.name}
            </Link>{" "}
            as a draft.
          </span>
          {imported.missingVariables.length > 0 && (
            <span className="text-muted-foreground">
              Missing variables: {imported.missingVariables.join(", ")}.{" "}
              <Link to="/p/$projectSlug/variables" params={{ projectSlug }} className="font-medium">
                Create them
              </Link>{" "}
              before you run the workflow.
            </span>
          )}
          {imported.clearedCredentials.length > 0 && (
            <span className="text-muted-foreground">
              Pick a credential again on: {imported.clearedCredentials.join(", ")}.
            </span>
          )}
        </div>
      )}

      {workflows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Workflow />
            </EmptyMedia>
            <EmptyTitle>No workflows yet</EmptyTitle>
            <EmptyDescription>A workflow runs steps for you when a trigger fires.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button type="button" disabled={pending} onClick={() => void onCreate()}>
              {pending ? <Spinner /> : <Plus />}
              New workflow
            </Button>
          </EmptyContent>
        </Empty>
      ) : visible.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No workflows match</EmptyTitle>
            <EmptyDescription>Change the search or the filter.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl border">
          {visible.map((w) => {
            const row = rows.get(w.id);
            const on = isActive(w);
            const trend = row?.trend ?? idleTrend;
            const ran = (row?.runs ?? 0) > 0;
            return (
              <li
                key={w.id}
                className="group flex items-center transition-colors hover:bg-muted/50"
              >
                <Link
                  to="/p/$projectSlug/workflows/$workflowId"
                  params={{ projectSlug, workflowId: w.id }}
                  className="flex min-w-0 flex-1 items-center justify-between gap-6 py-4 pl-5"
                >
                  <span className="flex min-w-0 flex-col gap-1.5">
                    <span className="flex items-center gap-2">
                      <span
                        role="img"
                        aria-label={on ? "Active" : "Inactive"}
                        className={`size-1.5 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      />
                      <span className={`truncate font-medium ${on ? "" : "text-muted-foreground"}`}>
                        {w.name}
                      </span>
                      {w.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          {tag}
                        </Badge>
                      ))}
                    </span>
                    {w.description && (
                      <span className="truncate text-muted-foreground">{w.description}</span>
                    )}
                  </span>
                  <span
                    className="w-20 shrink-0"
                    title={
                      row?.lastRunAt
                        ? `${row.runs} runs, ${row.failed} failed, last ${formatAge(now - row.lastRunAt.getTime())} ago`
                        : undefined
                    }
                  >
                    {ran && (
                      <LineSparkline
                        data={trend.map((runs) => ({ runs }))}
                        dataKey="runs"
                        width={80}
                        height={20}
                        color="var(--chart-positive)"
                        aria-label={`Runs for each hour: ${trend.join(", ")}`}
                      />
                    )}
                  </span>
                </Link>
                <div className="flex items-center gap-4 px-5">
                  <Switch
                    aria-label={`${on ? "Turn off" : "Turn on"} ${w.name}`}
                    checked={on}
                    onCheckedChange={(next) => void onToggle(w.id, next, w.published)}
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`More actions for ${w.name}`}
                      title="More"
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                    >
                      <EllipsisVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          void router.navigate({
                            to: "/p/$projectSlug/workflows/$workflowId",
                            params: { projectSlug, workflowId: w.id },
                          })
                        }
                      >
                        <ExternalLink />
                        Open
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          void router.navigate({
                            to: "/p/$projectSlug/runs",
                            params: { projectSlug },
                            search: { wf: w.id },
                          })
                        }
                      >
                        <History />
                        View runs
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => void onDuplicate(w.id, w.name)}>
                        <Copy />
                        Duplicate
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => void onExport(w.id, w.name)}>
                        <Download />
                        Export
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setToDelete({ id: w.id, name: w.name })}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toDelete && (
        <ConfirmDialog
          title={`Delete ${toDelete.name}?`}
          description="The workflow and its runs are deleted. This cannot be undone."
          action="Delete"
          cancel="Keep"
          destructive
          busy={deleting}
          onCancel={() => setToDelete(null)}
          onConfirm={() => void onDelete(toDelete.id)}
        />
      )}
    </main>
  );
}
