// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { type ExecuteTarget, executeGraph } from "./execute";
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
const iff = defineNode({
  type: "logic.if",
  label: "if",
  category: "logic",
  icon: "x",
  config: z.object({ yes: z.boolean() }),
  defaultConfig: { yes: true },
  ports: { in: ["in"], out: ["true", "false"] },
  run: ({ config, input }) => ({ port: config.yes ? "true" : "false", data: input }),
});
const seen: unknown[] = [];
const join = defineNode({
  type: "x.join",
  label: "j",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  join: true,
  ports: { in: ["a", "b"], out: ["out"] },
  run: ({ input }) => {
    seen.push(input);
    return { port: "out", data: input };
  },
});
const seenN: unknown[] = [];
/** A join with as many inputs as `inputs` says, like the Merge node. */
const joinN = defineNode({
  type: "x.joinN",
  label: "jn",
  category: "data",
  icon: "x",
  config: z.object({ inputs: z.number() }),
  defaultConfig: { inputs: 2 },
  join: true,
  ports: { in: ["i1", "i2"], out: ["out"] },
  inPorts: (config) => Array.from({ length: Number(config.inputs) }, (_, i) => `i${i + 1}`),
  run: ({ input }) => {
    seenN.push(input);
    return { port: "out", data: input };
  },
});
const registry = createRegistry([trigger, iff, join, joinN]);

const node = (id: string, type: string, config = {}) => ({
  id,
  type,
  name: id,
  position: { x: 0, y: 0 },
  config,
});
const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  id: `${from}-${fromPort}-${to}-${toPort}`,
  from,
  fromPort,
  to,
  toPort,
});

describe("join node", () => {
  it("runs once, after both parents", async () => {
    seen.length = 0;
    const graph = graphSchema.parse({
      schema: 1,
      nodes: [node("t", "trigger.manual"), node("j", "x.join")],
      edges: [edge("t", "out", "j", "a"), edge("t", "out", "j", "b")],
    });
    const result = await executeGraph({
      graph,
      registry,
      signal: new AbortController().signal,
      triggerInput: 1,
      mode: "production",
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(seen, [{ a: 1, b: 1 }]);
  });

  it("runs with one input when the other branch is skipped", async () => {
    seen.length = 0;
    const graph = graphSchema.parse({
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("i", "logic.if", { yes: true }),
        node("j", "x.join"),
      ],
      edges: [
        edge("t", "out", "i", "in"),
        edge("i", "true", "j", "a"),
        edge("i", "false", "j", "b"),
      ],
    });
    await executeGraph({
      graph,
      registry,
      signal: new AbortController().signal,
      triggerInput: 2,
      mode: "production",
    });
    assert.deepEqual(seen, [{ a: 2 }]);
  });
});

describe("join node with inputs from its config", () => {
  const run = async (graph: unknown, triggerInput: unknown = 1) => {
    seenN.length = 0;
    const result = await executeGraph({
      graph: graphSchema.parse(graph),
      registry,
      signal: new AbortController().signal,
      triggerInput,
      mode: "production",
    });
    return result.status;
  };

  for (const n of [2, 3, 5, 10]) {
    it(`waits for ${n} parents`, async () => {
      const parents = Array.from({ length: n }, (_, i) =>
        node(`p${i + 1}`, "logic.if", { yes: true }),
      );
      const status = await run({
        schema: 1,
        nodes: [node("t", "trigger.manual"), ...parents, node("j", "x.joinN", { inputs: n })],
        edges: [
          ...parents.map((p) => edge("t", "out", p.id, "in")),
          ...parents.map((p, i) => edge(p.id, "true", "j", `i${i + 1}`)),
        ],
      });
      assert.equal(status, "succeeded");
      assert.equal(seenN.length, 1);
      assert.deepEqual(
        Object.keys(seenN[0] as object),
        Array.from({ length: n }, (_, i) => `i${i + 1}`),
      );
    });
  }

  it("runs when some of the branches are skipped", async () => {
    const status = await run({
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("a", "logic.if", { yes: true }),
        node("b", "logic.if", { yes: false }),
        node("c", "logic.if", { yes: true }),
        node("j", "x.joinN", { inputs: 4 }),
      ],
      edges: [
        edge("t", "out", "a", "in"),
        edge("t", "out", "b", "in"),
        edge("t", "out", "c", "in"),
        edge("a", "true", "j", "i1"),
        edge("b", "true", "j", "i2"),
        edge("c", "true", "j", "i4"),
      ],
    });
    assert.equal(status, "succeeded");
    assert.deepEqual(seenN, [{ i1: 1, i4: 1 }]);
  });

  it("runs once when an input has no edge", async () => {
    await run({
      schema: 1,
      nodes: [node("t", "trigger.manual"), node("j", "x.joinN", { inputs: 5 })],
      edges: [edge("t", "out", "j", "i3")],
    });
    assert.deepEqual(seenN, [{ i3: 1 }]);
  });

  it("does not run when every parent is skipped", async () => {
    await run({
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("a", "logic.if", { yes: false }),
        node("j", "x.joinN", { inputs: 3 }),
      ],
      edges: [edge("t", "out", "a", "in"), edge("a", "true", "j", "i2")],
    });
    assert.deepEqual(seenN, []);
  });

  it("ignores an edge into an input that the config no longer has", async () => {
    const status = await run({
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("a", "logic.if", { yes: true }),
        node("j", "x.joinN", { inputs: 2 }),
      ],
      edges: [
        edge("t", "out", "j", "i1"),
        edge("t", "out", "a", "in"),
        edge("a", "true", "j", "i3"),
      ],
    });
    assert.equal(status, "succeeded");
    assert.deepEqual(seenN, [{ i1: 1 }]);
  });

  it("runs once when two exclusive branches feed one input", async () => {
    await run({
      schema: 1,
      nodes: [
        node("t", "trigger.manual"),
        node("i", "logic.if", { yes: false }),
        node("j", "x.joinN", { inputs: 3 }),
      ],
      edges: [
        edge("t", "out", "i", "in"),
        edge("i", "true", "j", "i1"),
        edge("i", "false", "j", "i1"),
      ],
    });
    assert.deepEqual(seenN, [{ i1: 1 }]);
  });
});

