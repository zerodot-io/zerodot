// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { registry } from "./index";

const signal = new AbortController().signal;

type Call = { source: unknown; input: unknown; wait: boolean | undefined };

function definitionOf() {
  const definition = registry.get("flow.execute_workflow");
  if (!definition) throw new Error("missing flow.execute_workflow");
  return definition;
}

async function run(config: Record<string, unknown>, input: unknown = null) {
  const definition = definitionOf();
  const calls: Call[] = [];
  const result = await definition.run({
    config: definition.config.parse(config),
    input,
    credential: null,
    signal,
    scope: {},
    sandbox: null,
    tables: null,
    runWorkflow: async (source, data, options) => {
      calls.push({ source, input: data, wait: options?.wait });
      return { ok: true };
    },
  });
  return { data: result.data, calls };
}

describe("flow.execute_workflow", () => {
  it("marks the workflow id field for the workflow picker", () => {
    const schema = z.toJSONSchema(definitionOf().config) as {
      properties: Record<string, { ui?: string; showWhen?: Record<string, string[]> }>;
    };
    assert.equal(schema.properties.workflowId?.ui, "workflow");
    assert.deepEqual(schema.properties.workflowId?.showWhen, { source: ["database"] });
  });

  it("runs the workflow with the picked id", async () => {
    const { calls } = await run({ workflowId: "wf_1" }, { a: 1 });
    assert.deepEqual(calls, [
      { source: { kind: "database", workflowId: "wf_1" }, input: { a: 1 }, wait: true },
    ]);
  });

  it("accepts an id that came from an expression", async () => {
    const { calls } = await run({ workflowId: "wf_from_expression" });
    assert.deepEqual(calls[0]?.source, { kind: "database", workflowId: "wf_from_expression" });
  });

  it("fails when no workflow is picked", async () => {
    await assert.rejects(run({ workflowId: "" }), /Enter the id of a workflow/);
  });

  it("does not need an id for a workflow given as JSON", async () => {
    const { calls } = await run({ source: "parameter", workflowJson: '{"nodes":[]}' });
    assert.deepEqual(calls[0]?.source, { kind: "parameter", graph: { nodes: [] } });
  });

  it("shows the id as the subtitle", () => {
    const definition = definitionOf();
    const config: Record<string, unknown> = definition.config.parse({
      workflowId: "wf_1",
    }) as Record<string, unknown>;
    assert.equal(definition.subtitle?.(config), "wf_1");
  });
});
