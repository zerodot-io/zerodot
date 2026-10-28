// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { credentialTypeByName } from "./credentials";
import { catalog, registry } from "./index";
import {
  checkPackumentIntegrity,
  checkRegistryUrl,
  clearCatalogCache,
  createPackageSyncer,
  fetchCatalog,
  fetchRegistry,
  installedIntegrity,
  installedVersion,
  installFromNpm,
  isLoaded,
  isOfficialPackage,
  isPackageName,
  isVerified,
  loadedVersion,
  loadInstalled,
  mergeWanted,
  npmRegistry,
  onPackageUnload,
  packageEntry,
  parseCatalog,
  parseRegistry,
  parseVerified,
  pickVersion,
  type SyncLog,
  switchVersion,
  syncPackages,
  unloadPackage,
  withInstallLock,
} from "./install-packages";

const SUM_A =
  "sha512-H0D8ktokFpR1CXnubPWC8tXX0o4YM13gWrxU0FYOD1MChgxlK/CNVgJSql50IQVG82n7u86MEs/HlXsmUv6adQ==";
const SUM_B =
  "sha512-Umd2iCLuYk1I/OFexcp5y9YCy39MIVelFlVpkfIu+Me173sY0f9BxZNw77CFhlHUSpNsEbexRMSP4E3zxqPo2g==";

/** Writes the npm lock file of the nodes folder with a checksum for each package. */
function writeLock(dir: string, sums: Record<string, string>) {
  const packages = Object.fromEntries(
    Object.entries(sums).map(([name, integrity]) => [`node_modules/${name}`, { integrity }]),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
}

// A package finds zod in its own folder. The fixture imports the zod of this test instead.
const ZOD = import.meta.resolve("zod");
const ZOD_FILE = createRequire(import.meta.url).resolve("zod");

/** Writes a package like npm does into `<dir>/node_modules/<name>`. */
function writePackage(dir: string, name: string, version: string, sdk: string, type: string) {
  const root = join(dir, "node_modules", name);
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      type: "module",
      exports: { ".": "./dist/index.mjs" },
      zerodot: { sdk },
    }),
  );
  writeFileSync(
    join(root, "dist", "index.mjs"),
    `import { z } from ${JSON.stringify(ZOD)};
    export const nodes = [{
      type: ${JSON.stringify(type)}, label: "X", category: "integration", icon: "Plug",
      config: z.object({}),
      defaultConfig: {}, ports: { in: ["in"], out: ["out"] },
      run: () => ({ port: "out", data: null }),
    }];`,
  );
}

/**
 * Writes a CommonJS package like npm does. It uses a dependency of its own in the folder, and
 * `label` shows which version runs. The dependency counts how often it was read from disk.
 */
function writeCjsPackage(
  dir: string,
  name: string,
  version: string,
  options: { type: string; label: string; credential?: string },
) {
  const root = join(dir, "node_modules", name);
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "dep-counter"), { recursive: true });
  writeFileSync(
    join(dir, "node_modules", "dep-counter", "package.json"),
    JSON.stringify({ name: "dep-counter", version: "1.0.0", main: "index.js" }),
  );
  writeFileSync(
    join(dir, "node_modules", "dep-counter", "index.js"),
    "globalThis.__depReads = (globalThis.__depReads ?? 0) + 1;\nmodule.exports = { reads: globalThis.__depReads };",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name,
      version,
      main: "./dist/index.cjs",
      exports: { ".": "./dist/index.cjs" },
      zerodot: { sdk: "^1.0" },
    }),
  );
  const credential = options.credential
    ? `exports.credentialTypes = [{ type: ${JSON.stringify(options.credential)}, label: ${JSON.stringify(options.label)}, fields: z.object({}), secretFields: [] }];`
    : "";
  writeFileSync(
    join(root, "dist", "index.cjs"),
    `const { z } = require(${JSON.stringify(ZOD_FILE)});
    const dep = require("dep-counter");
    exports.nodes = [{
      type: ${JSON.stringify(options.type)}, label: ${JSON.stringify(options.label)} + dep.reads,
      category: "integration", icon: "Plug", config: z.object({}),
      defaultConfig: {}, ports: { in: ["in"], out: ["out"] },
      run: () => ({ port: "out", data: null }),
    }];
    ${credential}`,
  );
}

