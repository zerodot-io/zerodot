// SPDX-License-Identifier: AGPL-3.0-only
import type { Edge } from "@xyflow/react";
import type { ZerodotFlowNode } from "./flow";

const COLUMN_GAP = 120;
const ROW_GAP = 48;
const COMPONENT_GAP = 96;
/** Extra room right of a node with named ports: the port names and the plus stubs. */
const PORT_OVERHANG = 96;
/** Extra room left of a node with a loop back to itself: the line goes around its name. */
const LOOP_OVERHANG = 64;
const FALLBACK_WIDTH = 240;
const FALLBACK_HEIGHT = 80;

/** Places nodes in left-to-right columns by depth. Parts that are not linked stack top to bottom. */
export function arrangeNodes(nodes: ZerodotFlowNode[], edges: Edge[]): ZerodotFlowNode[] {
  const ids = new Set(nodes.map((n) => n.id));
  const links = edges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );
  const namedPorts = new Set(
    edges.filter((e) => e.sourceHandle && e.sourceHandle !== "out").map((e) => e.source),
  );
  const looping = new Set(edges.filter((e) => e.source === e.target).map((e) => e.source));
  const size = (n: ZerodotFlowNode) => ({
    w: n.measured?.width ?? FALLBACK_WIDTH,
    h: n.measured?.height ?? FALLBACK_HEIGHT,
  });

  // Group linked nodes.
  const parent = new Map<string, string>(nodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  for (const e of links) parent.set(find(e.source), find(e.target));
  const groups = new Map<string, ZerodotFlowNode[]>();
  for (const n of nodes) {
    const root = find(n.id);
    groups.set(root, [...(groups.get(root) ?? []), n]);
  }

  const next = new Map<string, { x: number; y: number }>();
  let top = 0;
  const ordered = [...groups.values()].sort(
    (a, b) => Math.min(...a.map((n) => n.position.y)) - Math.min(...b.map((n) => n.position.y)),
  );

  for (const group of ordered) {
    const inGroup = new Set(group.map((n) => n.id));
    const own = links.filter((e) => inGroup.has(e.source));

    // Depth is the longest path from a start. The pass limit stops loops.
    const depth = new Map<string, number>(group.map((n) => [n.id, 0]));
    for (let pass = 0; pass < group.length; pass++) {
      let changed = false;
      for (const e of own) {
        const d = (depth.get(e.source) ?? 0) + 1;
        if (d > (depth.get(e.target) ?? 0) && d < group.length) {
          depth.set(e.target, d);
          changed = true;
        }
      }
      if (!changed) break;
    }

    const columns: ZerodotFlowNode[][] = [];
    for (const n of group) {
      const d = depth.get(n.id) ?? 0;
      columns[d] = [...(columns[d] ?? []), n];
    }

    // Order each column by the height of its parents, so lines cross less.
    const centerY = new Map<string, number>();
    let left = 0;
    let groupHeight = 0;
    const placed: { n: ZerodotFlowNode; y: number }[][] = [];
    for (const column of columns) {
      if (!column) continue;
      const score = (n: ZerodotFlowNode) => {
        const above = own.filter((e) => e.target === n.id && centerY.has(e.source));
        if (above.length === 0) return n.position.y;
        return above.reduce((sum, e) => sum + (centerY.get(e.source) ?? 0), 0) / above.length;
      };
      const sorted = [...column].sort((a, b) => score(a) - score(b));
      let y = 0;
      const col: { n: ZerodotFlowNode; y: number }[] = [];
      for (const n of sorted) {
        col.push({ n, y });
        centerY.set(n.id, y + size(n).h / 2);
        y += size(n).h + ROW_GAP;
      }
      groupHeight = Math.max(groupHeight, y - ROW_GAP);
      placed.push(col);
    }

    for (const [index, col] of placed.entries()) {
      const colHeight = col.length
        ? (col.at(-1)?.y ?? 0) + size(col.at(-1)?.n as ZerodotFlowNode).h
        : 0;
      const offset = (groupHeight - colHeight) / 2;
      const colWidth = Math.max(...col.map(({ n }) => size(n).w));
      for (const { n, y } of col) next.set(n.id, { x: left, y: top + offset + y });
      const stubs = col.some(({ n }) => namedPorts.has(n.id)) ? PORT_OVERHANG : 0;
      const loops = placed[index + 1]?.some(({ n }) => looping.has(n.id)) ? LOOP_OVERHANG : 0;
      left += colWidth + COLUMN_GAP + stubs + loops;
    }
    top += groupHeight + COMPONENT_GAP;
  }

  return nodes.map((n) => ({ ...n, position: next.get(n.id) ?? n.position }));
}
