import { defineConfig } from "tsdown";

// The engine is private, so the SDK carries the part of it that nodes use. zod stays outside:
// a node package and zerodot must share one zod.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  dts: { tsc: { eager: true } },
  clean: true,
  deps: { alwaysBundle: ["@zerodot/engine"], neverBundle: ["zod"] },
});