describe("pickVersion", () => {
  it("takes the newest version that fits, and skips pre-releases", () => {
    const packument = {
      versions: {
        "1.0.0": { zerodot: { sdk: "^1.0" } },
        "1.2.0": { zerodot: { sdk: "^1.0" } },
        "1.10.0": { zerodot: { sdk: "^1.0" } },
        "2.0.0": { zerodot: { sdk: "^2.0" } },
        "1.11.0-beta.1": { zerodot: { sdk: "^1.0" } },
        "0.9.0": {},
      },
    };
    assert.equal(pickVersion(packument, "1.0.0"), "1.10.0");
    assert.equal(pickVersion(packument, "2.0.0"), "2.0.0");
    assert.equal(pickVersion(packument, "3.0.0"), null);
    assert.equal(pickVersion({}, "1.0.0"), null);
  });
});

describe("isOfficialPackage", () => {
  it("allows @zerodot/* only", () => {
    assert.equal(isOfficialPackage("@zerodot/redis"), true);
    assert.equal(isOfficialPackage("@zerodot/redis/../x"), false);
    assert.equal(isOfficialPackage("@evil/redis"), false);
    assert.equal(isOfficialPackage("redis"), false);
    assert.equal(isOfficialPackage("@zerodot/"), false);
  });
});

