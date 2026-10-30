// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as sdk from "@zerodot/node-sdk";
import { kept } from "./kept";

const SDK = "@zerodot/node-sdk";
const KEY = "zerodot.nodes.sdk";

/** The `node_modules` folders whose packages get the SDK of zerodot, as file URLs. */
const linked = kept("sdkLinked", () => new Set<string>());
const state = kept("sdkLink", () => ({ registered: false }));

/**
 * Makes `@zerodot/node-sdk` in a package of `dir` the SDK of this zerodot, not the copy that npm
 * put in the nodes folder. A process keeps the first copy it loads, so a copy that npm updates
 * later (for example when a package needs a newer SDK) would not load until a restart. With this
 * link, each package gets the contract that zerodot checks with `satisfiesSdk`.
 *
 * Only packages in this process use it. A community package runs in its own process.
 * It does nothing on a Node.js version without `module.registerHooks`.
 */
export function linkSdk(dir: string): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for(KEY)] = sdk;
  for (const path of [dir, safeRealpath(dir)]) {
    linked.add(`${pathToFileURL(join(path, "node_modules")).href}/`);
  }
  if (state.registered || typeof nodeModule.registerHooks !== "function") return;
  state.registered = true;
  let files: { cjs: string; esm: string };
  try {
    files = writeShims();
  } catch (error) {
    // Packages then get the copy in the nodes folder, as before.
    console.error("[nodes] Cannot link the node SDK:", error);
    return;
  }
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (specifier !== SDK || !parent || ![...linked].some((url) => parent.startsWith(url))) {
        return nextResolve(specifier, context);
      }
      const required = context.conditions?.includes("require") ?? false;
      return {
        url: required ? files.cjs : files.esm,
        format: required ? "commonjs" : "module",
        shortCircuit: true,
      };
    },
  });
}

/**
 * Small files that give the SDK of this process. Real files, so each loader (Node.js, tsx) can
 * read them. A CommonJS package gets the object, an ES module gets one export for each name.
 */
function writeShims(): { cjs: string; esm: string } {
  const folder = mkdtempSync(join(tmpdir(), "zerodot-sdk-"));
  const read = `globalThis[Symbol.for(${JSON.stringify(KEY)})]`;
  const names = Object.keys(sdk).filter(
    (name) => name !== "default" && /^[A-Za-z_$][\w$]*$/.test(name),
  );
  const cjs = join(folder, "node-sdk.cjs");
  const esm = join(folder, "node-sdk.mjs");
  writeFileSync(cjs, `module.exports = ${read};\n`);
  writeFileSync(
    esm,
    [
      `const sdk = ${read};`,
      ...names.map((name) => `export const ${name} = sdk.${name};`),
      "export default sdk;",
      "",
    ].join("\n"),
  );
  return { cjs: pathToFileURL(cjs).href, esm: pathToFileURL(esm).href };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
