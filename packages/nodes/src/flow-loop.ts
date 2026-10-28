// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, resolveTemplate } from "@zerodot/engine";
import { z } from "zod";
import { DEFAULT_LIST, listField, toList } from "./list-common";

/** Where the loop is. The engine keeps it in memory between the runs of this node. */
type LoopState = { items: unknown[]; results: unknown[]; next: number };

const isLoopState = (value: unknown): value is LoopState =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray((value as LoopState).items) &&
  Array.isArray((value as LoopState).results) &&
  typeof (value as LoopState).next === "number";

export default defineNode({
  type: "flow.loop",
  label: "Loop Over Items",
  description: "Run the nodes on the loop output once for each item or batch",
  category: "flow",
  icon: "Repeat",
  config: z.object({
    list: listField,
    batchSize: z.number().int().min(1).max(1000).default(1),
  }),
  defaultConfig: { list: DEFAULT_LIST, batchSize: 1 },
  // The list is read when the loop starts. When the loop comes back, the input is the result of
  // the last pass, so the node must not read `list` again.
  rawConfigKeys: ["list"],
  stateful: true,
  // Connect the last node of the loop back to the input. `done` runs after the last pass.
  ports: { in: ["in"], out: ["done", "loop"] },
  subtitle: (config) =>
    typeof config.batchSize === "number" && config.batchSize > 1
      ? `batches of ${config.batchSize}`
      : undefined,
  run: ({ config, input, scope, loopBack, state }) => {
    let loop: LoopState;
    if (loopBack) {
      if (!isLoopState(state)) throw new Error("The loop got data back before it started");
      loop = { ...state, results: [...state.results, input] };
    } else {
      const raw =
        typeof config.list === "string" ? resolveTemplate(config.list, scope) : config.list;
      loop = { items: toList(raw), results: [], next: 0 };
    }
    if (loop.next >= loop.items.length) return { port: "done", data: loop.results, state: loop };
    const batch = loop.items.slice(loop.next, loop.next + config.batchSize);
    return {
      port: "loop",
      data: { items: batch, item: batch[0], index: loop.next, total: loop.items.length },
      state: { ...loop, next: loop.next + batch.length },
    };
  },
});
