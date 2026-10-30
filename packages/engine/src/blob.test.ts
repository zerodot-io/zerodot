// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import {
  blobIds,
  containsBlobRef,
  externalizeBinary,
  hydrate,
  isBlobRef,
  mapBlobRefs,
  memoryBlobStore,
  storeValue,
} from "./blob";
import { executeGraph } from "./execute";
import type { Graph } from "./graph";
import { createRegistry, defineNode } from "./node";

const RUN = "11111111-1111-4111-8111-111111111111";
const file = (text: string) => ({
  data: Buffer.from(text).toString("base64"),
  mimeType: "text/plain",
  fileName: "a.txt",
});

describe("blob helpers", () => {
  it("replaces files under binary with references and back", async () => {
    const store = memoryBlobStore();
    const value = { name: "x", items: [{ id: 1, binary: { doc: file("hello") } }] };
    const slim = await externalizeBinary(value, store, RUN);
    const ref = (slim as { items: { binary: { doc: unknown } }[] }).items[0]?.binary.doc;
    assert.ok(isBlobRef(ref));
    assert.equal(ref.size, 5);
    assert.equal(ref.fileName, "a.txt");
    assert.equal(ref.$blob.startsWith(`${RUN}/`), true);
    assert.equal(containsBlobRef(slim), true);
    assert.equal(JSON.stringify(slim).includes(file("hello").data), false);
    assert.deepEqual(blobIds(slim), [ref.$blob]);
    // The input is not changed.
    assert.equal(containsBlobRef(value), false);
    assert.deepEqual(await hydrate(slim, store), value);
  });

  it("stores the same bytes once for one run", async () => {
    const store = memoryBlobStore();
    await externalizeBinary({ binary: { a: file("same"), b: file("same") } }, store, RUN);
    assert.equal(store.blobs.size, 1);
  });

  it("leaves objects that only look like binary data", async () => {
    const store = memoryBlobStore();
    const value = { binary: { doc: { data: 5 } }, other: { data: "x", mimeType: "y" } };
    assert.deepEqual(await externalizeBinary(value, store, RUN), value);
    assert.equal(store.blobs.size, 0);
  });

  it("keeps small values inline and moves large values to one JSON blob", async () => {
    const store = memoryBlobStore();
    const small = await storeValue({ a: 1 }, store, { runId: RUN, inlineBytes: 100 });
    assert.deepEqual(small, { inline: { a: 1 }, ref: null });

    const big = { rows: Array.from({ length: 50 }, (_, i) => ({ i, text: "x".repeat(20) })) };
    const stored = await storeValue(big, store, { runId: RUN, inlineBytes: 100 });
    assert.equal(stored.inline, null);
    assert.ok(stored.ref?.json);
    assert.deepEqual(await hydrate(stored.ref, store), big);

    const kept = await storeValue(big, store, { runId: RUN, inlineBytes: 100, keepInline: true });
    assert.deepEqual(kept, { inline: big, ref: null });
  });

  it("stores files and also the rest when the rest is large", async () => {
    const store = memoryBlobStore();
    const value = { binary: { doc: file("hello") }, text: "y".repeat(300) };
    const stored = await storeValue(value, store, { runId: RUN, inlineBytes: 100 });
    assert.ok(stored.ref);
    assert.deepEqual(await hydrate(stored.ref, store), value);
  });

  it("changes references with mapBlobRefs", async () => {
    const store = memoryBlobStore();
    const slim = await externalizeBinary({ binary: { doc: file("x") } }, store, RUN);
    const moved = await mapBlobRefs(slim, async (ref) => ({ ...ref, $blob: "other" }));
    assert.deepEqual(blobIds(moved), ["other"]);
  });

  it("deletes the blobs of one run", async () => {
    const store = memoryBlobStore();
    const other = "22222222-2222-4222-8222-222222222222";
    await store.put(RUN, Buffer.from("a"), "text/plain");
    await store.put(other, Buffer.from("b"), "text/plain");
    assert.deepEqual((await store.listRunIds()).sort(), [RUN, other]);
    await store.deleteRun(RUN);
    assert.deepEqual(await store.listRunIds(), [other]);
  });
});

describe("executeGraph with blobs", () => {
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
  const read = defineNode({
    type: "test.read",
    label: "Read",
    category: "core",
    icon: "CircleIcon",
    config: z.object({ viaExpression: z.unknown() }),
    defaultConfig: { viaExpression: null },
    ports: { in: ["in"], out: ["out"] },
    run: ({ input, config }) => {
      const doc = (input as { binary?: { doc?: { data?: string } } }).binary?.doc;
      return {
        port: "out",
        data: {
          text: Buffer.from(doc?.data ?? "", "base64").toString(),
          viaExpression: config.viaExpression,
        },
      };
    },
  });
  const registry = createRegistry([trigger, read]);
  const node = (id: string, type: string, config: Record<string, unknown> = {}) => ({
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    config,
    credentialId: null,
    pinned: null,
    onError: "fail" as const,
  });
  const graph: Graph = {
    schema: 1,
    nodes: [
      node("t", "trigger.test"),
      node("r", "test.read", { viaExpression: "{{ $node['t'].data.binary.doc.data }}" }),
    ],
    edges: [{ id: "e", from: "t", fromPort: "out", to: "r", toPort: "in" }],
  };

  it("gives a node its input as base64 data after a resume", async () => {
    const store = memoryBlobStore();
    const saved = await externalizeBinary({ binary: { doc: file("from disk") } }, store, RUN);
    let seenInput: unknown;
    let seenOutput: unknown;
    const result = await executeGraph({
      graph,
      registry,
      triggerInput: null,
      mode: "production",
      signal: new AbortController().signal,
      blobs: store,
      previousResults: [
        { nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: saved },
      ],
      hooks: [
        {
          beforeNode: (e) => {
            seenInput = e.input;
          },
          afterNode: (e) => {
            seenOutput = e.output;
          },
        },
      ],
    });
    assert.equal(result.status, "succeeded");
    // Hooks see the saved input. The node and its expressions see the data.
    assert.equal(containsBlobRef(seenInput), true);
    assert.deepEqual(seenOutput, { text: "from disk", viaExpression: file("from disk").data });
  });

  it("reads a whole output that was stored as one JSON blob", async () => {
    const store = memoryBlobStore();
    const full = { binary: { doc: file("big one") }, pad: "z".repeat(500) };
    const { ref } = await storeValue(full, store, { runId: RUN, inlineBytes: 50 });
    assert.ok(ref);
    const outputs: unknown[] = [];
    const result = await executeGraph({
      graph,
      registry,
      triggerInput: null,
      mode: "production",
      signal: new AbortController().signal,
      blobs: store,
      previousResults: [{ nodeId: "t", attempt: 1, status: "succeeded", port: "out", output: ref }],
      hooks: [{ afterNode: (e) => void outputs.push(e.output) }],
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(outputs, [{ text: "big one", viaExpression: file("big one").data }]);
  });
});
