// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zerodot/ui";
import { StatusLabel } from "../components/status-dot";
import { formatDuration, formatTime } from "../lib/format";
import { useRefreshOnEvents } from "../lib/use-event-source";
import { listRunsFn, listWorkflowsFn } from "../server/fns";

const STATUSES = ["queued", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
const TRIGGERS = ["webhook", "cron", "poll", "listen", "manual"];
const MODES = ["production", "test"] as const;

type Search = {
  wf?: string;
  status?: (typeof STATUSES)[number];
  trigger?: string;
  mode?: (typeof MODES)[number];
};

export const Route = createFileRoute("/p/$projectSlug/runs/")({
  head: () => ({ meta: [{ title: "Runs · zerodot" }] }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    wf: typeof raw.wf === "string" ? raw.wf : undefined,
    status: STATUSES.find((s) => s === raw.status),
    trigger:
      typeof raw.trigger === "string" && TRIGGERS.includes(raw.trigger) ? raw.trigger : undefined,
    mode: MODES.find((m) => m === raw.mode),
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const [runs, workflows] = await Promise.all([
      listRunsFn({
        data: {
          projectSlug: params.projectSlug,
          workflowId: deps.wf,
          status: deps.status,
          triggerType: deps.trigger,
          mode: deps.mode,
        },
      }),
      listWorkflowsFn({ data: { projectSlug: params.projectSlug } }),
    ]);
    return { ...runs, workflows };
  },
  component: Runs,
});

function FilterSelect({
  label,
  all,
  options,
  value,
  onChange,
}: {
  label: string;
  all: string;
  options: { value: string; label: string }[];
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select
      items={[{ value: "all", label: all }, ...options]}
      value={value ?? "all"}
      onValueChange={(v) => onChange(!v || v === "all" ? undefined : v)}
    >
      <SelectTrigger aria-label={label} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{all}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Runs() {
  const { items, workflows } = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const set = (patch: Search) => navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const filtered = Boolean(search.wf || search.status || search.trigger || search.mode);
  useRefreshOnEvents(
    `/api/p/${projectSlug}/events`,
    ["run.started", "run.waiting", "run.finished"],
    400,
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <h1 className="font-semibold">Runs</h1>
      <div className="flex flex-wrap gap-2">
        <FilterSelect
          label="Workflow"
          all="All workflows"
          options={workflows.map((w) => ({ value: w.id, label: w.name }))}
          value={search.wf}
          onChange={(wf) => set({ wf })}
        />
        <FilterSelect
          label="Status"
          all="All statuses"
          options={STATUSES.map((s) => ({ value: s, label: s }))}
          value={search.status}
          onChange={(status) => set({ status: STATUSES.find((s) => s === status) })}
        />
        <FilterSelect
          label="Trigger"
          all="All triggers"
          options={TRIGGERS.map((t) => ({ value: t, label: t }))}
          value={search.trigger}
          onChange={(trigger) => set({ trigger })}
        />
        <FilterSelect
          label="Mode"
          all="All modes"
          options={MODES.map((m) => ({ value: m, label: m }))}
          value={search.mode}
          onChange={(mode) => set({ mode: MODES.find((m) => m === mode) })}
        />
      </div>
      {items.length === 0 ? (
        <p className="text-muted-foreground">{filtered ? "No runs match." : "No runs yet."}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((run) => (
              <TableRow key={run.id}>
                <TableCell>
                  <Link
                    to="/p/$projectSlug/runs/$runId"
                    params={{ projectSlug, runId: run.id }}
                    className="font-medium"
                  >
                    {run.workflowName}
                  </Link>
                  {run.mode === "test" && (
                    <Badge variant="secondary" className="ml-2">
                      test
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <StatusLabel status={run.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {run.triggerName ?? run.triggerType}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatTime(run.startedAt ?? run.createdAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDuration(run.startedAt, run.finishedAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </main>
  );
}
