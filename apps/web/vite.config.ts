// SPDX-License-Identifier: AGPL-3.0-only
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

// The .env file sits in the repo root. The server code reads process.env, so load it here.
Object.assign(process.env, loadEnv("development", "../..", ""));

// The editor imports the engine and node packages. Two files there use node:crypto on the server only.
// Vite stubs a Node module in the browser, and the stub throws when the file reads an export.
// This stub has the named exports, so the import works. The functions are never called in the browser.
const browserCrypto: Plugin = {
  name: "zerodot:browser-crypto",
  enforce: "pre",
  resolveId(id) {
    return id === "node:crypto" && this.environment.name === "client"
      ? "\0zerodot-crypto"
      : undefined;
  },
  load(id) {
    if (id !== "\0zerodot-crypto") return undefined;
    return [
      "const unavailable = () => { throw new Error('node:crypto is not available in the browser'); };",
      "export const createHash = unavailable;",
      "export const createHmac = unavailable;",
      "export const timingSafeEqual = unavailable;",
      "export const createPublicKey = unavailable;",
      "export const verify = unavailable;",
      "export const randomUUID = unavailable;",
      "export default { createHash, createHmac, timingSafeEqual, createPublicKey, verify, randomUUID };",
    ].join("\n");
  },
};

// Node drivers with native code or Node-only code. The nodes load them with `import()` when a node
// runs on the server. The browser never runs them, so the browser build gets an empty module.
const SERVER_ONLY_LIST = ["sharp"];
const SERVER_ONLY_MODULES = new Set(SERVER_ONLY_LIST);
const browserServerOnly: Plugin = {
  name: "zerodot:browser-server-only",
  enforce: "pre",
  resolveId(id) {
    return SERVER_ONLY_MODULES.has(id) && this.environment.name === "client"
      ? "\0zerodot-server-only"
      : undefined;
  },
  load(id) {
    return id === "\0zerodot-server-only" ? "export default {};" : undefined;
  },
};

// The API app serves these paths. In dev, Vite sends them there so the browser keeps one origin.
// In production a reverse proxy does the same (see Caddyfile).
const apiTarget = `http://localhost:${process.env.ZERODOT_API_PORT ?? 3003}`;
const apiPaths = [
  "/api/v1",
  "/api/auth",
  "/api/p",
  "/hooks",
  "/hooks-test",
  "/resume",
  "/mcp",
  "/oauth2",
];

// `vite preview` (the production web server) rejects any Host header that is not listed.
// Allow the hosts of ZERODOT_BASE_URL and ZERODOT_TRUSTED_ORIGINS.
const previewHosts = [
  process.env.ZERODOT_BASE_URL,
  ...(process.env.ZERODOT_TRUSTED_ORIGINS ?? "").split(","),
].flatMap((origin) => {
  try {
    return origin?.trim() ? [new URL(origin.trim()).hostname] : [];
  } catch {
    return [];
  }
});

export default defineConfig({
  preview: { allowedHosts: previewHosts },
  server: {
    port: 3000,
    host: true,
    allowedHosts: ["dev.softinttech.org", ".ts.net"],
    proxy: Object.fromEntries(apiPaths.map((path) => [path, { target: apiTarget }])),
  },
  resolve: { tsconfigPaths: true },
  // The server loads these at run time. The bundle must not include their native code.
  ssr: { external: SERVER_ONLY_LIST },
  plugins: [browserCrypto, browserServerOnly, tailwindcss(), tanstackStart(), viteReact()],
});
