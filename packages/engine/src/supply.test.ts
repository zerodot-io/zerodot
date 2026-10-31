// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { executeGraph, type NodeEndEvent } from "./execute";
import { type Graph, rootNodes } from "./graph";
import { canBeTool, createRegistry, defineNode, defineSupplyNode } from "./node";
import { toolDescription, withoutBinary } from "./tool";

const trigger = defineNode({
  type: "trigger.test",
  label: "Trigger",
  category: "trigger",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});

/** Gives a function that says its name and the `who` of its config. */
const greeter = defineSupplyNode({
  type: "test.greeter",
  label: "Greeter",
  category: "core",
  icon: "CircleIcon",
  config: z.object({ who: z.string() }),
  defaultConfig: { who: "" },
  supplies: "test.greet",
  supply: ({ config, node, log }) => {
    log?.([{ level: "log", message: "built" }]);
    return () => `${node.name}:${config.who}`;
  },
});

const broken = defineSupplyNode({
  type: "test.broken",
  label: "Broken",
  category: "core",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  supplies: "test.greet",
  supply: () => {
    throw new Error("no key");
  },
});

/** Calls each greeter it gets. */
const host = defineNode({
  type: "test.host",
  label: "Host",
  category: "core",
  icon: "CircleIcon",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  supplyPorts: [
    { name: "main", kind: "test.greet", label: "Main", required: true },
    { name: "extra", kind: "test.greet", label: "Extra", multiple: true },
  ],
  run: ({ supplies }) => {
    const main = supplies?.main as () => string;
    const extra = supplies?.extra as (() => string)[];
    return { port: "out", data: { main: main(), extra: extra.map((f) => f()) } };
  },
});

const registry = createRegistry([trigger, greeter, broken, host]);

const node = (id: string, type: string, config: Record<string, unknown> = {}, x = 0) => ({
  id,
  type,
  name: id,
  position: { x, y: 0 },
  config,
  credentialId: null,
  pinned: null,
  onError: "fail" as const,
});

function graphWith(extraNodes: Graph["nodes"], extraEdges: Graph["edges"]): Graph {
  return {
    schema: 1,
    nodes: [node("t", "trigger.test"), node("h", "test.host"), ...extraNodes],
    edges: [{ id: "e1", from: "t", fromPort: "out", to: "h", toPort: "in" }, ...extraEdges],
  };
}

const supplyEdge = (from: string, port: string) => ({
  id: `s-${from}`,
  from,
  fromPort: "supply",
  to: "h",
  toPort: `supply:${port}`,
});

async function run(graph: Graph) {
  const ends: NodeEndEvent[] = [];
  const result = await executeGraph({
    graph,
    registry,
    triggerInput: { name: "Ada" },
    mode: "production",
    signal: new AbortController().signal,
    hooks: [{ afterNode: (event) => void ends.push(event) }],
  });
  return { result, ends };
}

describe("supply nodes", () => {
  it("builds supplies with the scope of the parent and orders a multiple port by x", async () => {
    const { result, ends } = await run(
      graphWith(
        [
          node("m", "test.greeter", { who: "{{ $input.name }}" }),
          node("b", "test.greeter", { who: "b" }, 200),
          node("a", "test.greeter", { who: "a" }, 100),
        ],
        [supplyEdge("m", "main"), supplyEdge("b", "extra"), supplyEdge("a", "extra")],
      ),
    );
    assert.equal(result.status, "succeeded");
    const hostEnd = ends.find((e) => e.node.id === "h");
    assert.deepEqual(hostEnd?.output, { main: "m:Ada", extra: ["a:a", "b:b"] });
    assert.ok(hostEnd?.logs?.some((l) => l.message === "[m] built"));
    // Supply nodes are never steps.
    assert.deepEqual(
      ends.map((e) => e.node.id),
      ["t", "h"],
    );
  });

  it("fails the parent when a required port has no node", async () => {
    const { result } = await run(graphWith([], []));
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /Connect a node to "Main"/);
  });

  it("counts a disabled supply node as not connected", async () => {
    const off = { ...node("m", "test.greeter", { who: "x" }), disabled: true };
    const { result } = await run(graphWith([off], [supplyEdge("m", "main")]));
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /Connect a node/);
  });

  it("names the supply node when supply() throws", async () => {
    const { result } = await run(graphWith([node("k", "test.broken")], [supplyEdge("k", "main")]));
    assert.equal(result.status, "failed");
    assert.equal(result.error?.message, 'Supply "k" (Main): no key');
  });

  it("does not count a supply node as a root", () => {
    const graph = graphWith([node("m", "test.greeter", { who: "x" })], [supplyEdge("m", "main")]);
    assert.deepEqual(
      rootNodes(graph).map((n) => n.id),
      ["t"],
    );
  });
});

