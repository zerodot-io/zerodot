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
  // Drivers with native code. The nodes load them with import() when they run. The worker lists them as dependencies.
  external: ["ssh2", "sharp", "imapflow", "mailparser", "basic-ftp"],
  // The bundle looks for the migrations in ../drizzle, next to dist.
  onSuccess: "rm -rf drizzle && cp -R ../../packages/db/drizzle drizzle",
});
