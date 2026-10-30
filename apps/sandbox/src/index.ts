// SPDX-License-Identifier: AGPL-3.0-only
import { createSandboxServer } from "./server";

const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

/** One JSON line per event. Never log code or data. */
function log(msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg, ...fields }));
}

const port = number("PORT", 3002);
const server = createSandboxServer({
  maxConcurrency: number("SANDBOX_MAX_CONCURRENCY", 4),
  // A full sandbox says 503 fast. The client tries another replica.
  maxWaitMs: number("SANDBOX_MAX_WAIT_MS", 250),
  maxQueue: number("SANDBOX_MAX_QUEUE", number("SANDBOX_MAX_CONCURRENCY", 4)),
  // 0: the worker picks its own short, jittered wait. A fixed 1 s made every busy answer cost 1 s.
  retryAfterSeconds: number("SANDBOX_RETRY_AFTER_SECONDS", 0),
  maxBodyBytes: number("SANDBOX_MAX_BODY_BYTES", 10 * 1024 * 1024),
  log,
});

// The sandbox runs user code. Without Docker, set ZERODOT_BIND_HOST=127.0.0.1 so no one else can reach it.
server.listen(port, process.env.ZERODOT_BIND_HOST ?? "0.0.0.0", () =>
  log("sandbox.listening", { port }),
);

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