describe("node as tool", () => {
  const slack = defineNode({
    type: "test.slack",
    label: "Send message",
    description: "Sends a message",
    category: "integration",
    icon: "CircleIcon",
    config: z.object({ channel: z.string(), text: z.string(), count: z.unknown() }),
    defaultConfig: { channel: "", text: "", count: 0 },
    ports: { in: ["in"], out: ["out"] },
    run: ({ config, input }) => ({ port: "out", data: { sent: config, input } }),
  });
  /** Lists its tools and calls the first one with fixed input. */
  const agent = defineNode({
    type: "test.agent",
    label: "Agent",
    category: "core",
    icon: "CircleIcon",
    config: z.object({}),
    defaultConfig: {},
    ports: { in: ["in"], out: ["out"] },
    supplyPorts: [{ name: "tools", kind: "ai.tool", label: "Tool", multiple: true }],
    run: async ({ supplies }) => {
      const tools = supplies?.tools as {
        spec: { name: string; inputSchema: unknown };
        call(input: unknown): Promise<unknown>;
      }[];
      const first = tools[0];
      if (!first) throw new Error("no tool");
      const result = await first.call({ text: "hi", count: 3 });
      return {
        port: "out",
        data: { names: tools.map((t) => t.spec.name), schema: first.spec.inputSchema, result },
      };
    },
  });
  const toolRegistry = createRegistry([trigger, slack, agent]);
  const toolGraph = (config: Record<string, unknown>): Graph => ({
    schema: 1,
    nodes: [
      node("t", "trigger.test"),
      node("a", "test.agent"),
      { ...node("Send message", "test.slack", config), toolDescription: "" },
      node("Send message!", "test.slack", { channel: "x", text: "y", count: 1 }, 100),
    ],
    edges: [
      { id: "e1", from: "t", fromPort: "out", to: "a", toPort: "in" },
      { id: "s1", from: "Send message", fromPort: "supply", to: "a", toPort: "supply:tools" },
      { id: "s2", from: "Send message!", fromPort: "supply", to: "a", toPort: "supply:tools" },
    ],
  });

  it("builds a tool from $fromAI and runs the node with the parent's input", async () => {
    const ends: NodeEndEvent[] = [];
    const result = await executeGraph({
      graph: toolGraph({
        channel: "{{ $input.name }}",
        text: 'Say: {{ $fromAI("text", "The message") }}',
        count: '{{ $fromAI("count", "", "number") }}',
      }),
      registry: toolRegistry,
      triggerInput: { name: "Ada" },
      mode: "production",
      signal: new AbortController().signal,
      hooks: [{ afterNode: (event) => void ends.push(event) }],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    const out = ends.find((e) => e.node.id === "a")?.output as Record<string, unknown>;
    assert.deepEqual(out.names, ["Send_message", "Send_message_2"]);
    assert.deepEqual(out.schema, {
      type: "object",
      properties: {
        text: { type: "string", description: "The message" },
        count: { type: "number" },
      },
      required: ["text", "count"],
      additionalProperties: false,
    });
    assert.deepEqual(out.result, {
      sent: { channel: "Ada", text: "Say: hi", count: 3 },
      input: { name: "Ada" },
    });
  });

  it("gives the model the type and size of binary data, not the data", () => {
    assert.deepEqual(
      withoutBinary({
        ok: true,
        binary: { file: { data: "aGVsbG8=", mimeType: "text/plain", fileName: "a.txt" } },
        list: [{ data: "aGk=", mimeType: "text/plain" }],
        other: { data: "x", mimeType: "y", extra: 1 },
      }),
      {
        ok: true,
        binary: { file: { mimeType: "text/plain", fileName: "a.txt", size: 5 } },
        list: [{ mimeType: "text/plain", size: 2 }],
        other: { data: "x", mimeType: "y", extra: 1 },
      },
    );
  });

  it("describes a tool by the action that its config selects", () => {
    const definition = {
      label: "Slack",
      app: "Slack",
      description: "Send messages, manage channels, and find users",
      subtitle: (config: Record<string, unknown>) => `${config.resource}: ${config.operation}`,
      actions: [
        { label: "Send a message", config: { resource: "message", operation: "send" } },
        {
          label: "Send a WhatsApp message",
          config: { resource: "message", operation: "send", channel: "whatsapp" },
        },
        { label: "Find a user", config: { resource: "user", operation: "find" } },
      ],
    };
    const config = { resource: "message", operation: "send", text: "hi" };
    assert.equal(toolDescription({ config }, definition), "Send a message in Slack");
    assert.equal(
      toolDescription({ config: { ...config, channel: "whatsapp" } }, definition),
      "Send a WhatsApp message in Slack",
    );
    assert.equal(
      toolDescription({ config, toolDescription: " Post to #general " }, definition),
      "Post to #general",
    );
    // No action matches: the description and the subtitle, as before.
    assert.equal(
      toolDescription({ config: { resource: "file", operation: "upload" } }, definition),
      "Send messages, manage channels, and find users. file: upload",
    );
  });

  it("does not let a join node or a trigger be a tool", () => {
    assert.equal(canBeTool({ category: "integration", join: true }), false);
    assert.equal(canBeTool({ category: "trigger", usableAsTool: true }), false);
    assert.equal(canBeTool({ category: "integration" }), true);
    assert.equal(canBeTool({ category: "data" }), false);
  });

  it("checks keys, duplicates, defaults, and the input of the model", async () => {
    const { checkToolInput, fromAIInputs, toolInputSchema } = await import("./tool");
    const inputsOf = (text: string) => fromAIInputs({ config: { text } }, {});
    assert.throws(() => inputsOf('{{ $fromAI("") }}'), /You must specify a key/);
    assert.throws(() => inputsOf('{{ $fromAI("a b") }}'), /Parameter key `a b` is invalid/);
    assert.throws(() => inputsOf(`{{ $fromAI("${"k".repeat(65)}") }}`), /is invalid/);
    assert.throws(
      () => inputsOf('{{ $fromAI("k", "one") }} {{ $fromAI("k", "two") }}'),
      /Duplicate key 'k' found with different description or type/,
    );
    const inputs = inputsOf(
      '{{ $fromAI("n", "How many", "number", 2) }} {{ $fromAI("tags", "", "json") }}',
    );
    assert.deepEqual(toolInputSchema(inputs), {
      type: "object",
      properties: {
        n: { type: "number", description: "How many", default: 2 },
        tags: {
          anyOf: [
            { type: "object", minProperties: 1 },
            { type: "array", minItems: 1 },
          ],
        },
      },
      required: ["tags"],
      additionalProperties: false,
    });
    assert.deepEqual(checkToolInput(inputs, { tags: ["a"], extra: 1 }), { tags: ["a"], n: 2 });
    assert.throws(
      () => checkToolInput(inputs, { n: "2", tags: [], extra: 1 }),
      /"n" must be a number; "tags" must be a non-empty object or a non-empty array$/,
    );
  });

  it("fails a $fromAI key that is not literal text", async () => {
    const result = await executeGraph({
      graph: toolGraph({ channel: "", text: "{{ $fromAI($input.name) }}", count: 0 }),
      registry: toolRegistry,
      triggerInput: {},
      mode: "production",
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /Supply "Send message" \(Tool\): config.text/);
  });
});

describe("nested supplies, run cache, and close", () => {
  /** Counts builds and closes of each embedding value, by the `name` of its config. */
  const built: string[] = [];
  const closed: string[] = [];
  const embedding = defineSupplyNode({
    type: "test.embedding",
    label: "Embedding",
    category: "core",
    icon: "CircleIcon",
    config: z.object({ name: z.string() }),
    defaultConfig: { name: "" },
    supplies: "test.embed",
    supply: ({ config }) => {
      built.push(config.name);
      return {
        embed: (text: string) => `${config.name}(${text})`,
        close: () => void closed.push(config.name),
      };
    },
  });
  /** A store that uses its embedding supply. It can be a tool. */
  const store = defineNode({
    type: "test.store",
    label: "Store",
    category: "integration",
    icon: "CircleIcon",
    config: z.object({}),
    defaultConfig: {},
    ports: { in: ["in"], out: ["out"] },
    supplyPorts: [{ name: "embedding", kind: "test.embed", label: "Embedding", required: true }],
    run: ({ supplies }) => {
      const value = supplies?.embedding as { embed(text: string): string };
      return { port: "out", data: { vector: value.embed("q") } };
    },
  });
  /** A supply node with its own supply port. */
  const storeSupply = defineSupplyNode({
    type: "test.store-supply",
    label: "Store supply",
    category: "core",
    icon: "CircleIcon",
    config: z.object({}),
    defaultConfig: {},
    supplies: "test.greet",
    supplyPorts: [{ name: "embedding", kind: "test.embed", label: "Embedding", required: true }],
    supply: ({ supplies }) => {
      const value = supplies?.embedding as { embed(text: string): string };
      return () => value.embed("s");
    },
  });
  /** A host with one greet port, so it can run more than once in a run. */
  const one = defineNode({
    type: "test.one",
    label: "One",
    category: "core",
    icon: "CircleIcon",
    config: z.object({}),
    defaultConfig: {},
    ports: { in: ["in"], out: ["out"] },
    supplyPorts: [{ name: "main", kind: "test.greet", label: "Main", required: true }],
    run: ({ supplies, input }) => {
      const main = supplies?.main as () => string;
      return { port: "out", data: { said: main(), input } };
    },
  });
  const agent = defineNode({
    type: "test.agent2",
    label: "Agent",
    category: "core",
    icon: "CircleIcon",
    config: z.object({}),
    defaultConfig: {},
    ports: { in: ["in"], out: ["out"] },
    supplyPorts: [{ name: "tools", kind: "ai.tool", label: "Tool", multiple: true }],
    run: async ({ supplies }) => {
      const tools = supplies?.tools as { call(input: unknown): Promise<unknown> }[];
      const results = [];
      for (const tool of tools) results.push(await tool.call({}));
      return { port: "out", data: results };
    },
  });
  const nestedRegistry = createRegistry([trigger, embedding, store, storeSupply, one, agent]);
  const edge = (from: string, to: string, port: string) => ({
    id: `${from}-${to}`,
    from,
    fromPort: "supply",
    to,
    toPort: `supply:${port}`,
  });
  const flow = (from: string, to: string) => ({
    id: `${from}-${to}`,
    from,
    fromPort: "out",
    to,
    toPort: "in",
  });
  const runNested = async (graph: Graph) => {
    built.length = 0;
    closed.length = 0;
    const ends: NodeEndEvent[] = [];
    const result = await executeGraph({
      graph,
      registry: nestedRegistry,
      triggerInput: { name: "Ada" },
      mode: "production",
      signal: new AbortController().signal,
      hooks: [{ afterNode: (event) => void ends.push(event) }],
    });
    return { result, ends };
  };

  it("gives a node that runs as a tool its supplies", async () => {
    const { result, ends } = await runNested({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("a", "test.agent2"),
        node("s", "test.store"),
        node("e", "test.embedding", { name: "E" }),
      ],
      edges: [flow("t", "a"), edge("s", "a", "tools"), edge("e", "s", "embedding")],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.deepEqual(ends.find((e) => e.node.id === "a")?.output, [{ vector: "E(q)" }]);
    assert.deepEqual(closed, ["E"]);
  });

  it("gives a supply node the values of its own supply ports", async () => {
    const { result, ends } = await runNested({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("h", "test.one"),
        node("v", "test.store-supply"),
        node("e", "test.embedding", { name: "E" }),
      ],
      edges: [flow("t", "h"), edge("v", "h", "main"), edge("e", "v", "embedding")],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    const out = ends.find((e) => e.node.id === "h")?.output as { said: string } | undefined;
    assert.equal(out?.said, "E(s)");
  });

  it("builds a static supply one time for the run and closes it at the end", async () => {
    const { result } = await runNested({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("h1", "test.one"),
        node("h2", "test.one"),
        node("v", "test.store-supply"),
        node("e", "test.embedding", { name: "{{ $env.MODEL ?? 'E' }}" }),
      ],
      edges: [
        flow("t", "h1"),
        flow("h1", "h2"),
        edge("v", "h1", "main"),
        edge("v", "h2", "main"),
        edge("e", "v", "embedding"),
      ],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.deepEqual(built, ["E"]);
    assert.deepEqual(closed, ["E"]);
  });

  it("builds a supply that uses $input for each parent run and closes it after each", async () => {
    const { result } = await runNested({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("h1", "test.one"),
        node("h2", "test.one"),
        node("v", "test.store-supply"),
        node("e", "test.embedding", { name: "{{ $input.name ?? 'next' }}" }),
      ],
      edges: [
        flow("t", "h1"),
        flow("h1", "h2"),
        edge("v", "h1", "main"),
        edge("v", "h2", "main"),
        edge("e", "v", "embedding"),
      ],
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.deepEqual(built, ["Ada", "next"]);
    assert.deepEqual(closed, ["Ada", "next"]);
  });

  it("fails supply nodes that make a loop", async () => {
    const chain = defineSupplyNode({
      type: "test.chain",
      label: "Chain",
      category: "core",
      icon: "CircleIcon",
      config: z.object({}),
      defaultConfig: {},
      supplies: "test.embed",
      supplyPorts: [{ name: "embedding", kind: "test.embed", label: "Embedding" }],
      supply: () => ({ embed: (text: string) => text }),
    });
    const result = await executeGraph({
      graph: {
        schema: 1,
        nodes: [
          node("t", "trigger.test"),
          node("h", "test.one"),
          node("v", "test.store-supply"),
          node("c1", "test.chain"),
          node("c2", "test.chain"),
        ],
        edges: [
          flow("t", "h"),
          edge("v", "h", "main"),
          edge("c1", "v", "embedding"),
          edge("c2", "c1", "embedding"),
          edge("c1", "c2", "embedding"),
        ],
      },
      registry: createRegistry([trigger, store, storeSupply, one, chain]),
      triggerInput: {},
      mode: "production",
      signal: new AbortController().signal,
    });
    assert.equal(result.status, "failed");
    assert.match(result.error?.message ?? "", /The supply nodes make a loop/);
  });

  it("skips a supply port that its showWhen hides", async () => {
    const reranked = defineNode({
      type: "test.reranked",
      label: "Reranked",
      category: "core",
      icon: "CircleIcon",
      config: z.object({ rerank: z.boolean() }),
      defaultConfig: { rerank: false },
      ports: { in: ["in"], out: ["out"] },
      supplyPorts: [
        {
          name: "reranker",
          kind: "test.embed",
          label: "Reranker",
          required: true,
          showWhen: { rerank: [true] },
        },
      ],
      run: ({ supplies }) => ({ port: "out", data: { has: supplies?.reranker !== undefined } }),
    });
    const graphFor = (rerank: boolean): Graph => ({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        node("r", "test.reranked", { rerank }),
        node("e", "test.embedding", { name: "E" }),
      ],
      edges: [flow("t", "r"), edge("e", "r", "reranker")],
    });
    const runOne = async (rerank: boolean) => {
      const ends: NodeEndEvent[] = [];
      const result = await executeGraph({
        graph: graphFor(rerank),
        registry: createRegistry([trigger, embedding, reranked]),
        triggerInput: {},
        mode: "production",
        signal: new AbortController().signal,
        hooks: [{ afterNode: (event) => void ends.push(event) }],
      });
      return { result, out: ends.find((e) => e.node.id === "r")?.output };
    };
    assert.deepEqual((await runOne(true)).out, { has: true });
    const hidden = await runOne(false);
    assert.equal(hidden.result.status, "succeeded", JSON.stringify(hidden.result.error));
    assert.deepEqual(hidden.out, { has: false });
  });

  describe("close and the run cache", () => {
    const events: { node: string; status: string; method?: string; error?: string }[] = [];
    let builds = 0;
    let closes = 0;
    /** A static supply. It counts builds and closes, logs on each call, and can hang on close. */
    const counter = defineSupplyNode({
      type: "test.counter",
      label: "Counter",
      category: "core",
      icon: "CircleIcon",
      config: z.object({ hang: z.boolean() }),
      defaultConfig: { hang: false },
      supplies: "test.greet",
      supply: ({ config, log }) => {
        builds++;
        const build = builds;
        const say = () => {
          log?.([{ level: "info", message: `call of build ${build}` }]);
          return `build ${build}`;
        };
        return Object.assign(say, {
          close: () => {
            closes++;
            return config.hang ? new Promise(() => undefined) : undefined;
          },
        });
      },
    });
    let failFirst = false;
    const flaky = defineNode({
      type: "test.flaky",
      label: "Flaky",
      category: "core",
      icon: "CircleIcon",
      config: z.object({}),
      defaultConfig: {},
      ports: { in: ["in"], out: ["out"] },
      supplyPorts: [{ name: "main", kind: "test.greet", label: "Main", required: true }],
      run: ({ supplies }) => {
        const main = supplies?.main as () => string;
        const said = main();
        if (failFirst) {
          failFirst = false;
          throw new Error("lost connection");
        }
        return { port: "out", data: { said } };
      },
    });
    const counterRegistry = createRegistry([trigger, counter, flaky]);
    const runCounter = async (graph: Graph) => {
      builds = 0;
      closes = 0;
      events.length = 0;
      const ends: NodeEndEvent[] = [];
      const result = await executeGraph({
        graph,
        registry: counterRegistry,
        triggerInput: {},
        mode: "production",
        signal: new AbortController().signal,
        supplyCloseMs: 20,
        hooks: [
          {
            afterNode: (event) => void ends.push(event),
            onSupplyUse: (event) =>
              void events.push({
                node: event.node.id,
                status: event.status,
                method: event.call?.method,
                error: event.call?.error?.message,
              }),
          },
        ],
      });
      return { result, ends };
    };
    const twoHosts = (hang: boolean, retry?: { max: number; backoffMs: number }): Graph => ({
      schema: 1,
      nodes: [
        node("t", "trigger.test"),
        { ...node("h1", "test.flaky"), ...(retry ? { retry } : {}) },
        node("h2", "test.flaky"),
        node("c", "test.counter", { hang }),
      ],
      edges: [flow("t", "h1"), flow("h1", "h2"), edge("c", "h1", "main"), edge("c", "h2", "main")],
    });

    it("writes the logs of a cached value to the node that uses it now", async () => {
      const { result, ends } = await runCounter(twoHosts(false));
      assert.equal(result.status, "succeeded", JSON.stringify(result.error));
      assert.equal(builds, 1);
      const logsOf = (id: string) =>
        ends.find((e) => e.node.id === id)?.logs?.map((l) => l.message);
      assert.deepEqual(logsOf("h1"), ["[c] call of build 1"]);
      assert.deepEqual(logsOf("h2"), ["[c] call of build 1"]);
    });

    it("does not wait for a close that hangs, and reports it", async () => {
      const { result } = await runCounter(twoHosts(true));
      assert.equal(result.status, "succeeded", JSON.stringify(result.error));
      assert.equal(closes, 1);
      assert.deepEqual(
        events.filter((e) => e.method === "close"),
        [{ node: "c", status: "failed", method: "close", error: "It did not close in 20 ms" }],
      );
    });

    it("builds cached values again after a node attempt fails", async () => {
      failFirst = true;
      const { result, ends } = await runCounter(twoHosts(false, { max: 1, backoffMs: 0 }));
      assert.equal(result.status, "succeeded", JSON.stringify(result.error));
      // The failed attempt closed build 1. The retry and h2 share build 2.
      assert.equal(builds, 2);
      assert.equal(closes, 2);
      const said = (id: string) =>
        (ends.findLast((e) => e.node.id === id)?.output as { said: string } | undefined)?.said;
      assert.equal(said("h1"), "build 2");
      assert.equal(said("h2"), "build 2");
    });
  });
});
