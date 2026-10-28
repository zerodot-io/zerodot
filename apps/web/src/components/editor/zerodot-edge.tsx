// SPDX-License-Identifier: AGPL-3.0-only
import {
  BaseEdge,
  type ConnectionLineComponentProps,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Position,
  useEdges,
  useInternalNode,
  useReactFlow,
} from "@xyflow/react";
import { Plus, X } from "lucide-react";
import { useContext, useRef, useState } from "react";
import { EdgeCountContext, EditorActionsContext, NodeStatusContext } from "./zerodot-node";

/** A light line by default. It turns dark when the pointer is on it, or when it is selected. */
export const EDGE_COLOR = "color-mix(in oklab, var(--color-muted-foreground) 28%, transparent)";
const EDGE_COLOR_ACTIVE = "color-mix(in oklab, var(--color-muted-foreground) 75%, transparent)";

const BACK_GAP = 28;
/** Half the width of the name and subtitle block under a node (w-40 in the node). */
const NAME_HALF_WIDTH = 80;
/** Space under the lowest node for its name and subtitle, so the line passes below them. */
const BACK_CLEARANCE = 64;
const BACK_RADIUS = 12;
/** The space between two back edges that leave one node, so their lines do not lie on each other. */
const BACK_LANE = 14;

/**
 * The path of an edge that goes back (the target is left of the source, as in a loop, or the node
 * itself): out of the source, down below both nodes, back to the left, and up into the target.
 */
function backPath(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  outerX: number,
  outerLeftX: number,
  nodesBottom: number,
  lane: number,
): [string, number, number] {
  const r = BACK_RADIUS;
  const x1 = Math.max(sx, outerX) + BACK_GAP + lane * BACK_LANE;
  const x2 = Math.min(tx, outerLeftX) - BACK_GAP - lane * BACK_LANE;
  const bottom = nodesBottom + BACK_CLEARANCE + lane * BACK_LANE;
  const path = [
    `M ${sx} ${sy}`,
    `H ${x1 - r}`,
    `Q ${x1} ${sy} ${x1} ${sy + r}`,
    `V ${bottom - r}`,
    `Q ${x1} ${bottom} ${x1 - r} ${bottom}`,
    `H ${x2 + r}`,
    `Q ${x2} ${bottom} ${x2} ${bottom - r}`,
    `V ${ty + r}`,
    `Q ${x2} ${ty} ${x2 + r} ${ty}`,
    `H ${tx}`,
  ].join(" ");
  return [path, (sx + tx) / 2, bottom];
}

/** The line while the user drags a connection: a curve like a real edge, with an arrow tip at the pointer. */
export function ZerodotConnectionLine({ fromX, fromY, toX, toY }: ConnectionLineComponentProps) {
  const [path] = getBezierPath({
    sourceX: fromX,
    sourceY: fromY,
    sourcePosition: Position.Right,
    targetX: toX,
    targetY: toY,
    targetPosition: Position.Left,
  });
  return (
    <g stroke="var(--color-primary)" strokeWidth={2} strokeLinecap="round" fill="none">
      <path d={path} />
      <path
        d="M -8 -6 L 0 0 L -8 6"
        strokeLinejoin="round"
        transform={`translate(${toX} ${toY})`}
      />
    </g>
  );
}

