// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodes } from "./index";

describe("node actions", () => {
  for (const node of nodes.filter((n) => n.actions?.length)) {
    it(`${node.type}: each action sets a valid config`, () => {
      const labels = new Set<string>();
      for (const action of node.actions ?? []) {
        assert.ok(!labels.has(action.label), `duplicate action "${action.label}"`);
        labels.add(action.label);
        const result = node.config.safeParse({
          ...(node.defaultConfig as Record<string, unknown>),
          ...action.config,
        });
        // Fields that the user fills (owner, table) may be empty. The action keys must be valid.
        const bad = result.success
          ? []
          : result.error.issues.filter((issue) =>
              Object.keys(action.config).includes(String(issue.path[0])),
            );
        assert.deepEqual(bad, [], `action "${action.label}"`);
      }
    });
  }
});
