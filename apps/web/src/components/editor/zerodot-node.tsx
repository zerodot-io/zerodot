// SPDX-License-Identifier: AGPL-3.0-only

import {
  Copy01Icon,
  Delete02Icon,
  FlashIcon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PinIcon,
  PlayIcon,
  PlusSignIcon,
  PowerServiceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Handle,
  type NodeProps,
  Position,
  useConnection,
  useNodeConnections,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import {
  inputPortsOf,
  outputPortsOf,
  SUPPLY_OUT_PORT,
  SUPPLY_PORT_PREFIX,
  type SupplyPort,
} from "@zerodot/engine";
import { registry } from "@zerodot/nodes";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zerodot/ui";
import { createContext, useContext, useEffect, useState } from "react";
import {
  catalogByType,
  type NodeRunStatus,
  supplyPortX,
  uniqueName,
  type ZerodotFlowNode,
} from "../../lib/flow";
import { NodeIcon } from "../node-icon";

/** Run status for each node. Kept outside the node data so a run does not rewrite the graph. */
export const NodeStatusContext = createContext<Record<string, NodeRunStatus>>({});

/** Item count that flows out of each node, by edge id. Set after a node runs. */
export const EdgeCountContext = createContext<Record<string, number>>({});

/** Lets a node ask the editor to add a node after one of its output ports. */
export const EditorActionsContext = createContext<{
  /** Open the add sheet. The new node goes after this output port. */
  addAfter: (nodeId: string, port: string) => void;
  /** Open the add sheet with the supply nodes of this port's kind. */
  addSupply?: (nodeId: string, port: SupplyPort) => void;
  /** Open the add sheet. The new node goes in the middle of this edge. */
  insertOnEdge?: (edgeId: string) => void;
  /** Run this node alone, with the last known input. */
  executeNode?: (nodeId: string) => void;
  /** Open the node dialog. */
  openNode?: (nodeId: string) => void;
  /** A run view shows the graph and has no add buttons. */
  readOnly?: boolean;
}>({ addAfter: () => {} });

const BORDER: Record<NodeRunStatus, string> = {
  idle: "border-border",
  running: "border-amber-500",
  waiting: "border-sky-500",
  succeeded: "border-emerald-500",
  failed: "border-red-500",
  skipped: "border-dashed border-border opacity-60",
};

function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-5 place-items-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  );
}

