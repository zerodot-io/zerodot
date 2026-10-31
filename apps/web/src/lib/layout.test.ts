// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Edge } from "@xyflow/react";
import { catalog } from "@zerodot/nodes";
import { catalogByType, type ZerodotFlowNode } from "./flow";
import { arrangeNodes } from "./layout";

const base = catalog[0];
if (!base) throw new Error("empty catalog");
catalogByType.set("test.agent", {
  ...base,
  type: "test.agent",
  supplyPorts: [
    { name: "model", kind: "ai.model", label: "Chat Model", required: true },
    { name: "memory", kind: "ai.memory", label: "Memory" },
    { name: "tools", kind: "ai.tool", label: "Tool", multiple: true },
  ],
});
catalogByType.set("test.store-tool", {
  ...base,
  type: "test.store-tool",
  supplies: "ai.tool",
  supplyPorts: [{ name: "embedding", kind: "ai.embedding", label: "Embedding" }],
});
catalogByType.set("test.manager", {
  ...base,
  type: "test.manager",
  supplyPorts: [{ name: "memory", kind: "ai.memory", label: "Memory", required: true }],
});

const node = (id: string, type: string, x: number, y: number, size = 64): ZerodotFlowNode => ({
  id,
  type: "zerodot",
  position: { x, y },
  measured: { width: size, height: size },
  data: {
    graphNode: {
      id,
      type,
      name: id,
      position: { x, y },
      config: {},
      credentialId: null,
      pinned: null,
      onError: "fail",
    },
  },
});

const supply = (from: string, to: string, port: string): Edge => ({
  id: `${from}-${to}`,
  source: from,
  sourceHandle: "supply",
  target: to,
  targetHandle: `supply:${port}`,
});

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("arrangeNodes with supply nodes", () => {
  it("puts a shared supply node under one parent and the parents side by side", () => {
    const nodes = [
      node("agent", "test.agent", 0, 0, 96),
      node("manager", "test.manager", 0, 400, 96),
      node("model", "test.model", 0, 200),
      node("memory", "test.memory", 300, 600),
      node("crypto", "test.tool", 100, 200),
      node("http", "test.tool", 200, 200),
      node("sheets", "test.tool", 300, 200),
    ];
    const edges = [
      supply("model", "agent", "model"),
      supply("memory", "agent", "memory"),
      supply("crypto", "agent", "tools"),
      supply("http", "agent", "tools"),
      supply("sheets", "agent", "tools"),
      supply("memory", "manager", "memory"),
    ];
    const placed = new Map(arrangeNodes(nodes, edges).map((n) => [n.id, n]));
    const box = (id: string): Box => {
      const n = placed.get(id);
      if (!n) throw new Error(id);
      return { ...n.position, w: n.measured?.width ?? 0, h: n.measured?.height ?? 0 };
    };
    const agent = box("agent");
    const manager = box("manager");
    const memory = box("memory");

    // The parents stand in one band, the manager right of the whole agent block.
    assert.equal(manager.y, agent.y);
    const row = ["model", "memory", "crypto", "http", "sheets"].map(box);
    for (const item of row) {
      assert.ok(item.x + item.w < manager.x, "the agent row is left of the manager");
      assert.ok(item.y > agent.y + agent.h, "the row is under the agent");
    }
    // The memory node is in the agent row, in port order: model, memory, then the tools.
    assert.equal(memory.y, box("model").y);
    const xs = row.map((item) => item.x);
    assert.deepEqual(
      xs,
      [...xs].sort((a, b) => a - b),
    );
    // No two nodes overlap.
    const all = [...placed.keys()].map(box);
    for (const [i, a] of all.entries()) {
      for (const b of all.slice(i + 1)) assert.ok(!overlaps(a, b));
    }
  });

  it("puts the supply nodes of a supply node in a row under it", () => {
    const nodes = [
      node("agent", "test.agent", 0, 0, 96),
      node("model", "test.model", 500, 500),
      node("store", "test.store-tool", 300, 300),
      node("embedding", "test.embedding", 900, 900),
    ];
    const edges = [
      supply("model", "agent", "model"),
      supply("store", "agent", "tools"),
      supply("embedding", "store", "embedding"),
    ];
    const placed = new Map(arrangeNodes(nodes, edges).map((n) => [n.id, n]));
    const at = (id: string) => {
      const n = placed.get(id);
      if (!n) throw new Error(id);
      return n.position;
    };
    assert.equal(at("store").y, at("model").y);
    assert.ok(at("embedding").y > at("store").y + 64, "the embedding is under the store");
    // The embedding is under the one port of the store: the middle of it.
    assert.equal(at("embedding").x + 32, at("store").x + 32);
    assert.ok(at("model").x + 64 < at("store").x, "the model is left of the store");
  });
});
