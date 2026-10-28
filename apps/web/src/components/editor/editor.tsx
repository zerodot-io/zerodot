// SPDX-License-Identifier: AGPL-3.0-only

import {
  addEdge,
  Background,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  ReactFlow,
  type ReactFlowInstance,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Graph } from "@zerodot/engine";
import { inputPortsOf, isBackEdge, isTriggerType, outputPortsOf } from "@zerodot/engine";
import { catalog, registry } from "@zerodot/nodes";
import type { RunEvent } from "@zerodot/queue";
import {
  Button,
  Combobox,
  cn,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  Switch,
  Textarea,
  Tooltip,
  toast,
} from "@zerodot/ui";
import "@xyflow/react/dist/style.css";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  History,
  Loader2,
  Maximize,
  Minus,
  Play,
  Plus,
  Rocket,
  Settings,
  Square,
  Trash2,
  Workflow as WorkflowIcon,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  catalogByType,
  copyGraph,
  type NodeRunStatus,
  newNode,
  parseGraph,
  pasteGraph,
  toFlow,
  toGraph,
  uniqueName,
  type ZerodotFlowNode,
} from "../../lib/flow";
import type { Json } from "../../lib/json";
import { arrangeNodes } from "../../lib/layout";
import {
  exportWorkflowFn,
  getWorkflowFn,
  linkTestRunFn,
  listenForTestEventFn,
  publishFn,
  renameWorkflowFn,
  saveDraftFn,
  setActiveFn,
  setWorkflowTimezoneFn,
  startTestRunFn,
  stopListeningFn,
  takeTestEventFn,
  testWebhookUrlFn,
  updateWorkflowSettingsFn,
} from "../../server/fns";
import type { SavedCredential } from "../credential-dialog";
import {
  InputDataContext,
  NodeNamesContext,
  NodeOutputsContext,
  type VariableHint,
  VariablesContext,
} from "../expression-input";
import { NodeIcon } from "../node-icon";
import { AvailableNodePackages } from "../node-packages";
import type { TableHint } from "../schema-form";
import { TimezoneSelect } from "../timezone-select";
import { NodeDialog, type NodeIO } from "./node-dialog";
import { VersionHistory } from "./version-history";
import { EDGE_COLOR, ZerodotConnectionLine, ZerodotEdge } from "./zerodot-edge";
import {
  EdgeCountContext,
  EditorActionsContext,
  NodeStatusContext,
  ZerodotNode,
} from "./zerodot-node";

const nodeTypes = { zerodot: ZerodotNode };
const edgeTypes = { zerodot: ZerodotEdge };
const EVENT_TYPES: RunEvent["type"][] = [
  "run.started",
  "run.waiting",
  "node.started",
  "node.waiting",
  "node.succeeded",
  "node.failed",
  "node.skipped",
  "run.finished",
];

type WorkflowSettingsPatch = {
  description?: string | null;
  tags?: string[];
  timeoutSeconds?: number | null;
  saveSuccessData?: boolean;
  saveFailureData?: boolean;
  errorWorkflowId?: string | null;
  autoRetryMax?: number;
  autoRetryBackoffMs?: number;
};

type Workflow = {
  id: string;
  name: string;
  active: boolean;
  published: boolean;
  publishedGraph: Json | null;
  draftGraph: Json;
  timezone: string | null;
  description: string | null;
  tags: string[];
  timeoutSeconds: number | null;
  saveSuccessData: boolean;
  saveFailureData: boolean;
  errorWorkflowId: string | null;
  autoRetryMax: number;
  autoRetryBackoffMs: number;
  projectTimezone: string | null;
  triggers: { nodeId: string; type: string; url: string | null }[];
};

type CatalogEntry = (typeof catalog)[number];
/** A row of the Add node list: one node, or one app that holds several nodes. */
type AddRow =
  | {
      kind: "node";
      key: string;
      entry: CatalogEntry;
      /** An action of the node, shown in the app view: its name and the config that it sets. */
      action?: { label: string; config: Record<string, unknown> };
    }
  | { kind: "app"; key: string; app: string; entries: CatalogEntry[] };

/** App of a node in the Add node list. A node with actions is its own app. */
const appOf = (entry: { app?: string; label: string; actions?: unknown[] }) =>
  entry.app ?? (entry.actions?.length ? entry.label : undefined);

const isWebhookType = (type: string) => type === "trigger.webhook";

/** What the Add node search reads of a node: name, text, and type, but not the actions. */
const nodeText = (entry: { label: string; description?: string; type: string }) =>
  `${entry.label} ${entry.description ?? ""} ${entry.type}`.toLowerCase();

/** The same, with the app, the category, and the action names. */
const searchText = (entry: {
  label: string;
  description?: string;
  type: string;
  app?: string;
  category: string;
  actions?: { label: string }[];
}) =>
  `${nodeText(entry)} ${entry.app ?? ""} ${entry.category} ${(entry.actions ?? [])
    .map((action) => action.label)
    .join(" ")}`.toLowerCase();

const NO_ERROR_WORKFLOW = "__none";

/** A trigger that registers its test address at a service, so a person does not call the address. */
const hasServiceTest = (type: string) => catalogByType.get(type)?.webhookTest !== undefined;

/** Show a message as a toast with an icon. A null message does nothing. */
function setMessage(message: string | null) {
  if (!message) return;
  if (/^could not|not valid|failed/i.test(message)) toast.error(message);
  else if (/^published/i.test(message)) toast.success(message);
  else toast.info(message);
}

const LOOP_TYPE = "flow.loop";
const NOOP_TYPE = "flow.noop";

