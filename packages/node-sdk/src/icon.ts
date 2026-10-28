// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
};

/**
 * Reads an icon file of a package and returns it as a data URL, for `iconUrl` of a node or a
 * credential type. `from` is `import.meta.url` of the file that calls it, and `path` is relative
 * to that file, for example `fileIcon(import.meta.url, "./redis.svg")`. The icon file must be in
 * the `files` of the package.
 */
export function fileIcon(from: string, path: string): string {
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`Icon "${path}" must be .svg, .png, or .webp`);
  const file = fileURLToPath(new URL(path, from));
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}
