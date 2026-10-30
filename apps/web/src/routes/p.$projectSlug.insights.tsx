// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Input,
  Label,
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
import { useMemo, useState } from "react";
import { type Bar, BarChart, Sparkline } from "../components/bar-chart";
import { NodeIcon } from "../components/node-icon";
import { addServerCatalog, catalogByType } from "../lib/flow";
import {
  formatChange,
  formatValue,
  type Kpis,
  METRIC_LABEL,
  METRICS,
  type Metric,
  type NodeRow,
  RANGES,
  type RangeKey,
} from "../lib/insights";
import { useRefreshOnEvents } from "../lib/use-event-source";
import { getExtraCatalogFn } from "../server/fns";
import { getInsightsFn, setMinutesSavedFn } from "../server/insights-fns";

type Search = {
  range: RangeKey;
  wf: string[];
  trigger?: string;
  test: boolean;
  metric: Metric;
};

const TRIGGERS = ["webhook", "cron", "poll", "listen", "manual"];

/** What the URL holds. A key is missing when it has the default value. */
type SearchInput = Partial<Search>;

const withDefaults = (s: SearchInput): Search => ({
  range: s.range ?? "7d",
  wf: s.wf ?? [],
  trigger: s.trigger,
  test: s.test ?? false,
  metric: s.metric ?? "runs",
});

export const Route = createFileRoute("/p/$projectSlug/insights")({
  head: () => ({ meta: [{ title: "Insights · zerodot" }] }),
  validateSearch: (raw: Record<string, unknown>): SearchInput => ({
    range:
      typeof raw.range === "string" && raw.range in RANGES ? (raw.range as RangeKey) : undefined,
    wf: Array.isArray(raw.wf)
      ? raw.wf.filter((v): v is string => typeof v === "string")
      : undefined,
    trigger:
      typeof raw.trigger === "string" && TRIGGERS.includes(raw.trigger) ? raw.trigger : undefined,
    test: raw.test === true || raw.test === "true" ? true : undefined,
    metric: METRICS.includes(raw.metric as Metric) ? (raw.metric as Metric) : undefined,
  }),
  loaderDeps: ({ search }) => withDefaults(search),
  loader: async ({ params, deps }) => {
    const [insights, extra] = await Promise.all([
      getInsightsFn({
        data: {
          projectSlug: params.projectSlug,
          range: deps.range,
          workflowIds: deps.wf,
          triggerType: deps.trigger,
          includeTest: deps.test,
        },
      }),
      getExtraCatalogFn(),
    ]);
    addServerCatalog(extra);
    return { ...insights, extra };
  },
  component: Insights,
});

const dateTime = (date: Date) =>
  date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function Insights() {
  const data = Route.useLoaderData();
  // The loader runs on the server for a full page load. The browser gets the extra nodes here.
  addServerCatalog(data.extra);
  const search = withDefaults(Route.useSearch());
  const { projectSlug } = Route.useParams();
  const navigate = Route.useNavigate();
  const empty = data.series.every((p) => p.runs === 0);
  // KPI tiles update on a finished run. Many runs in a short time cause one refresh.
  useRefreshOnEvents(`/api/p/${projectSlug}/events`, ["run.finished"], 2000);

  const set = (patch: Partial<Search>) => navigate({ search: (prev) => ({ ...prev, ...patch }) });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-lg">
          {data.workflow ? `Insights · ${data.workflow.name}` : "Insights"}
        </h1>
        <FilterBar search={search} workflows={data.workflows} onChange={set} />
      </div>

      <KpiRow
        current={data.kpis.current}
        previous={data.kpis.previous}
        selected={search.metric}
        onSelect={(metric) => set({ metric })}
      />

      {empty ? (
        <p className="text-muted-foreground">
          No {search.test ? "" : "production "}runs in the last {RANGES[search.range].label}.
        </p>
      ) : (
        <Chart data={data} metric={search.metric} />
      )}

      {data.workflow && (
        <TimeSaved
          key={data.workflow.id}
          projectSlug={projectSlug}
          workflowId={data.workflow.id}
          value={data.workflow.minutesSavedPerRun}
        />
      )}

      {!empty && (
        <WorkflowTable
          rows={data.table}
          projectSlug={projectSlug}
          search={search}
          single={Boolean(data.workflow)}
        />
      )}

      {data.nodes && <NodeTable rows={data.nodes} />}

      {!empty && (
        <Problems
          projectSlug={projectSlug}
          failing={data.failingNodes}
          slowest={data.slowestNodes}
          errors={data.errors}
          showWorkflow={!data.workflow}
        />
      )}
    </main>
  );
}

