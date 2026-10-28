// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ListenContext, NodeDefinition, PollItem } from "@zerodot/engine";
import { credentialTypeByName } from "./credentials";
import { registry } from "./index";
import { isLoaded, loadInstalled, packageReports, unloadPackage } from "./install-packages";

const NAME = "zerodot-iso-demo";
// A file outside the nodes folder. The package must not read it.
const SECRET_FILE = realpathSync(new URL(import.meta.url).pathname);

/**
 * A community package with no dependencies. Its schema is a small object with `parse` and
 * `toJSONSchema`, like a Zod schema, so the package needs no zod.
 */
function writeCommunityPackage(dir: string) {
  const root = join(dir, "node_modules", NAME);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: NAME,
      version: "1.0.0",
      main: "./dist/index.cjs",
      exports: { ".": "./dist/index.cjs" },
      zerodot: { sdk: "^1.0" },
    }),
  );
  writeFileSync(
    join(root, "dist", "index.cjs"),
    `const schema = {
      parse: (value) => ({ ...value, checkedInPackage: true }),
      toJSONSchema: () => ({ type: "object", properties: { mode: { type: "string", default: "info", labels: { info: "Info" } } } }),
    };
    const fields = {
      parse: (value) => value,
      toJSONSchema: () => ({ type: "object", properties: { token: { type: "string" } }, required: ["token"] }),
    };
    const base = { label: "Iso", category: "integration", icon: "Plug", config: schema,
      defaultConfig: { mode: "info" }, ports: { in: ["in"], out: ["out"] } };
    const tryIt = (work) => { try { work(); return "allowed"; } catch (error) { return error.code ?? error.message; } };
    exports.nodes = [
      { ...base, type: "iso.inspect", credentialTypes: ["iso.token"],
        run: ({ config, input, credential, scope }) => ({ port: "out", data: {
          config, input, credential, scope: scope ?? null,
          env: Object.keys(process.env).filter((key) => key !== "__CF_USER_TEXT_ENCODING"),
          readSecret: tryIt(() => require("node:fs").readFileSync(${JSON.stringify(SECRET_FILE)})),
          exec: tryIt(() => require("node:child_process").execFileSync("id")),
        } }) },
      { ...base, type: "iso.wait",
        run: ({ signal, log }) => new Promise((resolve) => {
          log([{ level: "info", message: "waiting" }]);
          signal.addEventListener("abort", () => resolve({ port: "out", data: "stopped" }));
        }) },
      { ...base, type: "iso.crash", run: () => process.exit(3) },
      { ...base, type: "iso.listen", run: () => ({ port: "out", data: null }),
        listen: async ({ emit }) => {
          await emit({ key: "a", data: { n: 1 } });
          return { close: async () => {} };
        } },
      { ...base, type: "iso.ports", outPorts: () => ["x"], run: () => ({ port: "out", data: null }) },
    ];
    exports.credentialTypes = [{ type: "iso.token", label: "Iso", fields, secretFields: ["token"],
      test: async (credential) => { if (credential.data.token !== "good") throw new Error("bad token"); } }];`,
  );
}

const signal = new AbortController().signal;

function node(type: string): NodeDefinition {
  const found = registry.get(type);
  if (!found) throw new Error(`missing ${type}`);
  return found;
}

describe("community package in its own process", () => {
  const dir = mkdtempSync(join(tmpdir(), "nodes-iso-"));

  before(async () => {
    writeCommunityPackage(dir);
    process.env.ZERODOT_TEST_SECRET = "s3cret";
    const [report] = await loadInstalled(dir, [NAME]);
    assert.equal(report?.error, undefined);
    assert.deepEqual(report?.skipped, [
      { type: "iso.ports", reason: "outPorts() is not supported in a community package" },
    ]);
  });

  after(async () => {
    await unloadPackage(NAME, dir);
    delete process.env.ZERODOT_TEST_SECRET;
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs a node with no secrets, no files, and no programs", async () => {
    const credential = { type: "iso.token", data: { token: "good" } };
    const result = await node("iso.inspect").run({
      config: { mode: "info" },
      input: { a: 1 },
      credential,
      signal,
      scope: { $vars: { password: "hidden" } },
      sandbox: null,
      tables: null,
    });
    const data = result.data as Record<string, unknown>;
    assert.deepEqual(data.config, { mode: "info", checkedInPackage: true });
    assert.deepEqual(data.input, { a: 1 });
    assert.deepEqual(data.credential, credential);
    assert.equal(data.scope, null);
    assert.deepEqual(data.env, []);
    assert.equal(data.readSecret, "ERR_ACCESS_DENIED");
    assert.equal(data.exec, "ERR_ACCESS_DENIED");
  });

  it("shows the editor the schema that the package sent", async () => {
    const { catalog } = await import("./index");
    const entry = catalog.find((item) => item.type === "iso.inspect");
    assert.deepEqual(entry?.configSchema, {
      type: "object",
      properties: { mode: { type: "string", default: "info", labels: { info: "Info" } } },
    });
  });

  it("tests a credential in the package", async () => {
    const type = credentialTypeByName.get("iso.token");
    await type?.test?.({ type: "iso.token", data: { token: "good" } });
    await assert.rejects(
      async () => type?.test?.({ type: "iso.token", data: { token: "x" } }),
      /bad token/,
    );
  });

  it("passes logs back and stops a run on abort", async () => {
    const controller = new AbortController();
    const logs: string[] = [];
    const running = node("iso.wait").run({
      config: {},
      input: null,
      credential: null,
      signal: controller.signal,
      scope: {},
      sandbox: null,
      tables: null,
      log: (items) => logs.push(...items.map((item) => item.message)),
    });
    setTimeout(() => controller.abort(), 100);
    assert.deepEqual(await running, { port: "out", data: "stopped" });
    assert.deepEqual(logs, ["waiting"]);
  });

  it("gets items from a listen trigger", async () => {
    const items: PollItem[] = [];
    const ctx = {
      config: {},
      credential: null,
      workflow: { id: "w", name: "W" },
      node: { id: "n", name: "N" },
      signal,
      emit: async (item: PollItem) => {
        items.push(item);
      },
      fail: () => undefined,
    } as ListenContext;
    const handle = await node("iso.listen").listen?.(ctx);
    assert.deepEqual(items, [{ key: "a", data: { n: 1 } }]);
    await handle?.close({ remove: false });
  });

  it("starts the process again after it stopped", async () => {
    const ctx = {
      config: {},
      input: null,
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    };
    await assert.rejects(async () => node("iso.crash").run(ctx), /stopped \(code 3\)/);
    const result = await node("iso.inspect").run(ctx);
    assert.deepEqual((result.data as { env: string[] }).env, []);
  });

  it("stops the process when the package is removed", async () => {
    await unloadPackage(NAME, dir);
    assert.equal(isLoaded(NAME), false);
    assert.equal(registry.has("iso.inspect"), false);
    assert.ok(packageReports().some((report) => report.name === NAME));
    const [report] = await loadInstalled(dir, [NAME]);
    assert.equal(report?.error, undefined);
  });
});
