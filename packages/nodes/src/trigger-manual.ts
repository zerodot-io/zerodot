// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export default defineNode({
  type: "trigger.manual",
  label: "Manual",
  description: "Start the workflow by hand with a button",
  category: "trigger",
  icon: "MousePointerClick",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: [], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});