describe("packages in the nodes folder", () => {
  it("finds the entry file and the version", () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    try {
      writePackage(dir, "@zerodot/demo", "1.2.3", "^1.0", "demo.one");
      assert.equal(installedVersion(dir, "@zerodot/demo"), "1.2.3");
      assert.equal(installedVersion(dir, "@zerodot/none"), null);
      assert.equal(
        packageEntry(dir, "@zerodot/demo"),
        join(dir, "node_modules", "@zerodot/demo", "dist", "index.mjs"),
      );
      assert.throws(() => packageEntry(dir, "@zerodot/none"), /not installed/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("loads once, and unloads", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    try {
      writePackage(dir, "@zerodot/demo-load", "1.0.0", "^1.0", "demo.load");
      const [first] = await loadInstalled(dir, ["@zerodot/demo-load"]);
      assert.deepEqual(first?.added, ["demo.load"]);
      assert.equal(registry.has("demo.load"), true);
      assert.equal(isLoaded("@zerodot/demo-load"), true);
      assert.deepEqual(await loadInstalled(dir, ["@zerodot/demo-load"]), []);
      await unloadPackage("@zerodot/demo-load");
      assert.equal(registry.has("demo.load"), false);
      assert.equal(isLoaded("@zerodot/demo-load"), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("refuses a package that needs another contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    try {
      writePackage(dir, "@zerodot/demo-new", "1.0.0", "^9.0", "demo.new");
      const [report] = await loadInstalled(dir, ["@zerodot/demo-new"]);
      assert.match(report?.error ?? "", /needs node contract \^9\.0/);
      assert.equal(registry.has("demo.new"), false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("upgrade in the same process", () => {
  const name = "@zerodot/demo-cjs";
  const labelOf = (type: string) => catalog.find((entry) => entry.type === type)?.label;

  it("runs the new code and frees the old code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    try {
      writeCjsPackage(dir, name, "1.0.0", {
        type: "demo.cjs",
        label: "one-",
        credential: "demo.cred",
      });
      const [first] = await loadInstalled(dir, [name]);
      assert.deepEqual(first?.added, ["demo.cjs"]);
      assert.equal(loadedVersion(name), "1.0.0");
      assert.equal(credentialTypeByName.get("demo.cred")?.label, "one-");
      const before = globalThis as { __depReads?: number };
      const reads = before.__depReads ?? 0;

      writeCjsPackage(dir, name, "1.1.0", {
        type: "demo.cjs",
        label: "two-",
        credential: "demo.cred",
      });
      const [second] = await loadInstalled(dir, [name]);
      assert.deepEqual(second?.added, ["demo.cjs"]);
      assert.equal(loadedVersion(name), "1.1.0");
      // The node, its catalog entry, and its credential type come from the new files.
      assert.equal(labelOf("demo.cjs"), `two-${reads + 1}`);
      assert.equal(registry.get("demo.cjs")?.label, `two-${reads + 1}`);
      assert.equal(credentialTypeByName.get("demo.cred")?.label, "two-");
      assert.equal(catalog.filter((entry) => entry.type === "demo.cjs").length, 1);

      await unloadPackage(name, dir);
      assert.equal(registry.has("demo.cjs"), false);
      assert.equal(credentialTypeByName.has("demo.cred"), false);
      const cache = createRequire(join(dir, "package.json")).cache;
      assert.deepEqual(
        Object.keys(cache).filter((file) => file.startsWith(realpathSync(dir))),
        [],
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not load again when the version is the same", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    try {
      writeCjsPackage(dir, "@zerodot/demo-same", "1.0.0", { type: "demo.same", label: "x" });
      await loadInstalled(dir, ["@zerodot/demo-same"]);
      assert.deepEqual(await loadInstalled(dir, ["@zerodot/demo-same"]), []);
      await unloadPackage("@zerodot/demo-same", dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("tells hooks which nodes go, and removes a package that fails to load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    const seen: string[] = [];
    const off = onPackageUnload((who, types) => {
      seen.push(`${who}:${types.join(",")}`);
    });
    try {
      writeCjsPackage(dir, "@zerodot/demo-hook", "1.0.0", { type: "demo.hook", label: "x" });
      await loadInstalled(dir, ["@zerodot/demo-hook"]);
      writeCjsPackage(dir, "@zerodot/demo-hook", "1.1.0", { type: "demo.hook", label: "y" });
      // The new files are broken: the package must not stay half loaded.
      writeFileSync(
        join(dir, "node_modules", "@zerodot", "demo-hook", "dist", "index.cjs"),
        "throw new Error('boom');",
      );
      const [report] = await loadInstalled(dir, ["@zerodot/demo-hook"]);
      assert.match(report?.error ?? "", /boom/);
      assert.deepEqual(seen, ["@zerodot/demo-hook:demo.hook"]);
      assert.equal(registry.has("demo.hook"), false);
      assert.equal(isLoaded("@zerodot/demo-hook"), false);
    } finally {
      off();
      rmSync(dir, { recursive: true });
    }
  });

  it("installs an older version when the wanted version is older", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    const installed: string[] = [];
    try {
      writeCjsPackage(dir, "@zerodot/demo-down", "1.2.0", { type: "demo.down", label: "x" });
      const { versions } = await syncPackages(
        dir,
        [{ name: "@zerodot/demo-down", version: "1.1.0" }],
        {
          install: async (folder, pkg, version) => {
            installed.push(`${pkg}@${version}`);
            writeCjsPackage(folder, pkg, version, { type: "demo.down", label: "x" });
          },
        },
      );
      assert.deepEqual(installed, ["@zerodot/demo-down@1.1.0"]);
      assert.equal(versions["@zerodot/demo-down"], "1.1.0");
      assert.equal(loadedVersion("@zerodot/demo-down"), "1.1.0");
      await unloadPackage("@zerodot/demo-down", dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("switchVersion", () => {
  const name = "@zerodot/demo-switch";

  it("loads the new version, and puts the old one back when it fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    const installs: string[] = [];
    const install = (broken: string) => async (folder: string, pkg: string, version: string) => {
      installs.push(version);
      writeCjsPackage(folder, pkg, version, { type: "demo.switch", label: `v${version}-` });
      if (version === broken) {
        writeFileSync(
          join(folder, "node_modules", pkg, "dist", "index.cjs"),
          "throw new Error('does not start');",
        );
      }
    };
    try {
      writeCjsPackage(dir, name, "1.0.0", { type: "demo.switch", label: "v1.0.0-" });
      await loadInstalled(dir, [name]);

      const up = await switchVersion(dir, name, "1.1.0", { install: install("none") });
      assert.deepEqual(up.added, ["demo.switch"]);
      assert.equal(loadedVersion(name), "1.1.0");

      await assert.rejects(
        switchVersion(dir, name, "1.2.0", { install: install("1.2.0") }),
        /does not start/,
      );
      assert.deepEqual(installs, ["1.1.0", "1.2.0", "1.1.0"]);
      assert.equal(loadedVersion(name), "1.1.0");
      assert.equal(installedVersion(dir, name), "1.1.0");
      assert.equal(registry.has("demo.switch"), true);

      // Going down works the same way.
      await switchVersion(dir, name, "1.0.0", { install: install("none") });
      assert.equal(loadedVersion(name), "1.0.0");
      await unloadPackage(name, dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("syncPackages", () => {
  it("installs what is missing, keeps what is there, and reports failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-nodes-"));
    const installed: string[] = [];
    try {
      writePackage(dir, "@zerodot/demo-have", "1.0.0", "^1.0", "demo.have");
      const result = await syncPackages(
        dir,
        [
          { name: "@zerodot/demo-have" },
          { name: "@zerodot/demo-get" },
          { name: "@zerodot/demo-fail", version: "1.0.0" },
          { name: "../evil" },
        ],
        {
          resolve: async () => "1.4.0",
          install: async (folder, name, version) => {
            installed.push(`${name}@${version}`);
            if (name === "@zerodot/demo-fail") throw new Error("npm failed: offline");
            writePackage(folder, name, version, "^1.0", "demo.get");
          },
        },
      );
      assert.deepEqual(installed, ["@zerodot/demo-get@1.4.0", "@zerodot/demo-fail@1.0.0"]);
      assert.deepEqual(result.versions, {
        "@zerodot/demo-have": "1.0.0",
        "@zerodot/demo-get": "1.4.0",
      });
      const byName = Object.fromEntries(result.reports.map((r) => [r.name, r]));
      assert.match(byName["@zerodot/demo-fail"]?.error ?? "", /offline/);
      assert.match(byName["../evil"]?.error ?? "", /not a valid package name/);
      assert.deepEqual(byName["@zerodot/demo-have"]?.added, ["demo.have"]);
      assert.deepEqual(byName["@zerodot/demo-get"]?.added, ["demo.get"]);
    } finally {
      await unloadPackage("@zerodot/demo-have");
      await unloadPackage("@zerodot/demo-get");
      rmSync(dir, { recursive: true });
    }
  });
});

describe("catalog", () => {
  it("keeps good entries and drops the rest", () => {
    const packages = parseCatalog({
      packages: [
        {
          name: "@zerodot/redis",
          label: "Redis",
          summary: "s",
          description: "d",
          version: "1.0.0",
          sdk: "^1.0",
          nodes: [{ type: "redis.database", label: "Redis" }, { label: "no type" }],
        },
        { name: "@evil/x", version: "1.0.0", sdk: "^1.0" },
        { name: "@zerodot/nover", sdk: "^1.0" },
        {
          name: "@zerodot/icons",
          version: "1.0.0",
          sdk: "^1.0",
          icon: "Database",
          iconUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        },
        { name: "@zerodot/remote", version: "1.0.0", sdk: "^1.0", iconUrl: "https://x/i.svg" },
      ],
    });
    assert.deepEqual(
      packages.map((p) => p.name),
      ["@zerodot/redis", "@zerodot/icons", "@zerodot/remote"],
    );
    assert.equal(packages[0]?.summary, "s");
    assert.equal(packages[1]?.summary, "");
    assert.equal(packages[1]?.icon, "Database");
    assert.match(packages[1]?.iconUrl ?? "", /^data:image\/svg\+xml/);
    assert.equal(packages[2]?.iconUrl, undefined);
    assert.deepEqual(packages[0]?.nodes, [{ type: "redis.database", label: "Redis" }]);
    assert.throws(() => parseCatalog({}), /no "packages"/);
  });

  it("is cached, and reports a bad answer", async () => {
    clearCatalogCache();
    let calls = 0;
    const ok = (async () => {
      calls++;
      return new Response(JSON.stringify({ packages: [] }));
    }) as typeof fetch;
    await fetchCatalog("https://x/c.json", ok, 1000);
    await fetchCatalog("https://x/c.json", ok, 2000);
    assert.equal(calls, 1);
    await fetchCatalog("https://x/c.json", ok, 1000 + 11 * 60_000);
    assert.equal(calls, 2);
    clearCatalogCache();
    const bad = (async () => new Response("no", { status: 404 })) as typeof fetch;
    await assert.rejects(() => fetchCatalog("https://x/c.json", bad), /status 404/);
  });

  it("merges the env list and the installed list", () => {
    assert.deepEqual(
      mergeWanted(
        ["@zerodot/a"],
        [
          { name: "@zerodot/a", version: "1.0.0" },
          { name: "@zerodot/b", version: "2.0.0" },
        ],
      ),
      [{ name: "@zerodot/a" }, { name: "@zerodot/b", version: "2.0.0" }],
    );
  });
});

describe("withInstallLock", () => {
  it("runs one job at a time, and takes over a stale lock", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zerodot-lock-"));
    try {
      const order: string[] = [];
      const job = (name: string) =>
        withInstallLock(
          dir,
          async () => {
            order.push(`${name}:start`);
            await new Promise((done) => setTimeout(done, 40));
            order.push(`${name}:end`);
          },
          { pollMs: 5 },
        );
      await Promise.all([job("a"), job("b")]);
      assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);

      mkdirSync(join(dir, ".install-lock"));
      await assert.rejects(
        () => withInstallLock(dir, async () => undefined, { waitMs: 30, pollMs: 5 }),
        /Another install/,
      );
      assert.equal(await withInstallLock(dir, async () => "ok", { staleMs: -1 }), "ok");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("createPackageSyncer", () => {
  it("logs each report and never throws", async () => {
    const logs: string[] = [];
    const log: SyncLog = (level, message) => logs.push(`${level}:${message}`);
    const dir = mkdtempSync(join(tmpdir(), "zerodot-sync-"));
    try {
      const sync = createPackageSyncer(async () => [{ name: "../evil" }], log, dir);
      await sync();
      assert.deepEqual(logs, ["error:nodes.package"]);
      const broken = createPackageSyncer(
        async () => {
          throw new Error("db down");
        },
        log,
        dir,
      );
      await broken();
      assert.equal(logs.at(-1), "error:nodes.sync_failed");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("isPackageName", () => {
  it("allows npm names and refuses paths and options", () => {
    assert.equal(isPackageName("@acme/zerodot-slack"), true);
    assert.equal(isPackageName("zerodot-nodes-x"), true);
    assert.equal(isPackageName("-x"), false);
    assert.equal(isPackageName("@acme/../x"), false);
    assert.equal(isPackageName("../x"), false);
    assert.equal(isPackageName("Upper"), false);
    assert.equal(isPackageName("a b"), false);
  });
});

describe("community registry", () => {
  const entry = (name: string) => ({
    name,
    version: "1.0.0",
    sdk: "^1.0",
    integrity: SUM_A,
    nodes: [],
  });

  it("keeps zerodot-* names only, and drops @zerodot/*, bad versions, and repeated names", () => {
    const registry = parseRegistry({
      name: "Acme",
      homepage: "javascript:alert(1)",
      packages: [
        entry("@acme/zerodot-slack"),
        entry("zerodot-mail"),
        entry("@acme/slack"),
        entry("zerodot"),
        entry("@zerodot/redis"),
        entry("@acme/zerodot-slack"),
        { ...entry("@acme/zerodot-beta"), version: "1.0.0-beta.1" },
        entry("-rf"),
        { ...entry("zerodot-no-sum"), integrity: undefined },
        { ...entry("zerodot-bad-sum"), integrity: "md5-abc" },
      ],
    });
    assert.equal(registry.name, "Acme");
    assert.equal(registry.homepage, null);
    assert.deepEqual(
      registry.packages.map((item) => item.name),
      ["@acme/zerodot-slack", "zerodot-mail"],
    );
    assert.throws(() => parseRegistry({ packages: [] }), /no "name"/);
  });

  it("allows https addresses only", () => {
    assert.equal(checkRegistryUrl(" https://x.dev/r.json#a "), "https://x.dev/r.json");
    assert.throws(() => checkRegistryUrl("http://x.dev/r.json"), /https/);
    assert.throws(() => checkRegistryUrl("file:///etc/passwd"), /https/);
    assert.throws(() => checkRegistryUrl("https://u:p@x.dev/r.json"), /password/);
    assert.throws(() => checkRegistryUrl("nope"), /not a valid URL/);
  });

  it("refuses redirects and large files, and caches by address", async () => {
    clearCatalogCache();
    const seen: RequestInit[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ name: "A", packages: [entry("@a/zerodot-x")] }));
    }) as typeof fetch;
    await fetchRegistry("https://a.dev/r.json", ok, 1000);
    await fetchRegistry("https://a.dev/r.json", ok, 2000);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.redirect, "error");
    const big = (async () => new Response("x".repeat(1_000_001))) as typeof fetch;
    await assert.rejects(fetchRegistry("https://b.dev/r.json", big), /larger than 1 MB/);
    const bad = (async () => new Response("{")) as typeof fetch;
    await assert.rejects(fetchRegistry("https://c.dev/r.json", bad), /not valid JSON/);
  });
});

describe("npmRegistry", () => {
  it("uses npm, or the address in ZERODOT_NPM_REGISTRY", () => {
    assert.equal(npmRegistry({}), "https://registry.npmjs.org");
    assert.equal(
      npmRegistry({ ZERODOT_NPM_REGISTRY: " http://localhost:4873/ " }),
      "http://localhost:4873",
    );
  });
});

describe("checksums", () => {
  it("reads the checksum that npm wrote, and compares it with npm", () => {
    const dir = mkdtempSync(join(tmpdir(), "nodes-sum-"));
    try {
      assert.equal(installedIntegrity(dir, "zerodot-x"), null);
      writeLock(dir, { "zerodot-x": SUM_A });
      assert.equal(installedIntegrity(dir, "zerodot-x"), SUM_A);
    } finally {
      rmSync(dir, { recursive: true });
    }
    const packument = { versions: { "1.0.0": { dist: { integrity: SUM_A } } } };
    assert.doesNotThrow(() => checkPackumentIntegrity(packument, "zerodot-x", "1.0.0", SUM_A));
    assert.throws(
      () => checkPackumentIntegrity(packument, "zerodot-x", "1.0.0", SUM_B),
      /checksum of zerodot-x@1.0.0 on npm is not the one in the registry/,
    );
    assert.throws(
      () => checkPackumentIntegrity(packument, "zerodot-x", "2.0.0", SUM_A),
      /checksum/,
    );
  });

  it("removes a package that npm installed with another checksum", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodes-sum-"));
    const calls: string[] = [];
    const runner = async (args: string[]) => {
      calls.push(args[0] ?? "");
      if (args[0] === "install") {
        writePackage(dir, "zerodot-x", "1.0.0", "^1.0", "x.one");
        writeLock(dir, { "zerodot-x": SUM_B });
      }
    };
    try {
      await assert.rejects(
        installFromNpm(dir, "zerodot-x", "1.0.0", runner, SUM_A),
        /another checksum than the registry has/,
      );
      assert.deepEqual(calls, ["install", "uninstall"]);
      assert.equal(installedVersion(dir, "zerodot-x"), null);
      await installFromNpm(dir, "zerodot-x", "1.0.0", runner, SUM_B);
      assert.equal(installedVersion(dir, "zerodot-x"), "1.0.0");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("installs again at start when the files on disk have another checksum", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nodes-sum-"));
    const installs: string[] = [];
    try {
      writePackage(dir, "@zerodot/demo-sum", "1.0.0", "^1.0", "demo.sum");
      writeLock(dir, { "@zerodot/demo-sum": SUM_B });
      await syncPackages(dir, [{ name: "@zerodot/demo-sum", version: "1.0.0", integrity: SUM_A }], {
        install: async (_dir, name, version, _runner, integrity) => {
          installs.push(`${name}@${version}:${integrity === SUM_A}`);
          writeLock(dir, { [name]: SUM_A });
        },
      });
      assert.deepEqual(installs, ["@zerodot/demo-sum@1.0.0:true"]);
      await unloadPackage("@zerodot/demo-sum", dir);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("verified list", () => {
  it("keeps reviewed versions with a checksum, and matches all three parts", () => {
    const list = parseVerified({
      packages: [
        {
          name: "zerodot-slack",
          version: "1.2.0",
          integrity: SUM_A,
          source: "https://github.com/a/b",
        },
        { name: "zerodot-slack", version: "1.3.0" },
        { name: "@zerodot/redis", version: "1.0.0", integrity: SUM_A },
        { name: "zerodot-x", version: "1.0.0", integrity: SUM_A, source: "javascript:x" },
      ],
    });
    assert.deepEqual(list, [
      {
        name: "zerodot-slack",
        version: "1.2.0",
        integrity: SUM_A,
        source: "https://github.com/a/b",
      },
      { name: "zerodot-x", version: "1.0.0", integrity: SUM_A },
    ]);
    assert.equal(isVerified(list, "zerodot-slack", "1.2.0", SUM_A), true);
    assert.equal(isVerified(list, "zerodot-slack", "1.2.0", SUM_B), false);
    assert.equal(isVerified(list, "zerodot-slack", "1.3.0", SUM_A), false);
    assert.equal(isVerified(list, "zerodot-slack", "1.2.0", undefined), false);
    assert.throws(() => parseVerified({}), /no "packages"/);
  });
});