export function ZerodotNode({ id, data, selected }: NodeProps<ZerodotFlowNode>) {
  const status = useContext(NodeStatusContext)[id] ?? "idle";
  const { addAfter, addSupply, executeNode, openNode, readOnly } = useContext(EditorActionsContext);
  const { deleteElements, getNodes, setNodes } = useReactFlow<ZerodotFlowNode>();
  const duplicate = () => {
    const all = getNodes();
    const source = all.find((n) => n.id === id);
    if (!source) return;
    const copyId = `n_${crypto.randomUUID().slice(0, 8)}`;
    const name = uniqueName(
      source.data.graphNode.name,
      all.map((n) => n.data.graphNode.name),
    );
    const position = { x: source.position.x + 40, y: source.position.y + 40 };
    const graphNode = structuredClone(source.data.graphNode);
    setNodes([
      ...all.map((n) => ({ ...n, selected: false })),
      {
        ...source,
        id: copyId,
        position,
        selected: true,
        data: { ...source.data, graphNode: { ...graphNode, id: copyId, name, position } },
      },
    ]);
  };
  // The first click on the trash icon asks. The second click deletes.
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => {
    if (!confirmDelete) return;
    const timer = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(timer);
  }, [confirmDelete]);
  const toggleDisabled = () =>
    setNodes((all) =>
      all.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                graphNode: { ...n.data.graphNode, disabled: !n.data.graphNode.disabled },
              },
            }
          : n,
      ),
    );
  const connections = useNodeConnections({ handleType: "source" });
  const incoming = useNodeConnections({ handleType: "target" });
  // The plus button turns into an arrow while the user drags a connection from it.
  const connection = useConnection();
  const draggingFrom =
    connection.inProgress && connection.fromNode.id === id ? connection.fromHandle.id : null;
  const isConnected = (port: string) => connections.some((c) => (c.sourceHandle ?? "out") === port);
  const { graphNode } = data;
  const entry = catalogByType.get(graphNode.type);
  const definition = registry.get(graphNode.type);
  const portSource = definition ?? entry;
  const isTrigger = entry?.category === "trigger";
  // A node on a tool port runs as a tool. It draws as a supply node, with no data ports.
  const asTool = connections.some((c) => c.sourceHandle === SUPPLY_OUT_PORT);
  const isSupply = entry?.supplies !== undefined || asTool;
  const outPorts = asTool ? [] : portSource ? outputPortsOf(portSource, graphNode.config) : ["out"];
  const inPorts = asTool
    ? []
    : portSource
      ? inputPortsOf(portSource, graphNode.config)
      : (entry?.ports.in ?? []);
  const supplyPorts = entry?.supplyPorts ?? [];
  const suppliedCount = (port: SupplyPort) =>
    incoming.filter((c) => c.targetHandle === `${SUPPLY_PORT_PREFIX}${port.name}`).length;
  const supplyLeftFor = (index: number) => `${supplyPortX(index, supplyPorts.length) * 100}%`;
  const subtitle = definition?.subtitle?.(graphNode.config);
  // A port with an edge swaps its plus-button handle for a handle on the node edge.
  // React Flow must measure the new handle, or the edge starts at the old spot.
  const updateNodeInternals = useUpdateNodeInternals();
  const connectedPorts = outPorts.filter(isConnected).join(",");
  const inPortsKey = inPorts.join(",");
  const supplyKey = supplyPorts.map((p) => p.name).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ports strings are the trigger.
  useEffect(
    () => updateNodeInternals(id),
    [id, connectedPorts, inPortsKey, supplyKey, updateNodeInternals],
  );
  const inTopFor = (index: number) => `${((index + 1) / (inPorts.length + 1)) * 100}%`;
  const topFor = (index: number) => `${((index + 1) / (outPorts.length + 1)) * 100}%`;

  return (
    <div className="group relative">
      {!readOnly && !isTrigger && (
        // The padding keeps the hover while the pointer moves from the node to the buttons.
        <div className="nodrag nopan absolute bottom-full left-1/2 flex -translate-x-1/2 gap-1 pb-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <ToolbarButton label="Execute step" onClick={() => executeNode?.(id)}>
            <HugeiconsIcon icon={PlayIcon} className="size-3" />
          </ToolbarButton>
          <ToolbarButton
            label={data.graphNode.disabled ? "Activate" : "Deactivate"}
            onClick={toggleDisabled}
          >
            <HugeiconsIcon icon={PowerServiceIcon} className="size-3" />
          </ToolbarButton>
          {confirmDelete ? (
            <button
              type="button"
              aria-label="Confirm delete"
              onClick={() => deleteElements({ nodes: [{ id }] })}
              onBlur={() => setConfirmDelete(false)}
              // biome-ignore lint/a11y/noAutofocus: the click that opened the confirm moves focus here.
              autoFocus
              className="h-5 rounded bg-destructive px-1.5 text-2xs font-medium text-white"
            >
              Delete?
            </button>
          ) : (
            <ToolbarButton label="Delete" onClick={() => setConfirmDelete(true)}>
              <HugeiconsIcon icon={Delete02Icon} className="size-3" />
            </ToolbarButton>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="More"
              title="More"
              className="grid size-5 place-items-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem onClick={() => openNode?.(id)}>
                <HugeiconsIcon icon={LinkSquare02Icon} />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => executeNode?.(id)}>
                <HugeiconsIcon icon={PlayIcon} />
                Execute step
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggleDisabled}>
                <HugeiconsIcon icon={PowerServiceIcon} />
                {data.graphNode.disabled ? "Activate" : "Deactivate"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={duplicate}>
                <HugeiconsIcon icon={Copy01Icon} />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => deleteElements({ nodes: [{ id }] })}
              >
                <HugeiconsIcon icon={Delete02Icon} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      <div
        className={cn(
          "relative grid min-h-16 w-16 place-items-center rounded-xl border-2 bg-card transition-[border-color,opacity] duration-150 ease-out",
          isTrigger && "rounded-l-[2rem]",
          isSupply && "rounded-full",
          BORDER[status],
          // Pinned data survives a reload, a run status does not. Keep the pinned look until a run sets one.
          graphNode.pinned && status === "idle" && "border-emerald-500",
          selected && "ring-2 ring-foreground/20",
          graphNode.disabled && "border-dashed opacity-50",
        )}
        style={{
          minHeight: `${Math.max(4, Math.max(outPorts.length, inPorts.length) * 1.5)}rem`,
          // Each supply port needs room for its label under the node.
          ...(supplyPorts.length > 0
            ? { width: `${Math.max(12, supplyPorts.length * 4.5)}rem` }
            : {}),
        }}
      >
        {isSupply && (
          <Handle
            type="source"
            position={Position.Top}
            id={SUPPLY_OUT_PORT}
            isConnectable={!readOnly}
            style={{ top: -1, transform: "translate(-50%, -50%) rotate(45deg)" }}
            className="size-3! rounded-none! border-2! border-card! bg-muted-foreground/70!"
          />
        )}
        {supplyPorts.map((port, index) => (
          <Handle
            key={port.name}
            type="target"
            position={Position.Bottom}
            id={`${SUPPLY_PORT_PREFIX}${port.name}`}
            isConnectable={!readOnly}
            // The rotation goes in `transform` after the centering translate. The Tailwind
            // `rotate` turns the box around its first place and moves it off the line. Bottom 0
            // is the inner edge of the 2px border, so -1px puts the center on the line.
            style={{
              left: supplyLeftFor(index),
              bottom: -1,
              transform: "translate(-50%, 50%) rotate(45deg)",
            }}
            className="size-3! rounded-none! border-2! border-card! bg-muted-foreground/70!"
          />
        ))}
        {graphNode.pinned && (
          <HugeiconsIcon
            icon={PinIcon}
            aria-label="Pinned data"
            className="absolute -top-2 -right-2 size-4 rounded-full bg-card p-0.5 text-emerald-600"
          />
        )}
        {isTrigger && (
          <HugeiconsIcon
            icon={FlashIcon}
            aria-hidden
            className="absolute top-1/2 -left-6 size-4 -translate-y-1/2 fill-amber-500 text-amber-500"
          />
        )}
        {inPorts.map((port, index) => (
          <Handle
            key={port}
            type="target"
            position={Position.Left}
            id={port}
            style={inPorts.length > 1 ? { top: inTopFor(index) } : undefined}
            className="z-10 size-3! rounded-full! border-2! border-card! bg-muted-foreground/70!"
          />
        ))}
        {supplyPorts.length > 0 ? (
          // The supply ports and their nodes are under the node, so the name goes inside it.
          <div className="flex w-full min-w-0 items-center gap-2 px-3">
            <NodeIcon
              name={entry?.icon ?? "CircleIcon"}
              src={entry?.iconUrl}
              variant="tile"
              category={entry?.category}
            />
            <div className="min-w-0 text-xs">
              <div className="line-clamp-2 font-semibold leading-tight">{graphNode.name}</div>
              {subtitle && (
                <div className="truncate text-[9px] text-muted-foreground/70">{subtitle}</div>
              )}
            </div>
          </div>
        ) : (
          <NodeIcon
            name={entry?.icon ?? "CircleIcon"}
            src={entry?.iconUrl}
            variant="tile"
            category={entry?.category}
          />
        )}
        {outPorts.map((port, index) =>
          // A port with no edge has its handle in the plus button.
          isConnected(port) ? (
            <Handle
              key={port}
              type="source"
              position={Position.Right}
              id={port}
              style={{ top: topFor(index) }}
              className="z-10 size-3! rounded-full! border-2! border-card! bg-muted-foreground/70!"
            />
          ) : null,
        )}
      </div>

      {outPorts.map((port, index) => {
        const connected = connections.some((c) => (c.sourceHandle ?? "out") === port);
        return (
          <div
            key={port}
            className="absolute left-full flex -translate-y-1/2 items-center"
            style={{ top: topFor(index) }}
          >
            {outPorts.length > 1 && (
              <span
                className={cn(
                  "pointer-events-none absolute left-2 text-2xs text-muted-foreground",
                  // The edge leaves on the line. The name sits above it.
                  connected && "bottom-1",
                )}
              >
                {port}
              </span>
            )}
            {!connected && (
              <div
                className={cn(
                  "group/stub flex items-center",
                  outPorts.length > 1 ? "ml-9" : "ml-1",
                )}
              >
                <span
                  aria-hidden
                  className="w-6 border-muted-foreground/40 border-t border-dashed transition-colors duration-150 group-hover/stub:border-foreground/50"
                />
                {/* A click on the button opens the sheet. A drag from it makes an edge. */}
                <button
                  type="button"
                  disabled={readOnly}
                  aria-label={`Add a node after ${graphNode.name}`}
                  className="nodrag nopan relative"
                  onClick={() => addAfter(id, port)}
                >
                  <div
                    aria-hidden
                    className={cn(
                      "grid size-5 place-items-center transition-colors duration-150",
                      "text-muted-foreground group-hover/stub:text-foreground",
                    )}
                  >
                    <HugeiconsIcon
                      icon={PlusSignIcon}
                      className={cn(
                        "size-3 transition-opacity",
                        draggingFrom === port && "opacity-0",
                      )}
                      strokeWidth={2.5}
                    />
                  </div>
                  <Handle
                    type="source"
                    position={Position.Right}
                    id={port}
                    isConnectable={!readOnly}
                    style={{
                      top: 0,
                      left: 0,
                      right: "auto",
                      bottom: "auto",
                      width: "100%",
                      height: "100%",
                      transform: "none",
                      opacity: 0,
                      border: 0,
                      borderRadius: 0,
                      cursor: readOnly ? "default" : "crosshair",
                    }}
                  />
                </button>
              </div>
            )}
          </div>
        );
      })}

      {supplyPorts.map((port, index) => {
        const count = suppliedCount(port);
        const canAdd = !readOnly && (port.multiple === true || count === 0);
        return (
          <div
            key={port.name}
            className="absolute top-full flex -translate-x-1/2 flex-col items-center pt-1.5"
            style={{ left: supplyLeftFor(index) }}
          >
            <span className="pointer-events-none whitespace-nowrap text-[9px] text-muted-foreground leading-tight">
              {port.label}
              {port.required && <span className="text-destructive">*</span>}
            </span>
            {canAdd && (
              <>
                <span
                  aria-hidden
                  className="mt-1 h-4 border-muted-foreground/40 border-l border-dashed"
                />
                <button
                  type="button"
                  aria-label={`Add ${port.label} to ${graphNode.name}`}
                  title={`Add ${port.label}`}
                  onClick={() => addSupply?.(id, port)}
                  className="nodrag nopan grid size-5 place-items-center text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  <HugeiconsIcon icon={PlusSignIcon} className="size-3" strokeWidth={2.5} />
                </button>
              </>
            )}
          </div>
        );
      })}

      <div
        className={cn(
          "pointer-events-none absolute top-full left-1/2 mt-1.5 w-40 -translate-x-1/2 text-center text-xs",
          // The supply port labels and buttons sit under the node. The name goes below them.
          supplyPorts.length > 0 && "mt-14",
        )}
      >
        {supplyPorts.length === 0 && (
          <div className="font-semibold leading-tight">{graphNode.name}</div>
        )}
        {supplyPorts.length === 0 && subtitle && (
          <div className="truncate text-[9px] font-normal text-muted-foreground/70">{subtitle}</div>
        )}
        {graphNode.notesInFlow && graphNode.notes && (
          <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap font-normal text-muted-foreground">
            {graphNode.notes}
          </div>
        )}
      </div>
    </div>
  );
}
