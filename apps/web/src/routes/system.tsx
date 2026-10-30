// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@zerodot/ui";
import { Bar, BarChart, BarXAxis, ChartTooltip, Grid, LineSparkline } from "@zerodot/ui/charts";
import { useCallback, useEffect, useState } from "react";
import { releaseUrl } from "../components/about-dialog";
import { AccountForm, PasskeyList, PasswordForm } from "../components/auth-settings";
import { ConfirmDialog } from "../components/confirm-dialog";
import { SYSTEM_TABS, SystemHeader, type SystemTab } from "../components/system-header";
import { formatAge, isStaleWorker } from "../lib/admin-format";
import type { Json } from "../lib/json";
import {
  adminCancelRun,
  adminCleanQueue,
  adminPauseQueue,
  adminPromoteJob,
  adminRemoveJob,
  adminResumeQueue,
  adminRetryJob,
  adminSetSignup,
  getAdminJobs,
  getAdminOverview,
  getAdminSignup,
  getHomeFn,
  getIsInstanceAdmin,
  getUpdateFn,
} from "../server/fns";

type QueueName = "runs" | "system";
type JobState = "active" | "waiting" | "delayed" | "prioritized" | "failed" | "completed";
type CleanState = "completed" | "failed" | "delayed" | "waiting" | "prioritized";

type Overview = {
  queues: {
    name: QueueName;
    queueName: string;
    counts: Record<
      "waiting" | "active" | "delayed" | "prioritized" | "failed" | "completed",
      number
    >;
    paused: boolean;
    oldestWaitingMs: number | null;
  }[];
  workers: {
    id: string;
    host: string;
    version: string;
    concurrency: number;
    activeRuns: string[];
    startedAt: number;
    lastSeenAt: number;
  }[];
  counters: { sweeper_requeued: number; org_cap_delayed: number; workflow_cap_delayed: number };
  audit: {
    id: string;
    actorEmail: string;
    action: string;
    targetType: string;
    targetId: string;
    createdAt: string;
  }[];
  throughput: {
    buckets: {
      at: number;
      created: number;
      succeeded: number;
      failed: number;
      cancelled: number;
    }[];
    p50Ms: number | null;
    p95Ms: number | null;
  };
};
type Sample = {
  runsWaiting: number;
  runsActive: number;
  systemWaiting: number;
  systemActive: number;
};
type Job = Awaited<ReturnType<typeof getAdminJobs>>[number];

// The server sends plain JSON. The shape is set by getAdminOverview.
const asOverview = (value: Json): Overview => value as unknown as Overview;

const REFRESH_MS = 5000;
/** Samples kept for the live chart. 60 samples at 5 s is 5 minutes. */
const SAMPLE_COUNT = 60;
/** A run that waits longer than this makes the health banner warn. */
const STUCK_MS = 5 * 60_000;
const QUEUE_ITEMS = [
  { value: "runs", label: "Runs queue" },
  { value: "system", label: "System queue" },
];
const STATE_ITEMS: { value: JobState; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "waiting", label: "Waiting" },
  { value: "delayed", label: "Delayed" },
  { value: "prioritized", label: "Prioritized" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
];
const CLEAN_ITEMS: { value: CleanState; label: string }[] = [
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "delayed", label: "Delayed" },
  { value: "waiting", label: "Waiting" },
  { value: "prioritized", label: "Prioritized" },
];
const AGE_ITEMS = [
  { value: "0", label: "Any age" },
  { value: String(3_600_000), label: "Older than 1 hour" },
  { value: String(86_400_000), label: "Older than 1 day" },
  { value: String(7 * 86_400_000), label: "Older than 7 days" },
];

export const Route = createFileRoute("/system")({
  head: () => ({ meta: [{ title: "System · zerodot" }] }),
  validateSearch: (raw: Record<string, unknown>): { tab?: SystemTab } => {
    const tab = SYSTEM_TABS.find((t) => t === raw.tab);
    return tab && tab !== "overview" ? { tab } : {};
  },
  beforeLoad: async () => {
    const home = await getHomeFn();
    if (!home.signedIn) throw redirect({ to: "/sign-in" });
    if (!(await getIsInstanceAdmin())) throw notFound();
    return { projects: home.projects, homeSlug: home.slug };
  },
  loader: async () => asOverview(await getAdminOverview()),
  component: System,
});

type Confirm = { title: string; description: string; action: string; run: () => Promise<unknown> };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Failed";
}

