// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

export default defineNode({
  type: "flow.noop",
  label: "No Op",
  description: "Do nothing. Pass the input on",
  category: "flow",
  icon: "Circle",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: ({ input }) => ({ port: "out", data: input }),
});