/** An edge with buttons that remove it or add a node in it. They show while the pointer is on the edge. */
export function ZerodotEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  sourceHandleId,
  style,
  markerEnd,
  selected,
}: EdgeProps) {
  const { deleteElements } = useReactFlow();
  const { insertOnEdge, readOnly } = useContext(EditorActionsContext);
  const count = useContext(EdgeCountContext)[id];
  const statuses = useContext(NodeStatusContext);
  // The edge ran when it carried items, or when its source succeeded and the target started.
  const targetStatus = statuses[target];
  const ran =
    count !== undefined ||
    (statuses[source] === "succeeded" &&
      targetStatus !== undefined &&
      targetStatus !== "skipped" &&
      targetStatus !== "idle");
  const [hovered, setHovered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  // A back edge goes around the source ports (the labels and plus stubs) and under both nodes.
  const sourceOrigin = sourceNode?.internals.positionAbsolute;
  const outerX = sourceOrigin
    ? Math.max(
        sourceX,
        sourceOrigin.x + (sourceNode.measured.width ?? 0) / 2 + NAME_HALF_WIDTH,
        ...(sourceNode.internals.handleBounds?.source ?? []).map(
          (handle) => sourceOrigin.x + handle.x + handle.width,
        ),
      )
    : sourceX;
  // The name block can be wider than the node. The line goes around it on both sides.
  const targetOrigin = targetNode?.internals.positionAbsolute;
  const outerLeftX =
    targetOrigin && targetNode
      ? targetOrigin.x + (targetNode.measured.width ?? 0) / 2 - NAME_HALF_WIDTH
      : targetX;
  const nodesBottom = Math.max(
    sourceY,
    targetY,
    ...[sourceNode, targetNode].map((node) =>
      node ? node.internals.positionAbsolute.y + (node.measured.height ?? 0) : 0,
    ),
  );
  // Back edges from one node nest: the edge from the lowest port is the inner one.
  const edges = useEdges();
  const { getInternalNode } = useReactFlow();
  const portY = (nodeId: string, handleId: string | null | undefined) => {
    const node = getInternalNode(nodeId);
    const handle = node?.internals.handleBounds?.source?.find(
      (h) => (h.id ?? null) === (handleId ?? null),
    );
    return node && handle ? node.internals.positionAbsolute.y + handle.y + handle.height / 2 : 0;
  };
  const ownPortY = portY(source, sourceHandleId);
  const lane = edges.filter((other) => {
    if (other.id === id || other.source !== source) return false;
    const otherTarget = getInternalNode(other.target);
    if (!sourceOrigin || !otherTarget || otherTarget.internals.positionAbsolute.x > sourceOrigin.x)
      return false;
    const otherY = portY(source, other.sourceHandle);
    return otherY > ownPortY || (otherY === ownPortY && other.id > id);
  }).length;
  const [path, labelX, labelY] =
    targetX < sourceX
      ? backPath(sourceX, sourceY, targetX, targetY, outerX, outerLeftX, nodesBottom, lane)
      : getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });

  // The pointer moves from the line to the button. A short delay stops the button from blinking.
  const enter = () => {
    clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const leave = () => {
    leaveTimer.current = setTimeout(() => setHovered(false), 120);
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          ...style,
          stroke:
            hovered || selected ? EDGE_COLOR_ACTIVE : ran ? "var(--color-emerald-500)" : EDGE_COLOR,
          strokeWidth: hovered || selected ? 1.5 : 1.25,
          transition: "stroke 150ms, stroke-width 150ms",
        }}
        markerEnd={markerEnd}
      />
      {/* A wide invisible line, so the edge is easy to hover. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a hover target. The button does the work. */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={24}
        onMouseEnter={enter}
        onMouseLeave={leave}
      />
      <EdgeLabelRenderer>
        {count !== undefined && (
          <span
            style={{
              transform: `translate(-50%, -100%) translate(${(sourceX + labelX) / 2}px, ${sourceY - 6}px)`,
            }}
            className="nodrag nopan pointer-events-none absolute text-muted-foreground text-xs"
          >
            {count} {count === 1 ? "item" : "items"}
          </span>
        )}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: hover only, the buttons inside take focus */}
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className={`nodrag nopan absolute flex gap-1 transition-opacity duration-150 ${
            hovered || selected
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          {insertOnEdge && !readOnly && (
            <button
              type="button"
              aria-label="Add node"
              onClick={() => insertOnEdge(id)}
              className="grid size-5 place-items-center rounded-full border bg-card text-muted-foreground shadow-xs transition-colors hover:text-foreground"
            >
              <Plus className="size-3" strokeWidth={2.5} />
            </button>
          )}
          <button
            type="button"
            aria-label="Remove connection"
            onClick={() => void deleteElements({ edges: [{ id }] })}
            className="grid size-5 place-items-center rounded-full border bg-card text-muted-foreground shadow-xs transition-colors hover:text-destructive"
          >
            <X className="size-3" strokeWidth={2.5} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
