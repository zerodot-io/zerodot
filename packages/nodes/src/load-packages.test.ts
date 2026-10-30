// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";
import { credentialTypeByName } from "./credentials";
import { registry, unregisterNodes } from "./index";
import {
  loadNodePackages,
  type ManifestReader,
  parseNodePackages,
  readManifestFromDisk,
} from "./load-packages";

/** A reader that gives every package the same range. */
const manifest =
  (sdk: string | undefined = "^1.0"): ManifestReader =>
  () =>
    sdk ? { sdk } : {};

const node = (type: string, extra = {}) => ({
  type,
  label: type,
  category: "integration",
  icon: "PlugSocketIcon",
  config: z.object({}),
  defaultConfig: {},
  ports: { in: ["in"], out: ["out"] },
  run: () => ({ port: "out", data: null }),
  ...extra,
});

describe("loadNodePackages", () => {
  it("parses the env value", () => {
    assert.deepEqual(parseNodePackages(" a, b ,,c"), ["a", "b", "c"]);
    assert.deepEqual(parseNodePackages(undefined), []);
  });

  it("adds valid nodes, skips bad ones, and never replaces a built-in", async () => {
    const reports = await loadNodePackages(
      ["pkg", "broken", "empty"],
      async (name) => {
        if (name === "broken") throw new Error("Cannot find package");
        if (name === "empty") return {};
        return {
          nodes: [
            node("ext.hello"),
            node("http.request"),
            node("ext.nope", { run: undefined }),
            node("ext.trigger", { category: "trigger" }),
          ],
        };
      },
      manifest(),
    );
    try {
      assert.deepEqual(reports[0]?.added, ["ext.hello"]);
      assert.deepEqual(
        reports[0]?.skipped.map((s) => s.reason),
        ["no run()", 'a trigger type starts with "trigger."', "type exists"],
      );
      assert.match(reports[1]?.error ?? "", /Cannot find/);
      assert.match(reports[2]?.error ?? "", /nodes/);
      assert.ok(registry.has("ext.hello"));
      // A second load adds nothing new.
      const again = await loadNodePackages(
        ["pkg"],
        async () => ({ nodes: [node("ext.hello")] }),
        manifest(),
      );
      assert.deepEqual(again[0]?.added, []);
    } finally {
      unregisterNodes(["ext.hello"]);
    }
  });

  it("registers the credential types of a package", async () => {
    const credential = {
      type: "ext.token",
      label: "Ext",
      fields: z.object({ token: z.string().min(1) }),
      secretFields: ["token"],
    };
    const reports = await loadNodePackages(
      ["pkg"],
      async () => ({
        nodes: [node("ext.cred")],
        credentialTypes: [credential, credential, { type: "bad" }],
      }),
      manifest(),
    );
    try {
      assert.deepEqual(reports[0]?.credentialTypes, ["ext.token"]);
      assert.deepEqual(
        reports[0]?.skipped.map((s) => s.reason),
        ["credential type exists", "not a credential type"],
      );
      assert.equal(credentialTypeByName.has("ext.token"), true);
    } finally {
      unregisterNodes(["ext.cred"]);
    }
  });

  it("checks the sdk range before it runs the package", async () => {
    const ranges: Record<string, string | undefined> = {
      none: undefined,
      old: "^0.1",
      future: "^2.0",
    };
    let imported = 0;
    const reports = await loadNodePackages(
      ["none", "old", "future", "missing"],
      async () => {
        imported++;
        return { nodes: [node("ext.versioned")] };
      },
      (name) => (name in ranges ? (ranges[name] ? { sdk: ranges[name] } : {}) : null),
    );
    assert.match(reports[0]?.error ?? "", /no "zerodot\.sdk"/);
    assert.match(
      reports[1]?.error ?? "",
      /old is too old for this version of zerodot\. Ask its author for an update\. \(The package needs node SDK \^0\.1\./,
    );
    assert.match(
      reports[2]?.error ?? "",
      /future needs a newer version of zerodot\. Update zerodot, then install it again\. \(The package needs node SDK \^2\.0\./,
    );
    assert.match(reports[3]?.error ?? "", /Cannot find package/);
    assert.equal(imported, 0);
    assert.equal(registry.has("ext.versioned"), false);
  });

  it("reads the manifest of a package from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-pkg-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ zerodot: { sdk: "^1.2" } }));
      assert.deepEqual(readManifestFromDisk(dir), { sdk: "^1.2" });
      assert.equal(readManifestFromDisk(join(dir, "nope")), null);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
