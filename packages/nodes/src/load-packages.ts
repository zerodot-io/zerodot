// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CredentialTypeDefinition, NodeDefinition } from "@zerodot/engine";
import { SDK_VERSION, satisfiesSdk } from "@zerodot/node-sdk";
import { credentialTypeByName, registerCredentialType } from "./credentials";
import { registerNodes } from "./index";

export type NodePackageReport = {
  name: string;
  /** Node types that were added. */
  added: string[];
  /** Node types that were left out, with the reason. */
  skipped: { type: string; reason: string }[];
  /** Credential types that were added. */
  credentialTypes: string[];
  /** Why the whole package did not load. */
  error?: string;
};

/** Splits `ZERODOT_NODE_PACKAGES`: package names or paths, separated by commas. */
export function parseNodePackages(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** Why a value from a package cannot be a node. Null when it can. */
function problemWith(value: unknown): string | null {
  const node = value as Partial<NodeDefinition> | null;
  if (typeof node !== "object" || node === null) return "not an object";
  if (typeof node.type !== "string" || node.type === "") return "no type";
  if (typeof node.label !== "string") return "no label";
  if (typeof node.run !== "function") return "no run()";
  if (typeof node.config !== "object" || node.config === null) return "no config schema";
  if (typeof node.ports !== "object" || node.ports === null) return "no ports";
  if (node.category === "trigger" && node.type.startsWith("trigger.") === false) {
    return 'a trigger type starts with "trigger."';
  }
  return null;
}

/** True when a value from a package has the parts of a credential type. */
function isCredentialType(value: unknown): value is CredentialTypeDefinition {
  const type = value as Partial<CredentialTypeDefinition> | null;
  return (
    typeof type === "object" &&
    type !== null &&
    typeof type.type === "string" &&
    type.type !== "" &&
    typeof type.label === "string" &&
    typeof type.fields === "object" &&
    type.fields !== null &&
    Array.isArray(type.secretFields)
  );
}

type Importer = (name: string) => Promise<Record<string, unknown>>;

/** The `zerodot` field of a package.json. Read without running package code. */
export type PackageManifest = { sdk?: string };
export type ManifestReader = (name: string) => PackageManifest | null;

/**
 * Reads `package.json` of a package: a path, or a name found in `node_modules` of the working
 * folder or a folder above it. Returns null when there is no such package.
 */
export const readManifestFromDisk: ManifestReader = (name) => {
  const dirs: string[] = [];
  if (name.startsWith(".") || isAbsolute(name)) {
    dirs.push(resolve(name));
  } else {
    for (let dir = process.cwd(); ; dir = dirname(dir)) {
      dirs.push(join(dir, "node_modules", name));
      if (dirname(dir) === dir) break;
    }
  }
  const file = dirs.map((dir) => join(dir, "package.json")).find((path) => existsSync(path));
  if (!file) return null;
  const json = JSON.parse(readFileSync(file, "utf8")) as { zerodot?: PackageManifest };
  return json.zerodot ?? {};
};

/**
 * Loads node packages (for example `@zerodot/redis`) and adds their nodes. The `package.json` of
 * a package has `zerodot.sdk`, the range of node contract versions it works with (for example
 * "^1.4"). It is checked before the package code runs, and a package with another range is not
 * loaded. The code exports `nodes`, a list of node definitions, and optional `credentialTypes`.
 * A node type that exists is not replaced, so a package cannot take over a built-in node. A
 * package that fails does not stop the others.
 */
export async function loadNodePackages(
  names: string[],
  importer: Importer = (name) => import(/* @vite-ignore */ name),
  readManifest: ManifestReader = readManifestFromDisk,
): Promise<NodePackageReport[]> {
  const reports: NodePackageReport[] = [];
  for (const name of names) {
    const report: NodePackageReport = { name, added: [], skipped: [], credentialTypes: [] };
    reports.push(report);
    let list: unknown;
    let credentialTypes: unknown;
    try {
      const manifest = readManifest(name);
      if (manifest === null) throw new Error(`Cannot find package "${name}"`);
      const sdk = manifest.sdk;
      if (typeof sdk !== "string" || sdk === "") {
        report.error = 'The package.json has no "zerodot.sdk", the contract versions it works with';
        continue;
      }
      if (!satisfiesSdk(sdk)) {
        report.error = `The package needs node contract ${sdk}. This zerodot has ${SDK_VERSION}`;
        continue;
      }
      const loaded = await importer(name);
      const fallback = loaded.default as { nodes?: unknown } | undefined;
      list = loaded.nodes ?? fallback?.nodes;
      credentialTypes = loaded.credentialTypes;
    } catch (error) {
      report.error = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!Array.isArray(list)) {
      report.error = 'The package does not export a list named "nodes"';
      continue;
    }
    // Credential types go in first, so a node can use one from its own package.
    if (Array.isArray(credentialTypes)) {
      for (const entry of credentialTypes) {
        if (isCredentialType(entry) === false) {
          report.skipped.push({
            type: String((entry as { type?: unknown })?.type ?? "?"),
            reason: "not a credential type",
          });
        } else if (credentialTypeByName.has(entry.type)) {
          report.skipped.push({ type: entry.type, reason: "credential type exists" });
        } else {
          registerCredentialType(entry);
          report.credentialTypes.push(entry.type);
        }
      }
    }
    const valid: NodeDefinition[] = [];
    for (const entry of list) {
      const problem = problemWith(entry);
      if (problem) {
        report.skipped.push({
          type: String((entry as { type?: unknown })?.type ?? "?"),
          reason: problem,
        });
      } else {
        valid.push(entry as NodeDefinition);
      }
    }
    const added = new Set(registerNodes(valid));
    report.added = [...added];
    for (const node of valid) {
      if (!added.has(node.type)) report.skipped.push({ type: node.type, reason: "type exists" });
    }
  }
  return reports;
}