function FilterBar({
  search,
  workflows,
  onChange,
}: {
  search: Search;
  workflows: { id: string; name: string }[];
  onChange: (patch: Partial<Search>) => void;
}) {
  const chosen = new Set(search.wf);
  const label =
    chosen.size === 0
      ? "All workflows"
      : chosen.size === 1
        ? (workflows.find((w) => chosen.has(w.id))?.name ?? "1 workflow")
        : `${chosen.size} workflows`;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => (
          <Button
            key={key}
            size="sm"
            variant={search.range === key ? "secondary" : "ghost"}
            aria-pressed={search.range === key}
            onClick={() => onChange({ range: key })}
          >
            {key}
          </Button>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
          {label}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
          <DropdownMenuCheckboxItem
            checked={chosen.size === 0}
            closeOnClick={false}
            onCheckedChange={() => onChange({ wf: [] })}
          >
            All workflows
          </DropdownMenuCheckboxItem>
          {workflows.map((w) => (
            <DropdownMenuCheckboxItem
              key={w.id}
              checked={chosen.has(w.id)}
              closeOnClick={false}
              onCheckedChange={(on) =>
                onChange({ wf: on ? [...search.wf, w.id] : search.wf.filter((id) => id !== w.id) })
              }
            >
              {w.name}
            </DropdownMenuCheckboxItem>
          ))}
          {workflows.length === 0 && (
            <p className="px-2 py-1.5 text-muted-foreground">No workflows.</p>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Select
        items={[
          { value: "all", label: "All triggers" },
          ...TRIGGERS.map((t) => ({ value: t, label: t })),
        ]}
        value={search.trigger ?? "all"}
        onValueChange={(value) =>
          onChange({ trigger: !value || value === "all" ? undefined : value })
        }
      >
        <SelectTrigger aria-label="Trigger type" className="w-32">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All triggers</SelectItem>
          {TRIGGERS.map((t) => (
            <SelectItem key={t} value={t}>
              {t}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <div className="flex items-center gap-2">
        <Switch
          id="include-test"
          checked={search.test}
          onCheckedChange={(test) => onChange({ test })}
        />
        <Label htmlFor="include-test">Test runs</Label>
      </div>
    </div>
  );
}

function KpiRow({
  current,
  previous,
  selected,
  onSelect,
}: {
  current: Kpis;
  previous: Kpis;
  selected: Metric;
  onSelect: (metric: Metric) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
      {METRICS.map((metric) => {
        const value = current[metric];
        const before = previous[metric];
        const change = formatChange(metric, value, before);
        return (
          <button
            key={metric}
            type="button"
            aria-pressed={selected === metric}
            onClick={() => onSelect(metric)}
            className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-[transform,border-color] duration-150 ease-out active:scale-[0.98] motion-reduce:transition-none ${
              selected === metric ? "border-foreground" : "hover:border-foreground/40"
            }`}
          >
            <span className="text-muted-foreground">{METRIC_LABEL[metric]}</span>
            <span className="font-semibold text-2xl tabular-nums">
              {formatValue(metric, value, true)}
            </span>
            <span className="text-muted-foreground text-xs tabular-nums">
              {change ? `${change} vs before` : "–"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

type InsightsData = Awaited<ReturnType<typeof getInsightsFn>>;

function Chart({ data, metric }: { data: InsightsData; metric: Metric }) {
  const hourly = data.granularity === "hour";
  const label = (d: Date) =>
    hourly
      ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const bars: Bar[] = data.series.map((p) => {
    const value = p[metric] ?? 0;
    const text = `${label(p.bucket)}: ${formatValue(metric, p[metric], true)}${
      metric === "runs" ? ` (${p.succeeded} succeeded, ${p.failed} failed)` : ""
    }`;
    if (metric === "runs") {
      return {
        text,
        parts: [
          { value: p.succeeded, tone: "ok" },
          { value: p.failed, tone: "bad" },
        ],
      };
    }
    return {
      text,
      parts: [{ value, tone: metric === "failed" || metric === "failureRate" ? "bad" : "neutral" }],
    };
  });
  const max = Math.max(0, ...data.series.map((p) => p[metric] ?? 0));
  const starts = data.series.map((p) => p.bucket.getTime());
  const markers = data.publishes.flatMap((v) => {
    // The last bucket that starts at or before the publish.
    const index = starts.findLastIndex((s) => s <= v.createdAt.getTime());
    return index < 0
      ? []
      : [{ index, text: `Published version ${v.version}, ${dateTime(v.createdAt)}` }];
  });
  const first = data.series[0];
  const last = data.series.at(-1);
  return (
    <section
      aria-label={METRIC_LABEL[metric]}
      className="flex flex-col gap-2 rounded-xl border p-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-semibold">{METRIC_LABEL[metric]}</h2>
        {metric === "runs" && (
          <span className="flex items-center gap-3 text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-emerald-500" />
              Succeeded
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="size-2 rounded-full bg-red-500" />
              Failed
            </span>
          </span>
        )}
      </div>
      <BarChart
        bars={bars}
        markers={markers}
        maxLabel={formatValue(metric, max, true)}
        startLabel={first ? label(first.bucket) : ""}
        endLabel={last ? label(last.bucket) : ""}
        summary={`${METRIC_LABEL[metric]} for each ${data.granularity}`}
      />
      {markers.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Dashed lines mark a publish. Hover a line for the version.
        </p>
      )}
    </section>
  );
}

function TimeSaved({
  projectSlug,
  workflowId,
  value,
}: {
  projectSlug: string;
  workflowId: string;
  value: number | null;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  const [message, setMessage] = useState<string | null>(null);
  const parsed = draft.trim() === "" ? null : Number(draft);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed >= 0);
  async function save() {
    if (!valid) return;
    setMessage(null);
    try {
      await setMinutesSavedFn({ data: { projectSlug, workflowId, minutes: parsed } });
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save");
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Label htmlFor="minutes-saved" className="text-muted-foreground">
        Minutes saved for each succeeded run
      </Label>
      <Input
        id="minutes-saved"
        inputMode="numeric"
        className="w-24"
        value={draft}
        aria-invalid={!valid}
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button size="sm" variant="outline" disabled={!valid || parsed === value} onClick={save}>
        Save
      </Button>
      {message && (
        <span role="alert" className="text-destructive">
          {message}
        </span>
      )}
    </div>
  );
}

type TableRowData = InsightsData["table"][number];
type SortKey =
  | "workflowName"
  | "runs"
  | "failed"
  | "failureRate"
  | "avgMs"
  | "p95Ms"
  | "timeSavedMinutes"
  | "lastRunAt"
  | "lastFailureAt";

const sortValue = (row: TableRowData, key: SortKey): string | number =>
  key === "workflowName"
    ? row.workflowName.toLowerCase()
    : key === "lastRunAt" || key === "lastFailureAt"
      ? (row[key]?.getTime() ?? -1)
      : (row[key] ?? -1);

function WorkflowTable({
  rows,
  projectSlug,
  search,
  single,
}: {
  rows: TableRowData[];
  projectSlug: string;
  search: Search;
  single: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "runs", desc: true });
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const x = sortValue(a, sort.key);
        const y = sortValue(b, sort.key);
        return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
      }),
    [rows, sort],
  );
  const head = (key: SortKey, text: string) => (
    <TableHead aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        className={sort.key === key ? "font-medium text-foreground" : ""}
        onClick={() =>
          setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "workflowName" }))
        }
      >
        {text}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </TableHead>
  );
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">{single ? "Workflow" : "Workflows"}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            {head("workflowName", "Workflow")}
            {head("runs", "Runs")}
            {head("failed", "Failed")}
            {head("failureRate", "Failure rate")}
            {head("avgMs", "Average")}
            {head("p95Ms", "p95")}
            {head("timeSavedMinutes", "Time saved")}
            {head("lastRunAt", "Last run")}
            {head("lastFailureAt", "Last failure")}
            <TableHead>Trend</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => (
            <TableRow key={row.workflowId}>
              <TableCell>
                {single ? (
                  <span className="font-medium">{row.workflowName}</span>
                ) : (
                  <Link
                    to="/p/$projectSlug/insights"
                    params={{ projectSlug }}
                    search={{ ...search, wf: [row.workflowId] }}
                    className="font-medium"
                  >
                    {row.workflowName}
                  </Link>
                )}
              </TableCell>
              <TableCell className="tabular-nums">{row.runs}</TableCell>
              <TableCell
                className={`tabular-nums ${row.failed > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
              >
                {row.failed}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatValue("failureRate", row.failureRate)}
              </TableCell>
              <TableCell className="tabular-nums">{formatValue("avgMs", row.avgMs)}</TableCell>
              <TableCell className="tabular-nums">
                {formatValue("p95Ms", row.p95Ms, true)}
              </TableCell>
              <TableCell className="tabular-nums">
                {formatValue("timeSavedMinutes", row.timeSavedMinutes)}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.lastRunAt ? dateTime(row.lastRunAt) : "–"}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {row.lastFailureAt ? dateTime(row.lastFailureAt) : "–"}
              </TableCell>
              <TableCell>
                <Sparkline
                  values={row.trend}
                  label={`Runs for each bucket: ${row.trend.join(", ")}`}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function nodeLabel(row: NodeRow) {
  const entry = catalogByType.get(row.nodeType);
  return (
    <span className="inline-flex items-center gap-2">
      <NodeIcon
        name={entry?.icon ?? "CircleIcon"}
        src={entry?.iconUrl}
        category={entry?.category}
      />
      <span className="font-medium">{row.nodeName ?? entry?.label ?? row.nodeId}</span>
      {entry && entry.label !== row.nodeName && (
        <span className="text-muted-foreground text-xs">{entry.label}</span>
      )}
    </span>
  );
}

function NodeTable({ rows }: { rows: NodeRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">Nodes</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Runs</TableHead>
            <TableHead>Failed</TableHead>
            <TableHead>Average</TableHead>
            <TableHead>p95</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.nodeId}>
              <TableCell>{nodeLabel(row)}</TableCell>
              <TableCell className="tabular-nums">{row.runs}</TableCell>
              <TableCell
                className={`tabular-nums ${row.failed > 0 ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}`}
              >
                {row.failed}
              </TableCell>
              <TableCell className="tabular-nums">{formatValue("avgMs", row.avgMs)}</TableCell>
              <TableCell className="tabular-nums">
                {formatValue("p95Ms", row.p95Ms, true)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function Problems({
  projectSlug,
  failing,
  slowest,
  errors,
  showWorkflow,
}: {
  projectSlug: string;
  failing: NodeRow[];
  slowest: NodeRow[];
  errors: InsightsData["errors"];
  showWorkflow: boolean;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold">Problems</h2>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground">Top failing nodes</h3>
          {failing.length === 0 ? (
            <p className="text-muted-foreground">No node failed.</p>
          ) : (
            <Table>
              <TableBody>
                {failing.map((row) => (
                  <TableRow key={`${row.workflowId}:${row.nodeId}`}>
                    <TableCell>
                      {nodeLabel(row)}
                      {showWorkflow && (
                        <div className="text-muted-foreground">{row.workflowName}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-red-600 tabular-nums dark:text-red-400">
                      {row.failed} failed
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <h3 className="mt-4 font-medium text-muted-foreground">Slowest nodes</h3>
          {slowest.length === 0 ? (
            <p className="text-muted-foreground">No node ran.</p>
          ) : (
            <Table>
              <TableBody>
                {slowest.map((row) => (
                  <TableRow key={`${row.workflowId}:${row.nodeId}`}>
                    <TableCell>
                      {nodeLabel(row)}
                      {showWorkflow && (
                        <div className="text-muted-foreground">{row.workflowName}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatValue("avgMs", row.avgMs)} avg ·{" "}
                      {formatValue("p95Ms", row.p95Ms, true)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground">Top errors</h3>
          {errors.length === 0 ? (
            <p className="text-muted-foreground">No failed runs.</p>
          ) : (
            <Table>
              <TableBody>
                {errors.map((error) => (
                  <TableRow key={error.fingerprint}>
                    <TableCell className="w-full max-w-0 whitespace-normal">
                      <Link
                        to="/p/$projectSlug/runs/$runId"
                        params={{ projectSlug, runId: error.lastRunId }}
                        className="line-clamp-2 break-words font-medium"
                        title={error.sampleMessage}
                      >
                        {error.sampleMessage}
                      </Link>
                      <div className="text-muted-foreground">
                        {error.workflowName} · first {dateTime(error.firstSeenAt)} · last{" "}
                        {dateTime(error.lastSeenAt)}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge variant="secondary" className="tabular-nums">
                        {error.count}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        p95 is an estimate from a histogram. It starts with ~.
      </p>
    </section>
  );
}
