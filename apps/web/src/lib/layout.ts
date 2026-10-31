// SPDX-License-Identifier: AGPL-3.0-only
import type { Edge } from "@xyflow/react";
import { type SupplyPort, supplyPortsOf } from "@zerodot/engine";
import { catalogByType, isSupplyFlowEdge, supplyPortX, type ZerodotFlowNode } from "./flow";

const COLUMN_GAP = 120;
const ROW_GAP = 48;
const COMPONENT_GAP = 96;
/** Extra room right of a node with named ports: the port names and the plus stubs. */
const PORT_OVERHANG = 96;
/** Extra room left of a node with a loop back to itself: the line goes around its name. */
const LOOP_OVERHANG = 64;
/** Space between the bottom of a node and its supply nodes: the port labels and plus buttons. */
const SUPPLY_DROP = 100;
/** Space between two supply nodes in a row. A supply node is 64px wide and its label 112px, so labels do not touch. */
export const SUPPLY_GAP = 64;
const FALLBACK_WIDTH = 240;
const FALLBACK_HEIGHT = 80;

/**
 * Places nodes in left-to-right columns by depth. Parts that are not linked stack top to bottom.
 * Supply nodes go in a row under their parent, each one under its supply port.
 */
/** The supply ports that a node shows with its config. */
function portsOf(n: ZerodotFlowNode): SupplyPort[] {
  const entry = catalogByType.get(n.data.graphNode.type);
  return entry ? supplyPortsOf(entry, n.data.graphNode.config) : [];
}

