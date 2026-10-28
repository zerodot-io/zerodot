// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

/** Starts a workflow that another workflow names as its error workflow. */
export default defineNode({
  type: "trigger.error",
  label: "Error Trigger",
  description: "Start when a live run of another workflow fails",
  category: "trigger",
  icon: "TriangleAlert",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});