export function Editor({
  projectSlug,
  workflow,
  credentials: initialCredentials,
  variables,
  tables,
  otherWorkflows,
}: {
  otherWorkflows: { id: string; name: string }[];
  tables: TableHint[];
  projectSlug: string;
  workflow: Workflow;
  credentials: SavedCredential[];
  variables: VariableHint[];
}) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const router = useRouter();
  const initial = useMemo(() => toFlow(parseGraph(workflow.draftGraph)), [workflow.draftGraph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ZerodotFlowNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [openId, setOpenId] = useState<string | null>(null);
  const flowRef = useRef<ReactFlowInstance<ZerodotFlowNode, Edge> | null>(null);
  const fit = useCallback(() => {
    flowRef.current?.fitView({ minZoom: 1.307, maxZoom: 1.307, padding: 0.3, duration: 300 });
  }, []);
  const arrangeAndFit = useCallback(() => {
    const from = new Map(nodes.map((n) => [n.id, n.position]));
    const target = arrangeNodes(nodes, edges);
    const duration = 300;
    const start = performance.now();
    // Slide each node to its place, then fit. The view does not move while the nodes slide.
    const step = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const e = 1 - (1 - t) ** 3;
      setNodes(
        target.map((n) => {
          const p = from.get(n.id) ?? n.position;
          return {
            ...n,
            position: {
              x: p.x + (n.position.x - p.x) * e,
              y: p.y + (n.position.y - p.y) * e,
            },
          };
        }),
      );
      if (t < 1) requestAnimationFrame(step);
      else fit();
    };
    requestAnimationFrame(step);
  }, [nodes, edges, setNodes, fit]);
  const [timezone, setTimezone] = useState(workflow.timezone ?? "");
  const defaultTimezone = timezone || workflow.projectTimezone || "UTC";
  const [description, setDescription] = useState(workflow.description ?? "");
  const [tags, setTags] = useState(workflow.tags.join(", "));
  const [timeout, setTimeoutSeconds] = useState(workflow.timeoutSeconds?.toString() ?? "");
  const [saveSuccessData, setSaveSuccessData] = useState(workflow.saveSuccessData);
  const [saveFailureData, setSaveFailureData] = useState(workflow.saveFailureData);
  const [errorWorkflowId, setErrorWorkflowId] = useState(workflow.errorWorkflowId ?? "");
  const [autoRetryMax, setAutoRetryMax] = useState(workflow.autoRetryMax.toString());
  const [autoRetryWait, setAutoRetryWait] = useState(
    (workflow.autoRetryBackoffMs / 1000).toString(),
  );
  /** What the server holds, so a blur without a change sends nothing. */
  const saved = useRef({
    autoRetryMax: workflow.autoRetryMax,
    autoRetryBackoffMs: workflow.autoRetryBackoffMs,
    description: workflow.description ?? "",
    tags: workflow.tags,
    timeoutSeconds: workflow.timeoutSeconds,
  });
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [canvasEl, setCanvasEl] = useState<HTMLElement | null>(null);
  const [addQuery, setAddQuery] = useState("");
  /** Goes up when a package was installed, so the list reads the catalog again. */
  const [catalogTick, setCatalogTick] = useState(0);
  /** The app whose nodes the Add node list shows. Null: the list of all nodes and apps. */
  const [addApp, setAddApp] = useState<string | null>(null);
  /** The edge that gets the new node. Without it, the node goes on the canvas alone. */
  const [insertEdgeId, setInsertEdgeId] = useState<string | null>(null);
  /** The output port that gets the new node. */
  const [addFrom, setAddFrom] = useState<{ nodeId: string; port: string } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, NodeRunStatus>>({});
  const [ios, setIos] = useState<Record<string, NodeIO>>({});
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [name, setName] = useState(workflow.name);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [triggerInput, setTriggerInput] = useState("{}");
  const [runId, setRunId] = useState<string | null>(null);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [active, setActive] = useState(workflow.active);
  const source = useRef<EventSource | null>(null);
  const [testUrls, setTestUrls] = useState<Record<string, string>>({});
  /** The trigger node that waits for a test event. */
  const [listeningId, setListeningId] = useState<string | null>(null);

  // Items on each edge: the output of its source node, if the node sent it out of that port.
  const edgeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const edge of edges) {
      const io = ios[edge.source];
      if (io?.output === undefined) continue;
      if (edge.sourceHandle && io.port && edge.sourceHandle !== io.port) continue;
      counts[edge.id] = Array.isArray(io.output) ? io.output.length : 1;
    }
    return counts;
  }, [edges, ios]);

  const graph: Graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);

  // Publish stays off while the canvas equals the published version.
  const [publishedJson, setPublishedJson] = useState(
    workflow.publishedGraph ? JSON.stringify(parseGraph(workflow.publishedGraph)) : null,
  );
  useEffect(() => {
    setPublishedJson(
      workflow.publishedGraph ? JSON.stringify(parseGraph(workflow.publishedGraph)) : null,
    );
  }, [workflow.publishedGraph]);
  const hasChanges = publishedJson === null || JSON.stringify(graph) !== publishedJson;

  // Autosave the draft. Selection and size changes do not change the graph JSON.
  const lastSaved = useRef(JSON.stringify(parseGraph(workflow.draftGraph)));
  useEffect(() => {
    const json = JSON.stringify(graph);
    if (json === lastSaved.current) return;
    setSaveState("saving");
    const timer = setTimeout(async () => {
      try {
        await saveDraftFn({ data: { projectSlug, workflowId: workflow.id, graph } });
        lastSaved.current = json;
        setSaveState("saved");
        setMessage(null);
      } catch (error) {
        setSaveState("error");
        setMessage(error instanceof Error ? error.message : "Could not save");
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [graph, projectSlug, workflow.id]);

  useEffect(() => () => source.current?.close(), []);

  // An AI client edits the draft through the API. Show the new draft on the canvas at once.
  // Unsaved edits of the user win, so the canvas does not jump under their hands.
  const graphRef = useRef(graph);
  graphRef.current = graph;
  useEffect(() => {
    const events = new EventSource(`/api/p/${projectSlug}/events`);
    events.addEventListener("workflow.draft", async (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as { workflowId: string };
      if (data.workflowId !== workflow.id) return;
      if (JSON.stringify(graphRef.current) !== lastSaved.current) return;
      try {
        const fresh = await getWorkflowFn({ data: { projectSlug, workflowId: workflow.id } });
        const next = parseGraph(fresh.draftGraph);
        const json = JSON.stringify(next);
        if (json === lastSaved.current) return;
        if (JSON.stringify(graphRef.current) !== lastSaved.current) return;
        const flow = toFlow(next);
        lastSaved.current = json;
        setNodes(flow.nodes);
        setEdges(flow.edges);
      } catch {
        // The next event tries again.
      }
    });
    return () => events.close();
  }, [projectSlug, workflow.id, setNodes, setEdges]);

  // Select all, copy, and paste work on the canvas, not while the user types or a dialog is open.
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const busy = (target: EventTarget | null) =>
      typing(target) ||
      document.querySelector('[role="dialog"]') !== null ||
      (window.getSelection()?.toString() ?? "") !== "";

    const onKeyDown = (event: KeyboardEvent) => {
      // Tab only opens the add node sheet. It never moves focus, except in fields and dialogs.
      if (event.key === "Tab") {
        if (typing(event.target) || document.querySelector('[role="dialog"]') !== null) return;
        event.preventDefault();
        if (!event.shiftKey && !event.altKey) setAddOpen(true);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a") return;
      if (busy(event.target)) return;
      event.preventDefault();
      setNodes((all) => all.map((n) => ({ ...n, selected: true })));
      setEdges((all) => all.map((e) => ({ ...e, selected: true })));
    };
    const onCopy = (event: ClipboardEvent) => {
      if (busy(event.target)) return;
      const text = copyGraph(nodesRef.current, edgesRef.current);
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData("text/plain", text);
    };
    const onPaste = (event: ClipboardEvent) => {
      if (busy(event.target)) return;
      const pasted = pasteGraph(event.clipboardData?.getData("text/plain") ?? "", nodesRef.current);
      if (!pasted) return;
      event.preventDefault();
      setNodes((all) => [...all.map((n) => ({ ...n, selected: false })), ...pasted.nodes]);
      setEdges((all) => [...all.map((e) => ({ ...e, selected: false })), ...pasted.edges]);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [setNodes, setEdges]);

  const selected = nodes.find((n) => n.id === openId) ?? null;
  /** A workflow can have many triggers, or none. Another workflow can start it. */
  const hasTrigger = nodes.some((n) => isTriggerType(n.data.graphNode.type));

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((current) => addEdge({ ...connection, type: "zerodot" }, current)),
    [setEdges],
  );

  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      // The target port must exist with the config of the node (a Merge node has 2 to 10 inputs).
      const targetNode = nodes.find((n) => n.id === connection.target);
      const targetDefinition = targetNode && registry.get(targetNode.data.graphNode.type);
      if (
        targetNode &&
        targetDefinition &&
        connection.targetHandle &&
        !inputPortsOf(targetDefinition, targetNode.data.graphNode.config).includes(
          connection.targetHandle,
        )
      ) {
        return false;
      }
      // A trigger starts the run, so no edge leads into it.
      const target = nodes.find((n) => n.id === connection.target);
      if (!target || isTriggerType(target.data.graphNode.type)) return false;
      if (registry.get(target.data.graphNode.type)?.join) {
        // A merge node takes one edge on each input.
        const toPort = connection.targetHandle ?? "in";
        return !edges.some(
          (e) => e.target === connection.target && (e.targetHandle ?? "in") === toPort,
        );
      }
      // Other nodes take one forward edge. A loop adds an edge that comes back, and a node can
      // connect to itself (the loop output of Loop Over Items). Join branches with a Merge node.
      const all = [...edges, { id: "new", source: connection.source, target: connection.target }];
      const graphEdges = all.map((e) => ({
        id: e.id,
        from: e.source,
        fromPort: "",
        to: e.target,
        toPort: "",
      }));
      const forward = graphEdges.filter(
        (e) => e.to === connection.target && !isBackEdge(graphEdges, e),
      );
      return forward.length <= 1;
    },
    [nodes, edges],
  );

  /** Add a node. With `from`, place it after that node and connect the two. */

  async function saveSettings(patch: WorkflowSettingsPatch, undo: () => void) {
    try {
      await updateWorkflowSettingsFn({
        data: { projectSlug, workflowId: workflow.id, ...patch },
      });
    } catch {
      undo();
      setMessage("Could not save the settings");
    }
  }

  function addNode(
    type: string,
    from?: { nodeId: string; port: string },
    config?: Record<string, unknown>,
  ) {
    const node = newNode(type, nodes, config);
    const parent = from ? nodes.find((n) => n.id === from.nodeId) : undefined;
    if (parent && from) {
      const entry = catalogByType.get(parent.data.graphNode.type);
      const ports = entry?.ports.out ?? ["out"];
      const index = Math.max(0, ports.indexOf(from.port));
      node.position = {
        x: parent.position.x + 220,
        y: parent.position.y + (index - (ports.length - 1) / 2) * 120,
      };
      node.data.graphNode.position = node.position;
    }
    // A new loop comes with a placeholder node in the loop, wired back to the loop.
    const placeholder = type === LOOP_TYPE ? newNode(NOOP_TYPE, [...nodes, node]) : null;
    if (placeholder) {
      placeholder.data.graphNode.name = uniqueName(
        "Replace Me",
        [...nodes, node].map((n) => n.data.graphNode.name),
      );
      placeholder.position = { x: node.position.x + 220, y: node.position.y + 140 };
      placeholder.data.graphNode.position = placeholder.position;
    }
    setNodes((current) => [
      ...current.map((n) => ({ ...n, selected: false })),
      { ...node, selected: true },
      ...(placeholder ? [placeholder] : []),
    ]);
    const edgeId = () => `e_${crypto.randomUUID().slice(0, 8)}`;
    setEdges((current) => [
      ...current,
      ...(parent && from
        ? [
            {
              id: edgeId(),
              source: from.nodeId,
              sourceHandle: from.port,
              target: node.id,
              targetHandle: catalogByType.get(type)?.ports.in[0] ?? "in",
              type: "zerodot",
            },
          ]
        : []),
      ...(placeholder
        ? [
            {
              id: edgeId(),
              source: node.id,
              sourceHandle: "loop",
              target: placeholder.id,
              targetHandle: "in",
              type: "zerodot",
            },
            {
              id: edgeId(),
              source: placeholder.id,
              sourceHandle: "out",
              target: node.id,
              targetHandle: "in",
              type: "zerodot",
            },
          ]
        : []),
    ]);
  }

  /** Add a node in the middle of an edge. The edge becomes two edges. */
  function insertNode(type: string, edgeId: string, config?: Record<string, unknown>) {
    const edge = edges.find((e) => e.id === edgeId);
    const from = nodes.find((n) => n.id === edge?.source);
    const to = nodes.find((n) => n.id === edge?.target);
    if (!edge || !from || !to || isTriggerType(type)) return;
    const node = newNode(type, nodes, config);
    node.position = {
      x: (from.position.x + to.position.x) / 2,
      y: (from.position.y + to.position.y) / 2,
    };
    node.data.graphNode.position = node.position;
    const outPort = catalogByType.get(type)?.ports.out[0] ?? "out";
    const edgeId2 = () => `e_${crypto.randomUUID().slice(0, 8)}`;
    setNodes((current) => [
      ...current.map((n) => ({ ...n, selected: false })),
      { ...node, selected: true },
    ]);
    setEdges((current) => [
      ...current.filter((e) => e.id !== edgeId),
      {
        id: edgeId2(),
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: node.id,
        targetHandle: catalogByType.get(type)?.ports.in[0] ?? "in",
        type: "zerodot",
      },
      {
        id: edgeId2(),
        source: node.id,
        sourceHandle: outPort,
        target: edge.target,
        targetHandle: edge.targetHandle,
        type: "zerodot",
      },
    ]);
  }

  /** The inputs of a node that joins several parents, for the input pane of its dialog. */
  const selectedInputPorts = (() => {
    const graphNode = selected?.data.graphNode;
    const definition = graphNode && registry.get(graphNode.type);
    if (!graphNode || !definition?.join) return null;
    return inputPortsOf(definition, graphNode.config).map((port) => ({
      port,
      connected: edges.some((e) => e.target === graphNode.id && (e.targetHandle ?? "in") === port),
    }));
  })();

  function updateSelected(
    update: (n: ZerodotFlowNode["data"]["graphNode"]) => ZerodotFlowNode["data"]["graphNode"],
  ) {
    const current = nodes.find((n) => n.id === openId);
    if (!current) return;
    const next = update(current.data.graphNode);
    setNodes((all) => all.map((n) => (n.id === openId ? { ...n, data: { graphNode: next } } : n)));
    // A switch can lose a case. Remove the edges that left from a port that is gone.
    const definition = registry.get(next.type);
    if (definition) {
      const ports = new Set(outputPortsOf(definition, next.config));
      // A Merge node can lose an input. Its edges are removed too, so the graph has no edge into a
      // port that is gone. Raising the count again does not bring them back (undo does).
      const inPorts = new Set(inputPortsOf(definition, next.config));
      const gone = (e: Edge) =>
        (e.source === next.id && !ports.has(e.sourceHandle ?? "out")) ||
        (e.target === next.id && !inPorts.has(e.targetHandle ?? "in"));
      const removed = edges.filter(gone).length;
      setEdges((all) => all.filter((e) => !gone(e)));
      if (removed > 0) {
        setMessage(
          `Removed ${removed} ${removed === 1 ? "connection" : "connections"} of ports that are gone`,
        );
      }
    }
  }

  function onEvent(event: RunEvent) {
    switch (event.type) {
      case "run.started":
        setRunStatus("running");
        break;
      case "node.started":
        setStatuses((s) => ({ ...s, [event.nodeId]: "running" }));
        break;
      case "run.waiting":
        setRunStatus("waiting");
        break;
      case "node.waiting":
        setStatuses((s) => ({ ...s, [event.nodeId]: "waiting" }));
        break;
      case "node.succeeded":
        setStatuses((s) => ({ ...s, [event.nodeId]: "succeeded" }));
        setIos((s) => ({
          ...s,
          [event.nodeId]: {
            ...s[event.nodeId],
            output: event.output,
            port: event.port,
            error: undefined,
          },
        }));
        break;
      case "node.failed":
        setStatuses((s) => ({ ...s, [event.nodeId]: "failed" }));
        setIos((s) => ({ ...s, [event.nodeId]: { ...s[event.nodeId], error: event.error } }));
        break;
      case "node.skipped":
        setStatuses((s) => ({ ...s, [event.nodeId]: "skipped" }));
        break;
      case "run.finished":
        setRunStatus(event.status);
        source.current?.close();
        break;
    }
  }

  function parseTriggerInput(): { ok: true; value: unknown } | { ok: false } {
    try {
      return { ok: true, value: JSON.parse(triggerInput) };
    } catch {
      setMessage("Trigger input is not valid JSON");
      return { ok: false };
    }
  }

  /** Remove the results of the last test run from the canvas and the side pane. */
  function clearResults() {
    source.current?.close();
    setStatuses({});
    setIos({});
    setRunId(null);
    setRunStatus(null);
    setMessage(null);
  }

  type Target = Parameters<typeof startTestRunFn>[0]["data"]["target"];

  /** One test run. `target` stops it early: run to a node, or run one node. */
  async function startRun(target?: Target, input?: unknown): Promise<string | undefined> {
    setMessage(null);
    const parsed = input === undefined ? parseTriggerInput() : { ok: true as const, value: input };
    if (!parsed.ok) return undefined;
    try {
      source.current?.close();
      // A step run keeps the results of the other nodes.
      if (target?.kind === "only") {
        setStatuses((s) => ({ ...s, [target.nodeId]: "running" }));
      } else {
        setStatuses({});
        setIos({});
        setOpenId(null);
      }
      const result = await startTestRunFn({
        data: { projectSlug, workflowId: workflow.id, graph, input: parsed.value, target },
      });
      setRunId(result.runId);
      setRunStatus("queued");
      const started = result.runId;
      const es = new EventSource(`/api/p/${projectSlug}/runs/${result.runId}/events`);
      source.current = es;
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, (message) => onEvent(JSON.parse((message as MessageEvent).data)));
      }
      return started;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start the run");
      return undefined;
    }
  }

  /** The Execute workflow button. A Webhook or an app trigger waits for an event. */
  function testRun() {
    const listenable = nodes.find(
      (n) => isWebhookType(n.data.graphNode.type) || hasServiceTest(n.data.graphNode.type),
    );
    if (listenable) return void listenForTestEvent(listenable.id, true);
    return startRun();
  }

  /** Last known output of each node. Pinned data fills in for a node that has not run. */
  function knownOutputs() {
    const known: Record<string, { port: string; data: unknown }> = {};
    for (const node of nodes) {
      const io = ios[node.id];
      const pinned = node.data.graphNode.pinned;
      if (io?.output !== undefined) known[node.id] = { port: io.port ?? "out", data: io.output };
      else if (pinned) known[node.id] = pinned;
    }
    return known;
  }

  function executeStep(node: ZerodotFlowNode | null = selected) {
    if (!node) return;
    const input = inputFor(node);
    if (input === undefined) {
      setMessage(
        "This node has no input yet. Run the workflow, or pin output on the node before it.",
      );
      return;
    }
    return startRun({ kind: "only", nodeId: node.id, input, outputs: knownOutputs() });
  }

  // A webhook trigger gets its test URL when its dialog opens. It does not need a publish.
  const selectedId = selected?.id;
  const selectedType = selected?.data.graphNode.type;
  const selectedConfig = selected?.data.graphNode.config;
  const selectedPath = typeof selectedConfig?.path === "string" ? selectedConfig.path : undefined;
  const loadTestUrl = useCallback(
    (nodeId: string, path: string | undefined) => {
      testWebhookUrlFn({ data: { projectSlug, workflowId: workflow.id, nodeId, path } })
        .then(({ url }) => setTestUrls((urls) => ({ ...urls, [nodeId]: url })))
        .catch(() => undefined);
    },
    [projectSlug, workflow.id],
  );
  useEffect(() => {
    if (!selectedId || !selectedType) return;
    if (!isWebhookType(selectedType) && !hasServiceTest(selectedType)) return;
    loadTestUrl(selectedId, selectedPath);
  }, [selectedId, selectedType, selectedPath, loadTestUrl]);

  /** `whole`: the event starts the whole workflow, not only the trigger node. */
  async function listenForTestEvent(nodeId: string | undefined = selected?.id, whole = false) {
    const target = nodesRef.current.find((n) => n.id === nodeId)?.data.graphNode;
    const config = target?.config;
    const nodeType = target?.type;
    if (!nodeId || !config) return;
    setMessage(null);
    try {
      await listenForTestEventFn({
        data: {
          projectSlug,
          workflowId: workflow.id,
          nodeId,
          path: typeof config.path === "string" ? config.path : undefined,
          service: serviceOf(nodeId),
          method:
            typeof config.httpMethod === "string"
              ? config.httpMethod
              : nodeType === "trigger.webhook" || serviceOf(nodeId)
                ? "POST"
                : "GET",
          // This node answers by itself, so the test route answers at once.
          mode:
            nodeType === "trigger.webhook" && typeof config.responseMode === "string"
              ? config.responseMode
              : "immediate",
        },
      });
      listenWholeRef.current = whole;
      setListeningId(nodeId);
      loadTestUrl(nodeId, typeof config.path === "string" ? config.path : undefined);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not listen");
    }
  }

  const listenWholeRef = useRef(false);
  const gotTestEventRef = useRef<(nodeId: string, event: unknown) => void | Promise<void>>(
    () => {},
  );
  gotTestEventRef.current = async (nodeId, event) => {
    setTriggerInput(JSON.stringify(event, null, 2));
    const mode = nodesRef.current.find((n) => n.id === nodeId)?.data.graphNode.config.responseMode;
    if (mode !== "lastNode" && mode !== "respondNode" && !listenWholeRef.current) {
      void startRun({ kind: "only", nodeId, input: event, outputs: knownOutputs() });
      return;
    }
    // The caller waits for an answer. Run the whole workflow, and tell the test URL which run answers.
    const started = await startRun(undefined, event);
    if (!started) return;
    await linkTestRunFn({
      data: { projectSlug, workflowId: workflow.id, nodeId, path: pathOf(nodeId), runId: started },
    }).catch(() => undefined);
  };

  /** An app trigger needs its credential and config, to move its webhook at the service to the test URL. */
  function serviceOf(nodeId: string) {
    const node = nodesRef.current.find((n) => n.id === nodeId)?.data.graphNode;
    if (!node || !hasServiceTest(node.type)) return undefined;
    return { type: node.type, credentialId: node.credentialId ?? null, config: node.config };
  }

  /** The path of a Webhook node. It is part of the test URL. */
  function pathOf(nodeId: string): string | undefined {
    const path = nodesRef.current.find((n) => n.id === nodeId)?.data.graphNode.config.path;
    return typeof path === "string" ? path : undefined;
  }

  async function stopListening() {
    const nodeId = listeningId;
    setListeningId(null);
    if (!nodeId) return;
    await stopListeningFn({
      data: {
        projectSlug,
        workflowId: workflow.id,
        nodeId,
        path: pathOf(nodeId),
        service: serviceOf(nodeId),
      },
    }).catch(() => undefined);
  }

  // Ask the server once a second. The test URL stores the first request that it gets.
  const stopListeningRef = useRef(stopListening);
  stopListeningRef.current = stopListening;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the tick must not restart on each render
  useEffect(() => {
    if (!listeningId) return;
    const deadline = Date.now() + 120_000;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        void stopListeningRef.current();
        return;
      }
      try {
        const { event } = await takeTestEventFn({
          data: {
            projectSlug,
            workflowId: workflow.id,
            nodeId: listeningId,
            path: pathOf(listeningId),
            service: serviceOf(listeningId),
          },
        });
        if (event === null) return;
        setListeningId(null);
        // The timer started in an old render. This ref holds the newest graph and results.
        gotTestEventRef.current(listeningId, event);
      } catch {
        // The next tick tries again.
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [listeningId, projectSlug, workflow.id]);

  /** A version was copied into the draft on the server. Show it on the canvas. */
  function showRestored(draftGraph: Json, version: number) {
    const next = parseGraph(draftGraph);
    const flow = toFlow(next);
    lastSaved.current = JSON.stringify(next);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setOpenId(null);
    setSaveState("saved");
    setMessage(`Draft restored from version ${version}`);
  }

  /** Download the saved draft. Autosave runs first, so the file matches the canvas. */
  async function exportFile() {
    setMessage(null);
    try {
      if (JSON.stringify(graph) !== lastSaved.current) {
        await saveDraftFn({ data: { projectSlug, workflowId: workflow.id, graph } });
        lastSaved.current = JSON.stringify(graph);
        setSaveState("saved");
      }
      const file = await exportWorkflowFn({ data: { projectSlug, workflowId: workflow.id } });
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${workflow.name.replace(/[^\w-]+/g, "-")}.zerodot.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not export");
    }
  }

  async function publish() {
    setMessage(null);
    try {
      const result = await publishFn({ data: { projectSlug, workflowId: workflow.id, graph } });
      lastSaved.current = JSON.stringify(graph);
      setPublishedJson(lastSaved.current);
      setSaveState("saved");
      setMessage(`Published version ${result.version}`);
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not publish");
    }
  }

  async function toggleActive(next: boolean) {
    if (next && !hasTrigger) {
      toast.warning("Add a trigger node before you activate the workflow");
      return;
    }
    if (next && !workflow.published) {
      toast.warning("Publish the workflow before you activate it");
      return;
    }
    try {
      await setActiveFn({ data: { projectSlug, workflowId: workflow.id, active: next } });
      setActive(next);
      setMessage(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not change the state");
    }
  }

  /** The input of a node is the output of its parent. A trigger gets the test input. */
  function inputFor(node: ZerodotFlowNode): unknown {
    const incoming = edges.filter((e) => e.target === node.id);
    if (incoming.length === 0) {
      try {
        return JSON.parse(triggerInput);
      } catch {
        return undefined;
      }
    }
    // A join node (Merge) gets the data of each input port, like the engine gives it.
    const joinDefinition = registry.get(node.data.graphNode.type);
    if (joinDefinition?.join) {
      const byPort: Record<string, unknown> = {};
      for (const edge of incoming) {
        const port = edge.targetHandle ?? "in";
        const parent = nodes.find((n) => n.id === edge.source);
        const data = ios[edge.source]?.output ?? parent?.data.graphNode.pinned?.data;
        if (data !== undefined && byPort[port] === undefined) byPort[port] = data;
      }
      return Object.keys(byPort).length > 0 ? byPort : undefined;
    }
    // A node can have more than one parent. Use the first parent that has data.
    for (const edge of incoming) {
      const parent = nodes.find((n) => n.id === edge.source);
      const data = ios[edge.source]?.output ?? parent?.data.graphNode.pinned?.data;
      if (data !== undefined) return data;
    }
    return undefined;
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogTick means the catalog changed
  const addGroups = useMemo(() => {
    const query = addQuery.trim().toLowerCase();
    const visible = catalog.filter((entry) => {
      return !((insertEdgeId || addFrom) && isTriggerType(entry.type));
    });
    if (addApp) {
      const groups = new Map<string, AddRow[]>();
      for (const entry of visible) {
        if (appOf(entry) !== addApp) continue;
        const labelMatch = !query || nodeText(entry).includes(query);
        const group = entry.category === "trigger" ? "triggers" : "actions";
        // A node with actions gives one row for each action.
        const rows: AddRow[] = entry.actions?.length
          ? entry.actions
              .filter((action) => labelMatch || action.label.toLowerCase().includes(query))
              .map((action, index) => ({
                kind: "node",
                key: `${entry.type}#${index}`,
                entry,
                action,
              }))
          : labelMatch
            ? [{ kind: "node", key: entry.type, entry }]
            : [];
        groups.set(group, [...(groups.get(group) ?? []), ...rows]);
      }
      return [...groups];
    }
    const matched = visible.filter((entry) => {
      return !query || searchText({ ...entry, app: appOf(entry) }).includes(query);
    });
    const apps = new Map<string, CatalogEntry[]>();
    for (const entry of matched) {
      const app = appOf(entry);
      if (app) apps.set(app, [...(apps.get(app) ?? []), entry]);
    }
    const groups = new Map<string, AddRow[]>();
    const add = (category: string, row: AddRow) =>
      groups.set(category, [...(groups.get(category) ?? []), row]);
    const placed = new Set<string>();
    for (const entry of matched) {
      const app = appOf(entry);
      const members = app ? (apps.get(app) ?? []) : [];
      // A node with actions gets its own app row, so the user sees its operations.
      if (!app || (members.length < 2 && !entry.actions?.length)) {
        add(entry.category, { kind: "node", key: entry.type, entry });
      } else if (!placed.has(app)) {
        placed.add(app);
        // The app sits with its actions. An app with triggers only sits with the triggers.
        const first = members.find((m) => m.category !== "trigger") ?? members[0] ?? entry;
        add(first.category, {
          kind: "app",
          key: `app:${app}`,
          app,
          entries: members,
        });
      }
    }
    return [...groups];
  }, [addQuery, addApp, insertEdgeId, addFrom, catalogTick]);

  async function commitRename() {
    const next = renaming?.trim();
    setRenaming(null);
    if (!next || next === name) return;
    try {
      const saved = await renameWorkflowFn({
        data: { projectSlug, workflowId: workflow.id, name: next },
      });
      setName(saved.name);
    } catch {
      setMessage("Could not rename the workflow");
    }
  }

  const [addActive, setAddActive] = useState(0);
  /** Categories the person opened or closed. Null: every category is open. */
  const [openCategories, setOpenCategories] = useState<string[] | null>(null);
  // A search opens every category that has a match.
  const isCategoryOpen = (category: string) =>
    addQuery.trim() !== "" || openCategories === null || openCategories.includes(category);
  function toggleCategory(category: string) {
    const current = openCategories ?? addGroups.map(([name]) => name);
    setOpenCategories(
      current.includes(category) ? current.filter((c) => c !== category) : [...current, category],
    );
    setAddActive(0);
  }
  const addFlat = useMemo(
    () =>
      addGroups.flatMap(([category, rows]) =>
        addQuery.trim() !== "" || openCategories === null || openCategories.includes(category)
          ? rows
          : [],
      ),
    [addGroups, openCategories, addQuery],
  );
  const activeRow = addFlat[Math.min(addActive, addFlat.length - 1)];
  const activeKey = activeRow?.key;

  const addAppEntry = addApp ? catalog.find((entry) => appOf(entry) === addApp) : undefined;

  function openApp(app: string | null) {
    setAddApp(app);
    setAddQuery("");
    setAddActive(0);
  }

  function pickRow(row: AddRow) {
    if (row.kind === "app") openApp(row.app);
    else pickNode(row.entry.type, row.action?.config);
  }

  function pickNode(type: string, config?: Record<string, unknown>) {
    if (insertEdgeId) insertNode(type, insertEdgeId, config);
    else addNode(type, addFrom ?? undefined, config);
    setAddOpen(false);
    setAddQuery("");
    setAddApp(null);
    setInsertEdgeId(null);
    setAddFrom(null);
  }

  useEffect(() => {
    if (!addOpen || !activeKey) return;
    document.getElementById(`add-node-${activeKey}`)?.scrollIntoView({ block: "nearest" });
  }, [addOpen, activeKey]);

  const nodeNames = useMemo(() => nodes.map((n) => n.data.graphNode.name), [nodes]);
  const nodeOutputs = useMemo(() => {
    const known: Record<string, unknown> = {};
    for (const n of nodes) {
      const data = ios[n.id]?.output ?? n.data.graphNode.pinned?.data;
      if (data !== undefined) known[n.data.graphNode.name] = data;
    }
    return known;
  }, [nodes, ios]);
  const selectedIo = selected ? { ...ios[selected.id], input: inputFor(selected) } : undefined;
  const webhookUrl = workflow.triggers.find((t) => t.nodeId === selected?.id && t.url)?.url ?? null;

  return (
    <VariablesContext.Provider value={variables}>
      <NodeNamesContext.Provider value={nodeNames}>
        <NodeOutputsContext.Provider value={nodeOutputs}>
          <InputDataContext.Provider value={selected ? inputFor(selected) : undefined}>
            <div className="flex h-svh min-w-0 flex-col overflow-hidden">
              <div className="flex items-center gap-3 border-b px-4 py-2">
                <Link
                  to="/p/$projectSlug/workflows"
                  params={{ projectSlug }}
                  search={{ all: true }}
                  className="text-muted-foreground"
                >
                  Workflows
                </Link>
                {renaming === null ? (
                  <button
                    type="button"
                    aria-label="Rename workflow"
                    onClick={() => setRenaming(name)}
                    className="rounded-md px-1.5 py-0.5 font-semibold hover:bg-muted"
                  >
                    {name}
                  </button>
                ) : (
                  <input
                    // biome-ignore lint/a11y/noAutofocus: the person just chose to edit the name
                    autoFocus
                    aria-label="Workflow name"
                    value={renaming}
                    maxLength={120}
                    onChange={(event) => setRenaming(event.target.value)}
                    onFocus={(event) => event.target.select()}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    className="rounded-md border bg-background px-1.5 py-0.5 font-semibold outline-none"
                  />
                )}
                <span className="text-muted-foreground" aria-live="polite">
                  {saveState === "saving"
                    ? "Saving…"
                    : saveState === "error"
                      ? "Not saved"
                      : "Saved"}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Version history"
                    onClick={() => {
                      setSettingsOpen(false);
                      setHistoryOpen(true);
                    }}
                  >
                    <History />
                  </Button>
                  <VersionHistory
                    open={historyOpen}
                    onOpenChange={setHistoryOpen}
                    container={canvasEl}
                    projectSlug={projectSlug}
                    workflowId={workflow.id}
                    onRestored={showRestored}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Workflow settings"
                    onClick={() => setSettingsOpen(true)}
                  >
                    <Settings />
                  </Button>
                  <Sheet open={settingsOpen} onOpenChange={setSettingsOpen} modal={false}>
                    <SheetContent container={canvasEl}>
                      <SheetHeader>
                        <SheetTitle>Workflow settings</SheetTitle>
                      </SheetHeader>
                      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
                        <section className="flex flex-col gap-4">
                          <h3 className="font-medium text-muted-foreground">General</h3>
                          <Field>
                            <FieldLabel htmlFor="workflow-description">Description</FieldLabel>
                            <Textarea
                              id="workflow-description"
                              rows={2}
                              maxLength={500}
                              value={description}
                              onChange={(event) => setDescription(event.target.value)}
                              onBlur={() => {
                                const next = description.trim();
                                if (next === saved.current.description) return;
                                saved.current.description = next;
                                void saveSettings({ description: next || null }, () => undefined);
                              }}
                            />
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="workflow-tags">Tags</FieldLabel>
                            <Input
                              id="workflow-tags"
                              placeholder="billing, daily"
                              value={tags}
                              onChange={(event) => setTags(event.target.value)}
                              onBlur={() => {
                                const next = [
                                  ...new Set(
                                    tags
                                      .split(",")
                                      .map((tag) => tag.trim())
                                      .filter(Boolean),
                                  ),
                                ].slice(0, 10);
                                setTags(next.join(", "));
                                if (next.join(",") === saved.current.tags.join(",")) return;
                                const previous = saved.current.tags;
                                saved.current.tags = next;
                                void saveSettings({ tags: next }, () => {
                                  saved.current.tags = previous;
                                  setTags(previous.join(", "));
                                });
                              }}
                            />
                            <FieldDescription>Separate tags with commas.</FieldDescription>
                          </Field>
                        </section>
                        <section className="flex flex-col gap-4">
                          <h3 className="font-medium text-muted-foreground">Execution</h3>
                          <Field>
                            <FieldLabel htmlFor="workflow-timezone">Time zone</FieldLabel>
                            <TimezoneSelect
                              id="workflow-timezone"
                              className="w-full"
                              value={timezone}
                              inheritLabel={`Project (${workflow.projectTimezone || "UTC"})`}
                              onChange={async (next) => {
                                const previous = timezone;
                                setTimezone(next);
                                try {
                                  await setWorkflowTimezoneFn({
                                    data: {
                                      projectSlug,
                                      workflowId: workflow.id,
                                      timezone: next || null,
                                    },
                                  });
                                } catch {
                                  setTimezone(previous);
                                  setMessage("Could not save the time zone");
                                }
                              }}
                            />
                            <FieldDescription>
                              Schedule nodes use it when they set no time zone of their own.
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="workflow-timeout">Timeout (seconds)</FieldLabel>
                            <Input
                              id="workflow-timeout"
                              type="number"
                              min={1}
                              max={86400}
                              placeholder="Default"
                              value={timeout}
                              onChange={(event) => setTimeoutSeconds(event.target.value)}
                              onBlur={() => {
                                const parsed = Number.parseInt(timeout, 10);
                                const next =
                                  Number.isFinite(parsed) && parsed >= 1
                                    ? Math.min(parsed, 86_400)
                                    : null;
                                setTimeoutSeconds(next?.toString() ?? "");
                                if (next === saved.current.timeoutSeconds) return;
                                const previous = saved.current.timeoutSeconds;
                                saved.current.timeoutSeconds = next;
                                void saveSettings({ timeoutSeconds: next }, () => {
                                  saved.current.timeoutSeconds = previous;
                                  setTimeoutSeconds(previous?.toString() ?? "");
                                });
                              }}
                            />
                            <FieldDescription>
                              Stops a run that takes longer. Empty uses the server default.
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="workflow-error-workflow">
                              Error workflow
                            </FieldLabel>
                            <Combobox
                              id="workflow-error-workflow"
                              className="w-full"
                              items={[
                                { value: NO_ERROR_WORKFLOW, label: "None" },
                                ...otherWorkflows.map((w) => ({ value: w.id, label: w.name })),
                              ]}
                              value={errorWorkflowId || NO_ERROR_WORKFLOW}
                              placeholder="Search workflows"
                              onValueChange={(next) => {
                                const value = next === NO_ERROR_WORKFLOW ? "" : next;
                                const previous = errorWorkflowId;
                                setErrorWorkflowId(value);
                                void saveSettings({ errorWorkflowId: value || null }, () =>
                                  setErrorWorkflowId(previous),
                                );
                              }}
                            />
                            <FieldDescription>
                              Runs when a live run of this workflow fails. It needs an Error Trigger
                              node and a published version. With auto retry on, it runs after the
                              last retry fails.
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="workflow-auto-retry">Auto retries</FieldLabel>
                            <Input
                              id="workflow-auto-retry"
                              type="number"
                              min={0}
                              max={10}
                              value={autoRetryMax}
                              onChange={(event) => setAutoRetryMax(event.target.value)}
                              onBlur={() => {
                                const parsed = Number.parseInt(autoRetryMax, 10);
                                const next = Number.isFinite(parsed)
                                  ? Math.min(Math.max(parsed, 0), 10)
                                  : 0;
                                setAutoRetryMax(next.toString());
                                if (next === saved.current.autoRetryMax) return;
                                const previous = saved.current.autoRetryMax;
                                saved.current.autoRetryMax = next;
                                void saveSettings({ autoRetryMax: next }, () => {
                                  saved.current.autoRetryMax = previous;
                                  setAutoRetryMax(previous.toString());
                                });
                              }}
                            />
                            <FieldDescription>
                              Tries a failed live run again from the failed node, up to this many
                              times. 0 turns it off.
                            </FieldDescription>
                          </Field>
                          <Field>
                            <FieldLabel htmlFor="workflow-auto-retry-wait">
                              Wait between retries (seconds)
                            </FieldLabel>
                            <Input
                              id="workflow-auto-retry-wait"
                              type="number"
                              min={0}
                              max={3600}
                              value={autoRetryWait}
                              onChange={(event) => setAutoRetryWait(event.target.value)}
                              onBlur={() => {
                                const parsed = Number.parseFloat(autoRetryWait);
                                const seconds = Number.isFinite(parsed)
                                  ? Math.min(Math.max(parsed, 0), 3600)
                                  : 0;
                                const next = Math.round(seconds * 1000);
                                setAutoRetryWait((next / 1000).toString());
                                if (next === saved.current.autoRetryBackoffMs) return;
                                const previous = saved.current.autoRetryBackoffMs;
                                saved.current.autoRetryBackoffMs = next;
                                void saveSettings({ autoRetryBackoffMs: next }, () => {
                                  saved.current.autoRetryBackoffMs = previous;
                                  setAutoRetryWait((previous / 1000).toString());
                                });
                              }}
                            />
                          </Field>
                        </section>
                        <section className="flex flex-col gap-4">
                          <h3 className="font-medium text-muted-foreground">Run data</h3>
                          <div className="flex items-center justify-between gap-2">
                            <label htmlFor="workflow-save-success">
                              Save data of successful runs
                            </label>
                            <Switch
                              id="workflow-save-success"
                              checked={saveSuccessData}
                              onCheckedChange={(next) => {
                                setSaveSuccessData(next);
                                void saveSettings({ saveSuccessData: next }, () =>
                                  setSaveSuccessData(!next),
                                );
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <label htmlFor="workflow-save-failure">Save data of failed runs</label>
                            <Switch
                              id="workflow-save-failure"
                              checked={saveFailureData}
                              onCheckedChange={(next) => {
                                setSaveFailureData(next);
                                void saveSettings({ saveFailureData: next }, () =>
                                  setSaveFailureData(!next),
                                );
                              }}
                            />
                          </div>
                          <p className="text-pretty text-muted-foreground">
                            Applies to live runs. Test runs always keep their data.
                          </p>
                        </section>
                      </div>
                    </SheetContent>
                  </Sheet>
                  <Button variant="outline" onClick={exportFile}>
                    <Download />
                    Export
                  </Button>
                  <Button onClick={publish} disabled={!hasChanges}>
                    <Rocket />
                    Publish
                  </Button>
                  <div className="flex items-center gap-2">
                    <Switch id="workflow-active" checked={active} onCheckedChange={toggleActive} />
                    <label htmlFor="workflow-active">Active</label>
                  </div>
                </div>
              </div>
              <div className="flex min-h-0 flex-1">
                <div ref={setCanvasEl} className="relative min-w-0 flex-1 overflow-clip">
                  <EdgeCountContext.Provider value={edgeCounts}>
                    <NodeStatusContext.Provider value={statuses}>
                      <EditorActionsContext.Provider
                        value={{
                          addAfter: (nodeId, port) => {
                            setAddFrom({ nodeId, port });
                            setAddOpen(true);
                          },
                          executeNode: (nodeId) =>
                            void executeStep(nodes.find((n) => n.id === nodeId) ?? null),
                          openNode: setOpenId,
                          insertOnEdge: (edgeId) => {
                            setInsertEdgeId(edgeId);
                            setAddOpen(true);
                          },
                        }}
                      >
                        <ReactFlow
                          nodes={nodes}
                          edges={edges}
                          nodeTypes={nodeTypes}
                          edgeTypes={edgeTypes}
                          onNodesChange={onNodesChange}
                          onEdgesChange={onEdgesChange}
                          onConnect={onConnect}
                          // The plus button of a port is a handle. A click opens its menu, not a connection.
                          connectOnClick={false}
                          isValidConnection={isValidConnection}
                          onNodeDoubleClick={(_, node) => setOpenId(node.id)}
                          connectionLineComponent={ZerodotConnectionLine}
                          defaultEdgeOptions={{
                            type: "zerodot",
                            style: { strokeWidth: 1.25, stroke: EDGE_COLOR },
                          }}
                          zoomOnDoubleClick={false}
                          // Drag selects. Hold Space, Cmd or Ctrl to pan. Middle or right button pans too.
                          selectionOnDrag
                          panOnDrag={[1, 2]}
                          panActivationKeyCode={["Space", "Meta", "Control"]}
                          onInit={(instance) => {
                            flowRef.current = instance;
                          }}
                          fitView
                          fitViewOptions={{ minZoom: 1.307, maxZoom: 1.307, padding: 0.3 }}
                          proOptions={{ hideAttribution: true }}
                        >
                          <Background />
                          <Controls showZoom={false} showFitView={false} showInteractive={false}>
                            <Tooltip label="Zoom in" side="right">
                              <ControlButton onClick={() => flowRef.current?.zoomIn()}>
                                <Plus className="fill-none" />
                              </ControlButton>
                            </Tooltip>
                            <Tooltip label="Zoom out" side="right">
                              <ControlButton onClick={() => flowRef.current?.zoomOut()}>
                                <Minus className="fill-none" />
                              </ControlButton>
                            </Tooltip>
                            <Tooltip label="Fit view" side="right">
                              <ControlButton onClick={fit}>
                                <Maximize className="fill-none" />
                              </ControlButton>
                            </Tooltip>
                            <Tooltip label="Auto arrange" side="right">
                              <ControlButton onClick={arrangeAndFit}>
                                <WorkflowIcon className="fill-none" />
                              </ControlButton>
                            </Tooltip>
                          </Controls>
                        </ReactFlow>
                      </EditorActionsContext.Provider>
                    </NodeStatusContext.Provider>
                  </EdgeCountContext.Provider>
                  <Button
                    size="icon-lg"
                    variant="outline"
                    className="group absolute top-4 right-4 z-10 rounded-full bg-card shadow-md hover:border-primary hover:bg-primary hover:text-primary-foreground"
                    aria-label="Add node"
                    title="Add node (Tab)"
                    onClick={() => setAddOpen(true)}
                  >
                    <Plus />
                  </Button>
                  <div className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-3">
                    <div className="flex items-center rounded-full">
                      <div
                        className={cn(
                          "grid transition-[grid-template-columns,opacity] duration-300 ease-out",
                          listeningId ? "grid-cols-[0fr] opacity-0" : "grid-cols-[1fr] opacity-100",
                        )}
                        inert={!!listeningId}
                      >
                        <div className="flex items-center gap-2 overflow-hidden p-1 -m-1">
                          <Button
                            size="icon-lg"
                            className="shrink-0 rounded-full shadow-md"
                            disabled={runStatus === "queued" || runStatus === "running"}
                            aria-label="Execute workflow"
                            title="Execute workflow"
                            onClick={testRun}
                          >
                            {runStatus === "queued" || runStatus === "running" ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Play />
                            )}
                          </Button>
                          {(runId || Object.keys(ios).length > 0) && (
                            <Button
                              size="icon-lg"
                              variant="outline"
                              className="shrink-0 rounded-full bg-card shadow-md"
                              aria-label="Clear results"
                              title="Clear results"
                              onClick={clearResults}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div
                        className={cn(
                          "grid transition-[grid-template-columns,opacity] duration-300 ease-out",
                          listeningId ? "grid-cols-[1fr] opacity-100" : "grid-cols-[0fr] opacity-0",
                        )}
                        inert={!listeningId}
                      >
                        <div className="overflow-hidden p-1 -m-1">
                          <div
                            role="status"
                            className="flex w-[28rem] max-w-[calc(100vw-4rem)] items-center gap-3 whitespace-nowrap rounded-full border bg-card py-1.5 pr-1.5 pl-4 shadow-md"
                          >
                            <span className="relative flex size-2 shrink-0">
                              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary opacity-60" />
                              <span className="relative inline-flex size-2 rounded-full bg-primary" />
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span>Listening for test event</span>
                              {listeningId && testUrls[listeningId] && (
                                <code className="truncate text-muted-foreground text-xs">
                                  {testUrls[listeningId]}
                                </code>
                              )}
                            </span>
                            <Button
                              size="icon-lg"
                              className="shrink-0 rounded-full"
                              aria-label="Stop listening"
                              title="Stop listening"
                              onClick={stopListening}
                            >
                              <Square className="fill-current" />
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <Sheet
                modal={false}
                open={addOpen}
                onOpenChange={(open) => {
                  setAddOpen(open);
                  if (!open) {
                    setAddQuery("");
                    setAddApp(null);
                    setInsertEdgeId(null);
                    setAddFrom(null);
                  }
                  setAddActive(0);
                }}
              >
                <SheetContent container={canvasEl}>
                  <SheetHeader className={cn(addApp && "bg-muted/50")}>
                    {addApp ? (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Back to all nodes"
                          onClick={() => openApp(null)}
                        >
                          <ArrowLeft />
                        </Button>
                        {addAppEntry && (
                          <NodeIcon
                            name={addAppEntry.icon}
                            src={addAppEntry.iconUrl}
                            category={addAppEntry.category}
                            className="size-7 [&>svg]:size-4"
                          />
                        )}
                        <SheetTitle>{addApp}</SheetTitle>
                      </div>
                    ) : (
                      <SheetTitle>Add node</SheetTitle>
                    )}
                    <Input
                      autoFocus
                      placeholder={addApp ? `Search ${addApp} nodes` : "Search nodes"}
                      aria-label="Search nodes"
                      value={addQuery}
                      onChange={(event) => {
                        setAddQuery(event.target.value);
                        setAddActive(0);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                          event.preventDefault();
                          const step = event.key === "ArrowDown" ? 1 : -1;
                          const count = addFlat.length;
                          if (count)
                            setAddActive((i) => (Math.min(i, count - 1) + step + count) % count);
                        } else if (event.key === "Enter" && activeRow) {
                          event.preventDefault();
                          pickRow(activeRow);
                        } else if (event.key === "Backspace" && addApp && !addQuery) {
                          event.preventDefault();
                          openApp(null);
                        }
                      }}
                    />
                  </SheetHeader>
                  <div
                    className={cn(
                      "flex min-h-0 flex-1 flex-col overflow-y-auto",
                      addApp ? "gap-3 pb-2" : "gap-4 p-2",
                    )}
                  >
                    {addGroups.map(([category, rows]) => {
                      const open = isCategoryOpen(category);
                      return (
                        <div key={category} className="flex flex-col">
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-expanded={open}
                            className={cn(
                              "flex items-center gap-1 text-left font-medium capitalize hover:bg-muted",
                              addApp ? "border-b px-4 py-2" : "rounded-lg px-2 py-1.5",
                            )}
                            onClick={() => toggleCategory(category)}
                          >
                            {!addApp && (
                              <ChevronRight
                                className={cn(
                                  "size-4 text-muted-foreground transition-transform duration-150 ease-out",
                                  open && "rotate-90",
                                )}
                              />
                            )}
                            {category} ({rows.length})
                            {addApp && category === "triggers" && (
                              <Zap className="size-3.5 fill-primary text-primary" />
                            )}
                            {addApp && (
                              <ChevronRight
                                className={cn(
                                  "ml-auto size-4 text-muted-foreground transition-transform duration-150 ease-out",
                                  open ? "rotate-90" : "-rotate-90",
                                )}
                              />
                            )}
                          </button>
                          {open &&
                            rows.map((row) => {
                              const first = row.kind === "app" ? row.entries[0] : row.entry;
                              if (!first) return null;
                              const actions =
                                row.kind === "app"
                                  ? row.entries
                                      .filter((e) => e.category !== "trigger")
                                      .reduce((sum, e) => sum + (e.actions?.length ?? 1), 0)
                                  : 0;
                              const triggers =
                                row.kind === "app" ? row.entries.length - actions : 0;
                              return (
                                <button
                                  key={row.key}
                                  id={`add-node-${row.key}`}
                                  type="button"
                                  tabIndex={-1}
                                  className={cn(
                                    "flex items-center text-left hover:bg-muted",
                                    addApp ? "gap-2.5 px-4 py-1.5" : "gap-3 rounded-lg px-2 py-2",
                                    row.key === activeKey && "bg-muted",
                                  )}
                                  onMouseMove={() => {
                                    const i = addFlat.findIndex((r) => r.key === row.key);
                                    if (i >= 0) setAddActive(i);
                                  }}
                                  onClick={() => pickRow(row)}
                                >
                                  <NodeIcon
                                    name={first.icon}
                                    src={first.iconUrl}
                                    category={first.category}
                                    className={
                                      addApp ? "size-6 [&>svg]:size-4" : "size-9 [&>svg]:size-5"
                                    }
                                  />
                                  <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="flex items-center gap-2">
                                      {row.kind === "app"
                                        ? row.app
                                        : (row.action?.label ?? row.entry.label)}
                                      {row.kind === "node" && row.entry.category === "trigger" && (
                                        <Zap className="size-3.5 fill-primary text-primary" />
                                      )}
                                    </span>
                                    {row.kind === "app" ? (
                                      <span className="text-muted-foreground">
                                        {[
                                          actions > 0 &&
                                            `${actions} ${actions === 1 ? "action" : "actions"}`,
                                          triggers > 0 &&
                                            `${triggers} ${triggers === 1 ? "trigger" : "triggers"}`,
                                        ]
                                          .filter(Boolean)
                                          .join(", ")}
                                      </span>
                                    ) : (
                                      !addApp &&
                                      row.entry.description && (
                                        <span className="text-muted-foreground">
                                          {row.entry.description}
                                        </span>
                                      )
                                    )}
                                  </span>
                                  {row.kind === "app" && (
                                    <ChevronRight className="size-4 text-muted-foreground" />
                                  )}
                                </button>
                              );
                            })}
                        </div>
                      );
                    })}
                    {!addApp && (
                      <AvailableNodePackages
                        query={addQuery}
                        onInstalled={() => setCatalogTick((tick) => tick + 1)}
                        showEmpty={addGroups.length === 0}
                      />
                    )}
                    {addGroups.length === 0 && addApp && (
                      <p className="px-2 text-muted-foreground">No nodes found</p>
                    )}
                  </div>
                </SheetContent>
              </Sheet>
              <NodeDialog
                tables={tables}
                workflows={otherWorkflows}
                defaultTimezone={defaultTimezone}
                projectSlug={projectSlug}
                credentials={credentials}
                onCredentialCreated={(created) =>
                  setCredentials((all) => [...all.filter((c) => c.id !== created.id), created])
                }
                node={selected}
                hasInput={selected !== null && edges.some((e) => e.target === selected.id)}
                inputPorts={selectedInputPorts}
                io={selectedIo}
                webhookUrl={webhookUrl}
                testUrl={selected ? (testUrls[selected.id] ?? null) : null}
                listening={selected !== null && listeningId === selected.id}
                onListen={() => listenForTestEvent()}
                onStopListen={stopListening}
                // Listening goes on after the dialog closes. The node shows it on the canvas.
                onClose={() => setOpenId(null)}
                onChange={updateSelected}
                onExecuteStep={() => void executeStep()}
                busy={runStatus === "queued" || runStatus === "running"}
              />
            </div>
          </InputDataContext.Provider>
        </NodeOutputsContext.Provider>
      </NodeNamesContext.Provider>
    </VariablesContext.Provider>
  );
}
