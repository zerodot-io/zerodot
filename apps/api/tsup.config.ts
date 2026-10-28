// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  platform: "node",
  target: "node22",
  // The @zerodot/* packages are TypeScript source. Put them in the bundle. Other packages stay external.
  noExternal: [/^@zerodot\//],
  // The bundle looks for the migrations in ../drizzle, next to dist.
  onSuccess: "rm -rf drizzle && cp -R ../../packages/db/drizzle drizzle",
});
