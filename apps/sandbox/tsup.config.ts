// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  target: "node22",
  // The @zerodot/* packages are TypeScript source. Put them in the bundle. Other packages stay external.
  noExternal: [/^@zerodot\//],
});
