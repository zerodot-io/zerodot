// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeGraph } from "./execute";
import { graphSchema } from "./graph";
import { createRegistry, defineNode } from "./node";

const seen: unknown[] = [];
const trigger = defineNode({
  type: "trigger.manual",
  label: "t",
  category: "trigger",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});
const probe = defineNode({
  type: "x.probe",
  label: "p",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: ({ input }) => {
    seen.push(input);
    return { port: "out", data: [] };
  },
});
const sink = defineNode({
  type: "x.sink",
  label: "k",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: ({ input }) => {
    seen.push(input);
    return { port: "out", data: input };
  },
});
const registry = createRegistry([trigger, probe, sink]);

async function run(probeSettings: Record<string, unknown>, triggerInput: unknown) {
  seen.length = 0;
  const base = { position: { x: 0, y: 0 }, config: {} };
  const graph = graphSchema.parse({
    schema: 1,
    nodes: [
      { ...base, id: "t", type: "trigger.manual", name: "t" },
      { ...base, id: "p", type: "x.probe", name: "p", ...probeSettings },
      { ...base, id: "k", type: "x.sink", name: "k" },
    ],
    edges: [
      { id: "e1", from: "t", fromPort: "out", to: "p", toPort: "in" },
      { id: "e2", from: "p", fromPort: "out", to: "k", toPort: "in" },
    ],
  });
  return executeGraph({
    graph,
    registry,
    signal: new AbortController().signal,
    triggerInput,
    mode: "production",
  });
}

describe("node settings", () => {
  it("executeOnce gives the node the first item only", async () => {
    await run({ executeOnce: true }, [1, 2, 3]);
    assert.deepEqual(seen[0], [1]);
  });

  it("a node runs on the full list by default", async () => {
    await run({}, [1, 2, 3]);
    assert.deepEqual(seen[0], [1, 2, 3]);
  });

  it("alwaysOutputData turns an empty list into an empty object", async () => {
    await run({ alwaysOutputData: true }, "x");
    assert.deepEqual(seen[1], {});
  });

  it("an empty list stays empty by default", async () => {
    await run({}, "x");
    assert.deepEqual(seen[1], []);
  });
});
