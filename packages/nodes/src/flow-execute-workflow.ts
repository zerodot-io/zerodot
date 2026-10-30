// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, type SubWorkflowSource } from "@zerodot/engine";
import { z } from "zod";

function sourceOf(config: {
  source: "database" | "parameter";
  workflowId?: string;
  workflowJson?: string;
}): SubWorkflowSource {
  if (config.source === "parameter") {
    try {
      return { kind: "parameter", graph: JSON.parse(config.workflowJson ?? "") };
    } catch {
      throw new Error("The workflow JSON is not valid JSON");
    }
  }
  if (!config.workflowId) throw new Error("Enter the id of a workflow");
  return { kind: "database", workflowId: config.workflowId };
}

export default defineNode({
  type: "flow.execute_workflow",
  label: "Execute Workflow",
  description: "Run another workflow and use the output of its last node",
  category: "flow",
  icon: "WorkflowSquare10Icon",
  config: z.object({
    source: z
      .enum(["database", "parameter"])
      .default("database")
      .meta({
        title: "Source",
        labels: { database: "Database", parameter: "Define Below" },
        hints: {
          database: "Load the workflow from the database by ID",
          parameter: "Pass the JSON code of a workflow",
        },
      }),
    workflowId: z
      .string()
      .default("")
      .meta({
        title: "Workflow",
        ui: "workflow",
        description: "The workflow to run. Use an expression to give an id",
        showWhen: { source: ["database"] },
      }),
    workflowJson: z
      .string()
      .default("")
      .meta({
        title: "Workflow JSON",
        ui: "code",
        description: "The graph of a workflow, as JSON",
        showWhen: { source: ["parameter"] },
      }),
    mode: z
      .enum(["once", "each"])
      .default("once")
      .meta({
        title: "Mode",
        labels: { once: "Run Once With All Items", each: "Run Once For Each Item" },
        hints: {
          once: "Pass all items into a single execution of the sub-workflow",
          each: "Call the sub-workflow individually for each item",
        },
      }),
    waitForCompletion: z.boolean().default(true).meta({
      title: "Wait For Sub-Workflow Completion",
      description: "Off: start the sub-workflow and go on. The output is the id of its run",
    }),
  }),
  defaultConfig: {
    source: "database",
    workflowId: "",
    workflowJson: "",
    mode: "once",
    waitForCompletion: true,
  },
  // The graph is JSON text. `{{ }}` in it belongs to the sub-workflow.
  rawConfigKeys: ["workflowJson"],
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    config.source === "parameter"
      ? "from JSON"
      : typeof config.workflowId === "string" && config.workflowId !== ""
        ? config.workflowId
        : undefined,
  async run({ config, input, runWorkflow }) {
    if (!runWorkflow) throw new Error("This worker cannot run a sub-workflow");
    const source = sourceOf(config);
    const options = { wait: config.waitForCompletion };
    if (config.mode === "each") {
      // Items are the entries of an input list. Other input is one item.
      const items = Array.isArray(input) ? input : [input];
      const results: unknown[] = [];
      for (const item of items) results.push(await runWorkflow(source, item, options));
      return { port: "out", data: results };
    }
    return { port: "out", data: await runWorkflow(source, input, options) };
  },
});
