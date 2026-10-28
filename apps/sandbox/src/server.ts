// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type SandboxResponse, sandboxRequestSchema } from "@zerodot/engine";
import { CodeError, runCodeWithLogs } from "./run-code";

export type SandboxServerOptions = {
  /** Code that runs at the same time. More requests wait. */
  maxConcurrency: number;
  /** A request waits at most this long for a free place. Then the answer is 503. 0 means no wait. */
  maxWaitMs: number;
  /** At most this many requests wait. More get 503 at once. Default: `maxConcurrency`. */
  maxQueue?: number;
  /** The `Retry-After` header of a 503, in seconds. Default 1. */
  retryAfterSeconds?: number;
  maxBodyBytes: number;
  log?: (msg: string, fields?: Record<string, unknown>) => void;
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<string | "too-large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) return "too-large";
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type GateStats = { running: number; queued: number; rejected: number; started: number };

/**
 * A small counter that lets `maxConcurrency` callers in.
 * At most `maxQueue` callers wait, each at most `maxWaitMs`. Others get a "no" at once.
 * So the queue can never grow without a limit.
 */
export function createGate(maxConcurrency: number, maxWaitMs: number, maxQueue: number) {
  let running = 0;
  let rejected = 0;
  let started = 0;
  const waiting: (() => void)[] = [];
  const reject = () => {
    rejected++;
    return false;
  };
  return {
    async enter(): Promise<boolean> {
      if (running < maxConcurrency) {
        running++;
        started++;
        return true;
      }
      if (maxWaitMs <= 0 || waiting.length >= maxQueue) return reject();
      return new Promise<boolean>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          running++;
          started++;
          resolve(true);
        };
        const timer = setTimeout(() => {
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          resolve(reject());
        }, maxWaitMs);
        waiting.push(wake);
      });
    },
    leave() {
      running--;
      waiting.shift()?.();
    },
    stats(): GateStats {
      return { running, queued: waiting.length, rejected, started };
    },
  };
}

/** Prometheus text format. */
export function renderSandboxMetrics(stats: GateStats, maxConcurrency: number): string {
  return `${[
    "# HELP zerodot_sandbox_active Code runs that are running now.",
    "# TYPE zerodot_sandbox_active gauge",
    `zerodot_sandbox_active ${stats.running}`,
    "# HELP zerodot_sandbox_queued Requests that wait for a free place.",
    "# TYPE zerodot_sandbox_queued gauge",
    `zerodot_sandbox_queued ${stats.queued}`,
    "# HELP zerodot_sandbox_max_concurrency Code runs this sandbox can run at once.",
    "# TYPE zerodot_sandbox_max_concurrency gauge",
    `zerodot_sandbox_max_concurrency ${maxConcurrency}`,
    "# HELP zerodot_sandbox_runs_total Code runs that started since the sandbox started.",
    "# TYPE zerodot_sandbox_runs_total counter",
    `zerodot_sandbox_runs_total ${stats.started}`,
    "# HELP zerodot_sandbox_rejected_total Requests answered with 503 because the sandbox was full.",
    "# TYPE zerodot_sandbox_rejected_total counter",
    `zerodot_sandbox_rejected_total ${stats.rejected}`,
  ].join("\n")}\n`;
}

export function createSandboxServer(options: SandboxServerOptions) {
  const gate = createGate(
    options.maxConcurrency,
    options.maxWaitMs,
    options.maxQueue ?? options.maxConcurrency,
  );
  const log = options.log ?? (() => {});

  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      return send(res, 200, { ok: true, service: "sandbox" });
    }
    if (req.method === "GET" && req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      return res.end(renderSandboxMetrics(gate.stats(), options.maxConcurrency));
    }
    if (req.method !== "POST" || req.url !== "/run") return send(res, 404, {});

    const text = await readBody(req, options.maxBodyBytes);
    if (text === "too-large") {
      return send(res, 413, { error: { message: "The request is too large" } });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return send(res, 400, { error: { message: "The body is not JSON" } });
    }
    const parsed = sandboxRequestSchema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return send(res, 400, {
        error: { message: `Bad request: ${issue?.path.join(".")} ${issue?.message}` },
      });
    }

    if (!(await gate.enter())) {
      log("sandbox.rejected", gate.stats());
      return send(
        res,
        503,
        { error: { message: "The sandbox is busy" } },
        { "retry-after": String(options.retryAfterSeconds ?? 1) },
      );
    }
    const startedAt = Date.now();
    try {
      const { result, logs } = await runCodeWithLogs(parsed.data);
      send(res, 200, { result, logs } satisfies SandboxResponse);
      log("sandbox.run", { status: "ok", durationMs: Date.now() - startedAt });
    } catch (error) {
      const message = error instanceof CodeError ? error.message : "The sandbox failed";
      const logs = error instanceof CodeError ? error.logs : [];
      send(res, 200, { error: { message }, logs } satisfies SandboxResponse);
      log("sandbox.run", { status: "error", durationMs: Date.now() - startedAt });
    } finally {
      gate.leave();
    }
  });
}
