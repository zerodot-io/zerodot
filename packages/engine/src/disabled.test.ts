// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeGraph } from "./execute";
import { graphSchema } from "./graph";
import { createRegistry, defineNode } from "./node";

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
const ran: string[] = [];
const step = defineNode({
  type: "x.step",
  label: "s",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: () => {
    ran.push("step");
    return { port: "out", data: "changed" };
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
    ran.push(`sink:${String(input)}`);
    return { port: "out", data: input };
  },
});
const registry = createRegistry([trigger, step, sink]);

describe("disabled node", () => {
  it("passes input through without running", async () => {
    ran.length = 0;
    const base = { position: { x: 0, y: 0 }, config: {} };
    const graph = graphSchema.parse({
      schema: 1,
      nodes: [
        { ...base, id: "t", type: "trigger.manual", name: "t" },
        { ...base, id: "s", type: "x.step", name: "s", disabled: true },
        { ...base, id: "k", type: "x.sink", name: "k" },
      ],
      edges: [
        { id: "e1", from: "t", fromPort: "out", to: "s", toPort: "in" },
        { id: "e2", from: "s", fromPort: "out", to: "k", toPort: "in" },
      ],
    });
    const result = await executeGraph({
      graph,
      registry,
      signal: new AbortController().signal,
      triggerInput: "raw",
      mode: "production",
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["sink:raw"]);
  });
});