function formatMs(ms: number | null): string {
  if (ms === null) return "–";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatAge(ms);
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "bad";
}) {
  return (
    <div className="flex flex-col gap-1 p-4">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`text-lg font-semibold tabular-nums ${tone === "bad" ? "text-destructive" : ""}`}
      >
        {value}
      </span>
      <span className="min-h-lh text-muted-foreground">{hint}</span>
    </div>
  );
}

function StatGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-2 divide-x divide-y overflow-hidden rounded-xl border sm:grid-flow-col sm:auto-cols-fr sm:divide-y-0">
      {children}
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
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
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

function Meter({ value, max }: { value: number; max: number }) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div aria-hidden="true" className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full ${pct >= 90 ? "bg-red-500" : "bg-emerald-500"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

type Health = { level: "ok" | "warn" | "down"; issues: string[] };

const HEALTH: Record<Health["level"], { title: string; dot: string }> = {
  ok: { title: "All systems normal", dot: "bg-emerald-500" },
  warn: { title: "Needs attention", dot: "bg-amber-500" },
  down: { title: "Runs cannot start", dot: "bg-red-500" },
};

/** One verdict for the whole instance, so a problem shows before one reads the numbers. */
function HealthBanner({ health }: { health: Health }) {
  const look = HEALTH[health.level];
  return (
    <section
      aria-label="Health"
      aria-live="polite"
      className="flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <span className="flex items-center gap-2.5 font-medium">
        <span aria-hidden="true" className="relative flex size-2">
          {health.level !== "ok" && (
            <span
              className={`absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:animate-none ${look.dot}`}
            />
          )}
          <span className={`relative size-2 rounded-full ${look.dot}`} />
        </span>
        {look.title}
      </span>
      {health.issues.length > 0 && (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground">
          {health.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  /** Controls at the right of the heading. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

function SignupRow() {
  const [setting, setSetting] = useState<{ disabled: boolean; lockedByEnv: boolean } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getAdminSignup().then(setSetting, (error) => toast.error(errorText(error)));
  }, []);

  async function change(allowed: boolean) {
    setSaving(true);
    try {
      setSetting(await adminSetSignup({ data: { disabled: !allowed } }));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  if (!setting) {
    return (
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex flex-col gap-2 py-0.5">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-5 w-9 rounded-full" />
      </div>
    );
  }
  const allowed = !setting.disabled && !setting.lockedByEnv;
  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium">Public signup</span>
        <span className="text-muted-foreground">
          {setting.lockedByEnv
            ? "Off. ZERODOT_SIGNUP_DISABLED=true is set on the server. Remove it to use this switch."
            : "When off, only invited people can create an account."}
        </span>
      </div>
      <Switch
        aria-label="Public signup"
        checked={allowed}
        disabled={saving || setting.lockedByEnv}
        onCheckedChange={(next) => void change(next)}
      />
    </div>
  );
}

function VersionRow() {
  const [latest, setLatest] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    getUpdateFn({ data: { current: __APP_VERSION__ } }).then(
      ({ releases }) => setLatest(releases[0]?.version ?? null),
      () => setLatest(null),
    );
  }, []);

  return (
    <div className="flex items-center justify-between gap-4 p-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium">v{__APP_VERSION__}</span>
        {latest === undefined ? (
          <Skeleton className="my-0.5 h-4 w-72 max-w-full" />
        ) : (
          <span className="text-muted-foreground">
            {latest
              ? `Update available: v${latest}`
              : "No newer version found. The check runs at most once an hour. ZERODOT_UPDATE_CHECK=false turns it off."}
          </span>
        )}
      </div>
      {latest && (
        <Button
          variant="outline"
          render={
            <a href={releaseUrl(latest)} target="_blank" rel="noopener noreferrer">
              View release
            </a>
          }
        />
      )}
    </div>
  );
}

function System() {
  const initial = Route.useLoaderData();
  const { projects, homeSlug } = Route.useRouteContext();
  const tab = Route.useSearch().tab ?? "overview";
  const [overview, setOverview] = useState(initial);
  const [now, setNow] = useState(() => Date.now());
  const [queue, setQueue] = useState<QueueName>("runs");
  const [state, setState] = useState<JobState>("active");
  /** Null while the first page of the picked queue and state loads. */
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [cleanState, setCleanState] = useState<CleanState>("completed");
  const [cleanAge, setCleanAge] = useState(String(86_400_000));
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [samples, setSamples] = useState<Sample[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [next, rows] = await Promise.all([
        getAdminOverview(),
        tab === "jobs" ? getAdminJobs({ data: { queue, state, limit: 50 } }) : null,
      ]);
      const parsed = asOverview(next);
      setOverview(parsed);
      const of = (name: QueueName) => parsed.queues.find((q) => q.name === name)?.counts;
      const sample: Sample = {
        runsWaiting: (of("runs")?.waiting ?? 0) + (of("runs")?.prioritized ?? 0),
        runsActive: of("runs")?.active ?? 0,
        systemWaiting: (of("system")?.waiting ?? 0) + (of("system")?.prioritized ?? 0),
        systemActive: of("system")?.active ?? 0,
      };
      setSamples((prev) => [...prev, sample].slice(-SAMPLE_COUNT));
      if (rows) setJobs(rows);
      setNow(Date.now());
    } catch (error) {
      toast.error(errorText(error));
    }
  }, [queue, state, tab]);

  // A new queue, state or tab shows the shimmer until its jobs arrive.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on each change of the filters
  useEffect(() => setJobs(null), [queue, state, tab]);

  useEffect(() => {
    void refresh();
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  async function runConfirmed() {
    if (!confirm) return;
    setBusy(true);
    try {
      await confirm.run();
      setConfirm(null);
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function act(work: () => Promise<unknown>) {
    try {
      await work();
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  function runLink(job: Job) {
    if (!job.runId) return <span className="text-muted-foreground">–</span>;
    const project = projects.find((p) => p.organizationId === job.organizationId);
    if (!project) return <span className="font-mono">{job.runId}</span>;
    return (
      <Link
        to="/p/$projectSlug/runs/$runId"
        params={{ projectSlug: project.slug, runId: job.runId }}
        className="font-mono font-medium"
      >
        {job.runId}
      </Link>
    );
  }

  const { counters, throughput } = overview;
  const live = overview.workers.filter((w) => !isStaleWorker(w.lastSeenAt, now));
  const slots = live.reduce((sum, w) => sum + w.concurrency, 0);
  const busySlots = live.reduce((sum, w) => sum + w.activeRuns.length, 0);
  const runsQueue = overview.queues.find((q) => q.name === "runs");
  const failedJobs = overview.queues.reduce((sum, q) => sum + q.counts.failed, 0);
  const hour = throughput.buckets.reduce(
    (t, b) => ({
      created: t.created + b.created,
      succeeded: t.succeeded + b.succeeded,
      failed: t.failed + b.failed,
    }),
    { created: 0, succeeded: 0, failed: 0 },
  );
  const finished = hour.succeeded + hour.failed;
  const peak = Math.max(0, ...throughput.buckets.map((b) => b.created));
  const throughputData = throughput.buckets.map((b) => ({
    name: new Date(b.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    succeeded: b.succeeded,
    failed: b.failed,
    other: Math.max(0, b.created - b.succeeded - b.failed),
  }));
  const depthData = samples.map((sample, i) => ({
    name: `${formatAge((samples.length - 1 - i) * REFRESH_MS)} ago`,
    active: sample.runsActive,
    waiting: sample.runsWaiting,
  }));
  const issues: string[] = [];
  const stale = overview.workers.length - live.length;
  for (const q of overview.queues)
    if (q.paused)
      issues.push(`${QUEUE_ITEMS.find((o) => o.value === q.name)?.label ?? q.name} paused`);
  if (stale > 0) issues.push(`${stale} stale ${stale === 1 ? "worker" : "workers"}`);
  if (slots > 0 && busySlots >= slots && (runsQueue?.counts.waiting ?? 0) > 0) {
    issues.push("All run slots busy");
  }
  const oldest = runsQueue?.oldestWaitingMs ?? null;
  if (oldest !== null && oldest > STUCK_MS) {
    issues.push(`Oldest run waits ${formatAge(oldest)}`);
  }
  if (failedJobs > 0) issues.push(`${failedJobs} failed ${failedJobs === 1 ? "job" : "jobs"}`);
  if (finished > 0 && hour.failed / finished > 0.1) {
    issues.push(`${Math.round((hour.failed / finished) * 100)}% of runs failed, last hour`);
  }
  const health: Health =
    live.length === 0
      ? { level: "down", issues: ["No workers online", ...issues] }
      : { level: issues.length > 0 ? "warn" : "ok", issues };
  return (
    <main className="reveal mx-auto flex w-full max-w-5xl flex-col gap-10 p-6">
      <SystemHeader homeSlug={homeSlug}>
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden="true"
            className="size-1.5 animate-pulse rounded-full bg-emerald-500 motion-reduce:animate-none"
          />
          Live, every {REFRESH_MS / 1000}s
        </span>
      </SystemHeader>

      {tab === "overview" && (
        <>
          <HealthBanner health={health} />

          <Section title="Now">
            <StatGroup>
              <Stat
                label="Workers online"
                value={String(live.length)}
                hint={
                  overview.workers.length > live.length
                    ? `${overview.workers.length - live.length} stale`
                    : undefined
                }
                tone={live.length === 0 ? "bad" : undefined}
              />
              <Stat
                label="Run slots in use"
                value={`${busySlots} / ${slots}`}
                hint={slots > 0 ? `${Math.round((busySlots / slots) * 100)}% busy` : "no capacity"}
              />
              <Stat
                label="Runs waiting"
                value={String(
                  (runsQueue?.counts.waiting ?? 0) + (runsQueue?.counts.prioritized ?? 0),
                )}
                hint={
                  runsQueue?.oldestWaitingMs == null
                    ? "queue is empty"
                    : `oldest ${formatAge(runsQueue.oldestWaitingMs)}`
                }
              />
              <Stat
                label="Failed jobs"
                value={String(failedJobs)}
                tone={failedJobs > 0 ? "bad" : undefined}
                hint="all queues"
              />
            </StatGroup>
          </Section>

          <Section title="Last hour">
            <StatGroup>
              <Stat label="Runs" value={String(hour.created)} hint={`peak ${peak} per minute`} />
              <Stat
                label="Success rate"
                value={finished === 0 ? "–" : `${Math.round((hour.succeeded / finished) * 100)}%`}
                hint={`${hour.failed} failed`}
                tone={
                  hour.failed > 0 && hour.failed / Math.max(1, finished) > 0.1 ? "bad" : undefined
                }
              />
              <Stat label="Run time p50" value={formatMs(throughput.p50Ms)} hint="finished runs" />
              <Stat label="Run time p95" value={formatMs(throughput.p95Ms)} hint="finished runs" />
            </StatGroup>

            <div className="grid gap-3 lg:grid-cols-2">
              <ChartCard
                title="Runs per minute"
                legend={[
                  { label: "Succeeded", swatch: "bg-emerald-500" },
                  { label: "Failed", swatch: "bg-red-500" },
                  { label: "Other", swatch: "bg-foreground/70" },
                ]}
              >
                <BarChart
                  data={throughputData}
                  xDataKey="name"
                  stacked
                  aspectRatio="2.2 / 1"
                  aria-label={`${hour.created} runs in the last hour. ${hour.succeeded} succeeded, ${hour.failed} failed.`}
                >
                  <Grid horizontal />
                  <Bar dataKey="succeeded" fill="var(--chart-positive)" />
                  <Bar dataKey="failed" fill="var(--chart-negative)" />
                  <Bar dataKey="other" fill="var(--chart-foreground-muted)" />
                  <BarXAxis maxLabels={6} />
                  <ChartTooltip showDots={false} />
                </BarChart>
              </ChartCard>
              <ChartCard
                title="Runs queue, live"
                legend={[
                  { label: "Active", swatch: "bg-emerald-500" },
                  { label: "Waiting", swatch: "bg-foreground/70" },
                ]}
              >
                <BarChart
                  data={samples.length < 2 ? [] : depthData}
                  status={samples.length < 2 ? "loading" : "ready"}
                  xDataKey="name"
                  stacked
                  aspectRatio="2.2 / 1"
                  aria-label={`Runs queue depth over the last ${formatAge(samples.length * REFRESH_MS)}.`}
                >
                  <Grid horizontal />
                  <Bar dataKey="active" fill="var(--chart-positive)" />
                  <Bar dataKey="waiting" fill="var(--chart-foreground-muted)" />
                  <BarXAxis maxLabels={6} />
                  <ChartTooltip showDots={false} />
                </BarChart>
              </ChartCard>
            </div>
          </Section>
        </>
      )}

      {tab === "queues" && (
        <>
          <Section title="Queues">
            <div className="grid gap-3 sm:grid-cols-2">
              {overview.queues.map((q) => (
                <div key={q.name} className="flex flex-col gap-3 rounded-xl border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-2 font-medium">
                      {QUEUE_ITEMS.find((o) => o.value === q.name)?.label ?? q.name}
                      {q.paused && <Badge variant="secondary">Paused</Badge>}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`${q.paused ? "Resume" : "Pause"} ${q.name} queue`}
                      onClick={() =>
                        q.paused
                          ? act(() => adminResumeQueue({ data: { queue: q.name } }))
                          : setConfirm({
                              title: `Pause ${q.name} queue?`,
                              description: "Workers stop taking new jobs from this queue.",
                              action: "Pause",
                              run: () => adminPauseQueue({ data: { queue: q.name } }),
                            })
                      }
                    >
                      {q.paused ? "Resume" : "Pause"}
                    </Button>
                  </div>
                  <dl className="grid grid-cols-3 gap-2">
                    {STATE_ITEMS.map(({ value: key, label }) => (
                      <div key={key}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd
                          className={`font-medium tabular-nums ${
                            q.counts[key] === 0
                              ? "text-muted-foreground/60"
                              : key === "failed"
                                ? "text-destructive"
                                : ""
                          }`}
                        >
                          {q.counts[key]}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex items-center justify-between gap-2 text-muted-foreground">
                    <span>
                      Oldest waiting:{" "}
                      {q.oldestWaitingMs === null ? "none" : formatAge(q.oldestWaitingMs)}
                    </span>
                    {samples.length > 1 && (
                      <LineSparkline
                        data={samples.map((x) => ({
                          depth:
                            q.name === "runs"
                              ? x.runsActive + x.runsWaiting
                              : x.systemActive + x.systemWaiting,
                        }))}
                        dataKey="depth"
                        width={96}
                        height={24}
                        color="var(--chart-foreground-muted)"
                        aria-label={`${q.name} queue depth, last ${formatAge(samples.length * REFRESH_MS)}`}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
            <StatGroup>
              <Stat
                label="Sweeper requeues"
                value={String(counters.sweeper_requeued)}
                hint="lost runs queued again"
              />
              <Stat
                label="Org cap delays"
                value={String(counters.org_cap_delayed)}
                hint="held by the project limit"
              />
              <Stat
                label="Workflow cap delays"
                value={String(counters.workflow_cap_delayed)}
                hint="held by the workflow limit"
              />
            </StatGroup>
          </Section>

          <Section title="Workers">
            {overview.workers.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>No workers online</EmptyTitle>
                  <EmptyDescription>Start a worker to run workflows.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Host</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Load</TableHead>
                    <TableHead>Active runs</TableHead>
                    <TableHead>Uptime</TableHead>
                    <TableHead>Last seen</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.workers.map((w) => {
                    const stale = isStaleWorker(w.lastSeenAt, now);
                    return (
                      <TableRow key={w.id}>
                        <TableCell className="font-medium">
                          <span className="flex items-center gap-2">
                            <span
                              aria-hidden="true"
                              className={`size-1.5 rounded-full ${stale ? "bg-red-500" : "bg-emerald-500"}`}
                            />
                            {w.host}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{w.version}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2 text-muted-foreground tabular-nums">
                            <Meter value={w.activeRuns.length} max={w.concurrency} />
                            {w.activeRuns.length} / {w.concurrency}
                          </div>
                        </TableCell>
                        <TableCell
                          className="max-w-48 truncate font-mono text-muted-foreground"
                          title={w.activeRuns.join(", ")}
                        >
                          {w.activeRuns.length === 0
                            ? "–"
                            : w.activeRuns.map((id) => id.slice(0, 8)).join(", ")}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatAge(now - w.startedAt)}
                        </TableCell>
                        <TableCell className={stale ? "text-destructive" : "text-muted-foreground"}>
                          {formatAge(now - w.lastSeenAt)} ago{stale && " (stale)"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Section>
        </>
      )}

      {tab === "jobs" && (
        <Section
          title="Jobs"
          actions={
            <Select
              items={QUEUE_ITEMS}
              value={queue}
              onValueChange={(v) => v && setQueue(v === "system" ? "system" : "runs")}
            >
              <SelectTrigger aria-label="Queue" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {QUEUE_ITEMS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <div role="tablist" aria-label="Job state" className="flex flex-wrap gap-1">
              {STATE_ITEMS.map((o) => {
                const count = overview.queues.find((q) => q.name === queue)?.counts[o.value] ?? 0;
                const on = o.value === state;
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => setState(o.value)}
                    className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 hover:text-foreground ${on ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
                  >
                    {o.label}
                    <span
                      className={`tabular-nums ${o.value === "failed" && count > 0 ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {jobs === null ? (
            <div className="flex flex-col gap-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-11 w-full" />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyDescription>
                  No {state} jobs in the {queue} queue.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Failed reason</TableHead>
                  <TableHead>Age</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="max-w-56">
                      <div className="truncate font-medium" title={job.workflowName ?? undefined}>
                        {job.workflowName ?? job.name}
                      </div>
                      <div className="truncate text-muted-foreground" title={job.id}>
                        {job.projectName ?? "–"} · {job.name}
                      </div>
                    </TableCell>
                    <TableCell>{runLink(job)}</TableCell>
                    <TableCell className="text-muted-foreground">{job.attemptsMade}</TableCell>
                    <TableCell
                      className="max-w-56 truncate text-muted-foreground"
                      title={job.failedReason ?? undefined}
                    >
                      {job.failedReason ?? "–"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatAge(now - job.timestamp)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {state === "failed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Retry job ${job.id}`}
                            onClick={() =>
                              act(() => adminRetryJob({ data: { queue, jobId: job.id } }))
                            }
                          >
                            Retry
                          </Button>
                        )}
                        {state === "delayed" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Promote job ${job.id}`}
                            onClick={() =>
                              act(() => adminPromoteJob({ data: { queue, jobId: job.id } }))
                            }
                          >
                            Promote
                          </Button>
                        )}
                        {job.runId && (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`Cancel run ${job.runId}`}
                            onClick={() => {
                              const runId = job.runId;
                              if (!runId) return;
                              setConfirm({
                                title: "Cancel run?",
                                description: `Run ${runId} stops and its jobs are removed.`,
                                action: "Cancel run",
                                run: () => adminCancelRun({ data: { runId } }),
                              });
                            }}
                          >
                            Cancel run
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Remove job ${job.id}`}
                          onClick={() =>
                            setConfirm({
                              title: "Remove job?",
                              description: `Job ${job.id} is deleted from the ${queue} queue.`,
                              action: "Remove",
                              run: () => adminRemoveJob({ data: { queue, jobId: job.id } }),
                            })
                          }
                        >
                          Remove
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <div className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <span className="font-medium">Clean up</span>
              <span className="text-muted-foreground">
                Delete old jobs from the {queue} queue. This cannot be undone.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                items={CLEAN_ITEMS}
                value={cleanState}
                onValueChange={(v) => {
                  const next = CLEAN_ITEMS.find((s) => s.value === v);
                  if (next) setCleanState(next.value);
                }}
              >
                <SelectTrigger aria-label="Clean state" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLEAN_ITEMS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select items={AGE_ITEMS} value={cleanAge} onValueChange={(v) => v && setCleanAge(v)}>
                <SelectTrigger aria-label="Clean age" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AGE_ITEMS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                onClick={() =>
                  setConfirm({
                    title: `Clean ${cleanState} jobs?`,
                    description: `Deletes ${cleanState} jobs from the ${queue} queue. This cannot be undone.`,
                    action: "Clean",
                    run: () =>
                      adminCleanQueue({
                        data: { queue, state: cleanState, olderThanMs: Number(cleanAge) },
                      }),
                  })
                }
              >
                Clean
              </Button>
            </div>
          </div>
        </Section>
      )}

      {tab === "instance" && (
        <>
          <Section title="Instance">
            <div className="divide-y overflow-hidden rounded-xl border">
              <VersionRow />
              <SignupRow />
            </div>
          </Section>

          <Section title="Recent admin actions">
            {overview.audit.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyDescription>No admin actions yet.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="divide-y overflow-hidden rounded-xl border">
                {overview.audit.map((row) => (
                  <li key={row.id} className="flex flex-wrap gap-x-2 px-4 py-2.5">
                    <span className="font-medium">{row.action}</span>
                    <span className="text-muted-foreground">
                      {row.targetType} {row.targetId} by {row.actorEmail},{" "}
                      {formatAge(now - new Date(row.createdAt).getTime())} ago
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}

      {tab === "auth" && (
        <>
          <Section title="Login">
            <AccountForm />
          </Section>
          <Section title="Password">
            <PasswordForm />
          </Section>
          <Section title="Passkeys">
            <PasskeyList />
          </Section>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          description={confirm.description}
          action={confirm.action}
          cancel="Keep"
          destructive
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void runConfirmed()}
        />
      )}
    </main>
  );
}