export function arrangeNodes(nodes: ZerodotFlowNode[], edges: Edge[]): ZerodotFlowNode[] {
  const allIds = new Set(nodes.map((n) => n.id));
  const supplyEdges = edges.filter(
    (e) => isSupplyFlowEdge(e) && allIds.has(e.source) && allIds.has(e.target),
  );
  const flowEdges = edges.filter((e) => !isSupplyFlowEdge(e));
  const baseSize = (n: ZerodotFlowNode) => ({
    w: n.measured?.width ?? FALLBACK_WIDTH,
    h: n.measured?.height ?? FALLBACK_HEIGHT,
  });

  // The step nodes. A node that gives a supply is not one: it goes in the row of a parent.
  const supplied = new Set(supplyEdges.map((e) => e.source));
  const layoutNodes = nodes.filter((n) => !supplied.has(n.id));
  const ids = new Set(layoutNodes.map((n) => n.id));
  const links = flowEdges.filter(
    (e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target,
  );
  const namedPorts = new Set(
    flowEdges.filter((e) => e.sourceHandle && e.sourceHandle !== "out").map((e) => e.source),
  );
  const looping = new Set(flowEdges.filter((e) => e.source === e.target).map((e) => e.source));

  // Group linked nodes.
  const parent = new Map<string, string>(layoutNodes.map((n) => [n.id, n.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    parent.set(id, root);
    return root;
  };
  for (const e of links) parent.set(find(e.source), find(e.target));
  const groups = new Map<string, ZerodotFlowNode[]>();
  for (const n of layoutNodes) {
    const root = find(n.id);
    groups.set(root, [...(groups.get(root) ?? []), n]);
  }

  // Groups that share a supply node stand side by side in one band, so the supply edges stay short.
  const parentsOf = new Map<string, string[]>();
  for (const e of supplyEdges) {
    if (!ids.has(e.target)) continue;
    parentsOf.set(e.source, [...new Set([...(parentsOf.get(e.source) ?? []), e.target])]);
  }
  const band = new Map<string, string>([...groups.keys()].map((g) => [g, g]));
  const findBand = (id: string): string => {
    let root = id;
    while (band.get(root) !== root) root = band.get(root) ?? root;
    band.set(id, root);
    return root;
  };
  for (const parents of parentsOf.values()) {
    const [first, ...rest] = parents.map(find);
    for (const g of rest) if (first !== undefined) band.set(findBand(g), findBand(first));
  }
  const minOf = (group: ZerodotFlowNode[], axis: "x" | "y") =>
    Math.min(...group.map((n) => n.position[axis]));
  const bands = new Map<string, ZerodotFlowNode[][]>();
  for (const [root, group] of groups) {
    const b = findBand(root);
    bands.set(b, [...(bands.get(b) ?? []), group]);
  }
  // Bands go top to bottom, and the groups of a band left to right, as they are now.
  const orderedBands = [...bands.values()]
    .map((list) => list.sort((a, b) => minOf(a, "x") - minOf(b, "x")))
    .sort(
      (a, b) => Math.min(...a.map((g) => minOf(g, "y"))) - Math.min(...b.map((g) => minOf(g, "y"))),
    );
  const groupOrder = new Map<string, number>();
  for (const group of orderedBands.flat()) {
    const first = group[0];
    if (first) groupOrder.set(find(first.id), groupOrder.size);
  }

  // A supply node with more than one parent goes in the row of one parent only: the first group,
  // then the leftmost parent. The edges of the other parents go to it there.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const owner = new Map<string, string>();
  for (const [supplyId, parents] of parentsOf) {
    const [first] = [...parents].sort(
      (a, b) =>
        (groupOrder.get(find(a)) ?? 0) - (groupOrder.get(find(b)) ?? 0) ||
        (byId.get(a)?.position.x ?? 0) - (byId.get(b)?.position.x ?? 0),
    );
    if (first !== undefined) owner.set(supplyId, first);
  }
  // A supply node can have supply ports too. Its own supply nodes go in a row under it. A loop of
  // supply edges gets no owner, so the rows stay a tree.
  const ownedBy = (id: string, ancestor: string): boolean => {
    for (let at: string | undefined = id, n = 0; at !== undefined && n < nodes.length; n++) {
      if (at === ancestor) return true;
      at = owner.get(at);
    }
    return false;
  };
  for (const e of [...supplyEdges].sort(
    (a, b) => (byId.get(a.target)?.position.x ?? 0) - (byId.get(b.target)?.position.x ?? 0),
  )) {
    if (ids.has(e.target) || owner.has(e.source) || ownedBy(e.target, e.source)) continue;
    owner.set(e.source, e.target);
  }

  // The supply nodes of each parent, in port order, then left to right as they are now.
  const rows = new Map<string, { n: ZerodotFlowNode; port: number }[]>();
  for (const parentNode of nodes) {
    const ports = portsOf(parentNode);
    const row = supplyEdges
      .filter((e) => e.target === parentNode.id && owner.get(e.source) === parentNode.id)
      .flatMap((e) => {
        const n = byId.get(e.source);
        const port = ports.findIndex((p) => `supply:${p.name}` === e.targetHandle);
        return n ? [{ n, port: Math.max(0, port) }] : [];
      })
      .sort((a, b) => a.port - b.port || a.n.position.x - b.n.position.x);
    if (row.length > 0) rows.set(parentNode.id, row);
  }
  const rowWidth = (row: { n: ZerodotFlowNode }[]): number =>
    row.reduce((sum, { n }) => sum + size(n).w, 0) + SUPPLY_GAP * (row.length - 1);

  // The layout sees a parent with its rows of supply nodes, down to the last level, as one block.
  const sizes = new Map<string, { w: number; h: number }>();
  const size = (n: ZerodotFlowNode): { w: number; h: number } => {
    const known = sizes.get(n.id);
    if (known) return known;
    const own = baseSize(n);
    const row = rows.get(n.id);
    const block = row
      ? {
          w: Math.max(own.w, rowWidth(row)),
          h: own.h + SUPPLY_DROP + Math.max(...row.map(({ n: m }) => size(m).h)),
        }
      : own;
    sizes.set(n.id, block);
    return block;
  };

  const next = new Map<string, { x: number; y: number }>();
  let top = 0;

  for (const bandGroups of orderedBands) {
    let left = 0;
    let bandHeight = 0;
    for (const group of bandGroups) {
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
        for (const { n, y } of col) {
          // A node with a wide row of supply nodes sits in the middle of its block.
          next.set(n.id, { x: left + (size(n).w - baseSize(n).w) / 2, y: top + offset + y });
        }
        const stubs = col.some(({ n }) => namedPorts.has(n.id)) ? PORT_OVERHANG : 0;
        const loops = placed[index + 1]?.some(({ n }) => looping.has(n.id)) ? LOOP_OVERHANG : 0;
        left += colWidth + COLUMN_GAP + stubs + loops;
      }
      bandHeight = Math.max(bandHeight, groupHeight);
    }
    top += bandHeight + COMPONENT_GAP;
  }

  // Each group of a port is centered under its diamond. A group that would overlap the group
  // before it moves right. Then the whole row is centered under the parent. A supply node in the
  // row places its own row next, under it.
  const placeRow = (parentId: string) => {
    const row = rows.get(parentId);
    const parentNode = byId.get(parentId);
    const at = next.get(parentId) ?? parentNode?.position;
    if (!row || !parentNode || !at) return;
    const { w, h } = baseSize(parentNode);
    const portCount = portsOf(parentNode).length || 1;
    const xs: number[] = [];
    let end = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < row.length; ) {
      const port = row[i]?.port ?? 0;
      const group = row.filter((item) => item.port === port);
      const width = rowWidth(group);
      const center = at.x + w * supplyPortX(port, portCount);
      let x = Math.max(center - width / 2, end + SUPPLY_GAP);
      for (const { n } of group) {
        xs.push(x);
        x += size(n).w + SUPPLY_GAP;
      }
      end = x - SUPPLY_GAP;
      i += group.length;
    }
    const first = xs[0] ?? at.x;
    const shift = Math.min(0, at.x + w / 2 - (first + end) / 2);
    const y = at.y + h + SUPPLY_DROP;
    row.forEach(({ n }, index) => {
      // The node sits in the middle of its block, over its own row.
      const left = (xs[index] ?? at.x) + shift;
      next.set(n.id, { x: left + (size(n).w - baseSize(n).w) / 2, y });
    });
    for (const { n } of row) placeRow(n.id);
  };
  for (const n of layoutNodes) placeRow(n.id);

  return nodes.map((n) => ({ ...n, position: next.get(n.id) ?? n.position }));
}
