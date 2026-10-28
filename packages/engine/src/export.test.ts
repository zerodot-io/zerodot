// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExport, parseImport, variableKeysUsed } from "./export";
import type { Graph } from "./graph";

const base = { position: { x: 0, y: 0 }, pinned: null, onError: "fail" as const };
const graph: Graph = {
  schema: 1,
  nodes: [
    { ...base, id: "t", type: "trigger.manual", name: "Start", config: {}, credentialId: null },
    {
      ...base,
      id: "h",
      type: "http.request",
      name: "Call",
      config: {
        url: "{{ $vars.base_url }}/x",
        headers: { a: '{{ $vars["api-version"] }}', b: "{{ $vars['region'] }}" },
      },
      credentialId: "cred-1",
    },
  ],
  edges: [{ id: "e1", from: "t", fromPort: "out", to: "h", toPort: "in" }],
};

describe("export", () => {
  it("lists variable keys in every quoting style", () => {
    assert.deepEqual(variableKeysUsed(graph), ["api-version", "base_url", "region"]);
  });

  it("builds a file with the name and keys, and no values", () => {
    const file = buildExport("Sync", graph);
    assert.equal(file.name, "Sync");
    assert.deepEqual(file.variables, ["api-version", "base_url", "region"]);
    assert.equal(file.nodes.length, 2);
  });

  it("imports: clears unknown credentials and lists missing variables", () => {
    const file = buildExport("Sync", graph);
    const result = parseImport(file, { credentialIds: [], variableKeys: ["region"] });
    assert.equal(result.name, "Sync");
    assert.deepEqual(result.missingVariables, ["api-version", "base_url"]);
    assert.deepEqual(result.clearedCredentials, ["Call"]);
    assert.equal(result.graph.nodes[1]?.credentialId, null);
  });

  it("imports: keeps a credential the project has", () => {
    const result = parseImport(buildExport("Sync", graph), {
      credentialIds: ["cred-1"],
      variableKeys: [],
    });
    assert.equal(result.graph.nodes[1]?.credentialId, "cred-1");
    assert.deepEqual(result.clearedCredentials, []);
  });

  it("imports a plain graph without a name", () => {
    const result = parseImport(graph, { credentialIds: ["cred-1"], variableKeys: [] });
    assert.equal(result.name, null);
    assert.equal(result.missingVariables.length, 3);
  });

  it("rejects a file that is not a graph", () => {
    assert.throws(() => parseImport({ hello: 1 }, { credentialIds: [], variableKeys: [] }));
  });
});