const rec = defineNode({
  type: "x.rec",
  label: "r",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});
const failing = defineNode({
  type: "x.fail",
  label: "f",
  category: "data",
  icon: "x",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: () => {
    throw new Error("boom");
  },
});
const recRegistry = createRegistry([trigger, iff, join, rec, failing]);

async function runGraph(
  nodes: Record<string, unknown>[],
  edges: ReturnType<typeof edge>[],
  options: { target?: ExecuteTarget; maxNodeRuns?: number } = {},
) {
  const ran: string[] = [];
  const skipped: string[] = [];
  const result = await executeGraph({
    graph: graphSchema.parse({ schema: 1, nodes, edges }),
    registry: recRegistry,
    signal: new AbortController().signal,
    triggerInput: 7,
    mode: "production",
    ...options,
    hooks: [
      {
        afterNode: ({ node: n, status }) => {
          if (status === "skipped") skipped.push(n.id);
          else if (status === "succeeded") ran.push(n.id);
        },
      },
    ],
  });
  return { result, ran, skipped };
}

describe("parallel branches", () => {
  it("fans out one port to several nodes in edge order, one after the other", async () => {
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("a", "x.rec"), node("b", "x.rec"), node("c", "x.rec")],
      [edge("t", "out", "a", "in"), edge("t", "out", "b", "in"), edge("t", "out", "c", "in")],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "a", "b", "c"]);
  });

  it("runs the merge once after a diamond, with the data of both branches", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [
        node("t", "trigger.manual"),
        node("a", "x.rec"),
        node("b", "x.rec"),
        node("j", "x.join"),
        node("after", "x.rec"),
      ],
      [
        edge("t", "out", "a", "in"),
        edge("t", "out", "b", "in"),
        edge("a", "out", "j", "a"),
        edge("b", "out", "j", "b"),
        edge("j", "out", "after", "in"),
      ],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "a", "b", "j", "after"]);
    assert.deepEqual(seen, [{ a: 7, b: 7 }]);
  });

  it("does not hang when the skipped branch has nodes before the merge", async () => {
    seen.length = 0;
    const { result, ran, skipped } = await runGraph(
      [
        node("t", "trigger.manual"),
        node("i", "logic.if", { yes: false }),
        node("yes1", "x.rec"),
        node("yes2", "x.rec"),
        node("no1", "x.rec"),
        node("j", "x.join"),
        node("after", "x.rec"),
      ],
      [
        edge("t", "out", "i", "in"),
        edge("i", "true", "yes1", "in"),
        edge("yes1", "out", "yes2", "in"),
        edge("yes2", "out", "j", "a"),
        edge("i", "false", "no1", "in"),
        edge("no1", "out", "j", "b"),
        edge("j", "out", "after", "in"),
      ],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(skipped, ["yes1", "yes2"]);
    assert.deepEqual(ran, ["t", "i", "no1", "j", "after"]);
    assert.deepEqual(seen, [{ b: 7 }]);
  });

  it("skips the merge and what follows when every branch is skipped", async () => {
    seen.length = 0;
    const { result, ran, skipped } = await runGraph(
      [
        node("t", "trigger.manual"),
        node("i", "logic.if", { yes: true }),
        node("x", "x.rec"),
        node("y", "x.rec"),
        node("j", "x.join"),
        node("after", "x.rec"),
      ],
      [
        edge("t", "out", "i", "in"),
        edge("i", "false", "x", "in"),
        edge("i", "false", "y", "in"),
        edge("x", "out", "j", "a"),
        edge("y", "out", "j", "b"),
        edge("j", "out", "after", "in"),
      ],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(seen, []);
    assert.deepEqual(ran, ["t", "i"]);
    assert.deepEqual([...skipped].sort(), ["after", "j", "x", "y"]);
  });

  it("stops the run when a branch fails, and the merge does not run", async () => {
    seen.length = 0;
    const { result } = await runGraph(
      [node("t", "trigger.manual"), node("f", "x.fail"), node("j", "x.join")],
      [edge("t", "out", "f", "in"), edge("f", "out", "j", "a"), edge("t", "out", "j", "b")],
    );
    assert.equal(result.status, "failed");
    assert.deepEqual(seen, []);
  });

  it("waits for a longer branch and runs the merge once", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("a", "x.rec"), node("b", "x.rec"), node("j", "x.join")],
      [
        edge("t", "out", "a", "in"),
        edge("a", "out", "b", "in"),
        edge("b", "out", "j", "a"),
        edge("t", "out", "j", "b"),
      ],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "a", "b", "j"]);
    assert.deepEqual(seen, [{ a: 7, b: 7 }]);
  });

  it("merges merges: a nested diamond runs each merge once", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [
        node("t", "trigger.manual"),
        node("a", "x.rec"),
        node("b", "x.rec"),
        node("c", "x.rec"),
        node("j", "x.join"),
        node("j2", "x.join"),
      ],
      [
        edge("t", "out", "a", "in"),
        edge("t", "out", "b", "in"),
        edge("t", "out", "c", "in"),
        edge("a", "out", "j", "a"),
        edge("b", "out", "j", "b"),
        edge("j", "out", "j2", "a"),
        edge("c", "out", "j2", "b"),
      ],
    );
    assert.equal(result.status, "succeeded");
    // Depth first: j runs as soon as a and b are done, before c.
    assert.deepEqual(ran, ["t", "a", "b", "j", "c", "j2"]);
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1], { a: { a: 7, b: 7 }, b: 7 });
  });

  it("runs the merge with one input when the other input has no edge", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("j", "x.join")],
      [edge("t", "out", "j", "b")],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "j"]);
    assert.deepEqual(seen, [{ b: 7 }]);
  });

  it("does not wait for a parent that the trigger cannot reach", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("orphan", "x.rec"), node("j", "x.join")],
      [edge("t", "out", "j", "a"), edge("orphan", "out", "j", "b")],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "j"]);
    assert.deepEqual(seen, [{ a: 7 }]);
  });

  it("merges when a failed node on one branch continues on error", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [
        node("t", "trigger.manual"),
        { ...node("f", "x.fail"), onError: "continue" },
        node("ok", "x.rec"),
        node("j", "x.join"),
      ],
      [
        edge("t", "out", "f", "in"),
        edge("t", "out", "ok", "in"),
        edge("f", "out", "j", "a"),
        edge("ok", "out", "j", "b"),
      ],
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "ok", "j"]);
    assert.equal(seen.length, 1);
    const [input] = seen as { a: { error: { message: string } }; b: number }[];
    assert.equal(input?.a.error.message, "boom");
    assert.equal(input?.b, 7);
  });

  it("does not run the other branch when a test stops at a node before the merge", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("a", "x.rec"), node("b", "x.rec"), node("j", "x.join")],
      [
        edge("t", "out", "a", "in"),
        edge("t", "out", "b", "in"),
        edge("a", "out", "j", "a"),
        edge("b", "out", "j", "b"),
      ],
      { target: { kind: "to", nodeId: "a" } },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "a"]);
    assert.deepEqual(seen, []);
  });

  it("runs both branches when a test runs to the merge", async () => {
    seen.length = 0;
    const { result, ran } = await runGraph(
      [node("t", "trigger.manual"), node("a", "x.rec"), node("b", "x.rec"), node("j", "x.join")],
      [
        edge("t", "out", "a", "in"),
        edge("t", "out", "b", "in"),
        edge("a", "out", "j", "a"),
        edge("b", "out", "j", "b"),
      ],
      { target: { kind: "to", nodeId: "j" } },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(ran, ["t", "a", "b", "j"]);
    assert.deepEqual(seen, [{ a: 7, b: 7 }]);
  });
});
