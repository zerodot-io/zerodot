// SPDX-License-Identifier: AGPL-3.0-only
import { getServices } from "@zerodot/server/services.server";
import { createApp } from "./app";

const port = Number(process.env.ZERODOT_API_PORT ?? 3003);
// Docker keeps the default. Without Docker, set ZERODOT_BIND_HOST=127.0.0.1 so only the reverse proxy can reach it.
const host = process.env.ZERODOT_BIND_HOST ?? "0.0.0.0";
const log = (msg: string, fields: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level: "info", msg, ...fields }));

// Connect and run migrations first. A bad config stops the process here.
await getServices();
const app = createApp();
await app.listen({ port, host });
log("api.listening", { port });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log("api.stopping");
  // SSE streams stay open. Close them after a short wait.
  const force = setTimeout(() => app.server.closeAllConnections(), 10_000);
  await app.close();
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
