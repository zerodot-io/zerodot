// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Background, Controls, ReactFlow } from "@xyflow/react";
import { Badge, Button } from "@zerodot/ui";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import {
  EditorActionsContext,
  NodeStatusContext,
  ZerodotNode,
} from "../components/editor/zerodot-node";
import { JsonView } from "../components/json-view";
import { StatusLabel } from "../components/status-dot";
import { type NodeRunStatus, parseGraph, toFlow } from "../lib/flow";
import { formatDuration, formatTime } from "../lib/format";
import { useRefreshOnEvents } from "../lib/use-event-source";
import { getRunFn, retryRunFn } from "../server/fns";

export const Route = createFileRoute("/p/$projectSlug/runs/$runId")({
  head: () => ({ meta: [{ title: "Run · zerodot" }] }),
  loader: ({ params }) =>
    getRunFn({ data: { projectSlug: params.projectSlug, runId: params.runId } }),
  component: RunDetail,
});

const nodeTypes = { zerodot: ZerodotNode };
const NODE_STATUSES: string[] = ["running", "waiting", "succeeded", "failed", "skipped"];

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">{title}</span>
      <JsonView value={value} className="max-h-64" />
    </div>
  );
}

function LogBlock({ logs }: { logs: { level: string; message: string }[] }) {
  if (logs.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground">Logs</span>
      <pre className="max-h-64 overflow-auto rounded-md border p-2 font-mono whitespace-pre-wrap">
        {logs.map((entry, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the list does not change
            key={i}
            className={
              entry.level === "error"
                ? "text-destructive"
                : entry.level === "warn" || entry.level === "debug"
                  ? "text-muted-foreground"
                  : undefined
            }
          >
            {entry.message}
          </div>
        ))}
      </pre>
    </div>
  );
}

function RunDetail() {
  const { run, graph, results } = Route.useLoaderData();
  const { projectSlug, runId } = Route.useParams();
  const navigate = useNavigate();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  /** Make a new run that goes on from the failed node, then open it. */
  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const result = await retryRunFn({ data: { projectSlug, runId } });
      await navigate({
        to: "/p/$projectSlug/runs/$runId",
        params: { projectSlug, runId: result.runId },
      });
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : "Could not retry the run");
    } finally {
      setRetrying(false);
    }
  }
  const live = run.status === "queued" || run.status === "running" || run.status === "waiting";
  useRefreshOnEvents(
    live ? `/api/p/${projectSlug}/runs/${runId}/events` : null,
    [
      "run.started",
      "run.waiting",
      "node.started",
      "node.waiting",
      "node.succeeded",
      "node.failed",
      "node.skipped",
      "run.finished",
    ],
    250,
  );

  // The last attempt of each node is the one that counts.
  const latest = new Map<string, (typeof results)[number]>();
  for (const result of results) {
    const current = latest.get(result.nodeId);
    if (!current || result.attempt > current.attempt) latest.set(result.nodeId, result);
  }
  const statuses: Record<string, NodeRunStatus> = {};
  for (const [nodeId, result] of latest) {
    if (NODE_STATUSES.includes(result.status)) statuses[nodeId] = result.status as NodeRunStatus;
  }

  const flow = useMemo(() => toFlow(parseGraph(graph)), [graph]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedNode = flow.nodes.find((n) => n.id === selectedId);
  const selectedResult = selectedId ? latest.get(selectedId) : undefined;

  return (
    <div className="flex h-[calc(100svh-3.5rem)] min-w-0 overflow-hidden">
      <div className="min-w-0 flex-1">
        <NodeStatusContext.Provider value={statuses}>
          <EditorActionsContext.Provider value={{ addAfter: () => {}, readOnly: true }}>
            <ReactFlow
              nodes={flow.nodes.map((n) => ({ ...n, selected: n.id === selectedId }))}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              nodesDraggable={false}
              nodesConnectable={false}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              defaultEdgeOptions={{
                style: { strokeWidth: 2, stroke: "var(--color-muted-foreground)" },
              }}
              fitView
              fitViewOptions={{ minZoom: 1.307, maxZoom: 1.307, padding: 0.3 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background />
              <Controls showInteractive={false} fitViewOptions={{ maxZoom: 1, padding: 1 }} />
            </ReactFlow>
          </EditorActionsContext.Provider>
        </NodeStatusContext.Provider>
      </div>
      <aside className="flex w-96 shrink-0 flex-col gap-6 overflow-y-auto border-l p-4">
        <div className="flex flex-col gap-3">
          <Link
            to="/p/$projectSlug/runs"
            params={{ projectSlug }}
            className="text-muted-foreground hover:text-foreground"
          >
            Runs
          </Link>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="min-w-0 truncate font-semibold">{run.workflowName}</h1>
              {run.mode === "test" && <Badge variant="secondary">test</Badge>}
              <span className="ml-auto shrink-0">
                <StatusLabel status={run.status} />
              </span>
            </div>
            <p className="text-muted-foreground">
              {formatTime(run.startedAt ?? run.createdAt)} ·{" "}
              {formatDuration(run.startedAt, run.finishedAt)} · {run.triggerName ?? run.triggerType}
            </p>
          </div>
          {run.error && (
            <p role="alert" className="text-destructive">
              {run.error.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/p/$projectSlug/workflows/$workflowId"
                  params={{ projectSlug, workflowId: run.workflowId }}
                />
              }
            >
              Edit workflow
            </Button>
            {run.status === "failed" && (
              <Button variant="outline" disabled={retrying} onClick={retry}>
                Retry from failed node
              </Button>
            )}
          </div>
          {retryError && (
            <p role="alert" className="text-destructive">
              {retryError}
            </p>
          )}
        </div>
        {selectedNode ? (
          <div className="flex flex-col gap-4 border-t pt-4">
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-semibold">
                {selectedNode.data.graphNode.name}
              </span>
              {selectedResult && <StatusLabel status={selectedResult.status} />}
            </div>
            {selectedResult ? (
              <>
                <p className="text-muted-foreground">
                  {formatDuration(selectedResult.startedAt, selectedResult.finishedAt)}
                  {selectedResult.attempt > 1 && ` · attempt ${selectedResult.attempt}`}
                </p>
                {selectedResult.error && (
                  <p role="alert" className="text-destructive">
                    {selectedResult.error.message}
                    {selectedResult.error.path ? ` (at ${selectedResult.error.path})` : ""}
                  </p>
                )}
                <JsonBlock title="Input" value={selectedResult.input} />
                <JsonBlock title="Output" value={selectedResult.output} />
                <LogBlock logs={selectedResult.logs} />
              </>
            ) : (
              <p className="text-muted-foreground">This node did not run.</p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-4 border-t pt-4">
            <p className="text-muted-foreground">Select a node to see its input and output.</p>
            <JsonBlock title="Trigger input" value={run.triggerInput} />
          </div>
        )}
      </aside>
    </div>
  );
}
