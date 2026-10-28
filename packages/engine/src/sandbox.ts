// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/** The contract between the worker (client) and apps/sandbox (server). */

export const SANDBOX_MAX_CODE_CHARS = 200_000;
export const SANDBOX_MAX_TIMEOUT_MS = 60_000;

export const sandboxRequestSchema = z.object({
  code: z.string().min(1).max(SANDBOX_MAX_CODE_CHARS),
  /** Names the code can read, for example `$input` and `$vars`. Plain JSON values only. */
  scope: z.record(z.string(), z.unknown()),
  timeoutMs: z.number().int().min(1).max(SANDBOX_MAX_TIMEOUT_MS),
  maxOutputBytes: z.number().int().min(1).optional(),
});

export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;

export const SANDBOX_LOG_LEVELS = ["log", "info", "warn", "error", "debug"] as const;

/** One `console` call in the code. */
export type CodeLog = { level: (typeof SANDBOX_LOG_LEVELS)[number]; message: string };

/** The sandbox keeps at most this many logs of one run, and this many characters of each. */
export const SANDBOX_MAX_LOGS = 100;
export const SANDBOX_MAX_LOG_CHARS = 2000;

export type SandboxResponse =
  | { result: unknown; logs?: CodeLog[] }
  | { error: { message: string }; logs?: CodeLog[] };

export class SandboxError extends Error {}

export type SandboxClient = {
  /**
   * Resolves with the value the code returned. Throws `SandboxError` when the code fails.
   * `onLogs` gets the `console` calls of the code, also when the code fails.
   */
  run(
    request: SandboxRequest,
    signal: AbortSignal,
    onLogs?: (logs: CodeLog[]) => void,
  ): Promise<unknown>;
};

export type SandboxClientOptions = {
  /** The client tries other replicas for at most this long when all are full. Default 30 s. */
  busyDeadlineMs?: number;
  /** The most tries for one run. Default 10. */
  maxAttempts?: number;
  /** Wait before try n+1 is random between 0 and min(backoffMaxMs, backoffBaseMs * 2^n). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** A replica that did not connect is not used for this long, if another one is up. Default 5 s. */
  cooldownMs?: number;
  /** How long the client keeps the addresses of a host name. Default 5 s. */
  dnsTtlMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
};

type Endpoint = { url: string; inflight: number; downUntil: number };
type Failure = { kind: "busy" | "unreachable"; retryAfterMs?: number };

/** 4, 6, or 0 when the text is a host name. Not `node:net`, so browser bundles stay clean. */
function isIP(host: string): 0 | 4 | 6 {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return 4;
  return host.includes(":") ? 6 : 0;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  // Loaded when needed: only the worker resolves host names.
  const { lookup } = await import("node:dns/promises");
  const found = await lookup(hostname, { all: true });
  return [...new Set(found.map((entry) => entry.address))];
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** `Retry-After` in seconds (the only form the sandbox sends). */
function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/**
 * `target` is one URL or a comma-separated list of URLs.
 * A host name that has many addresses (Docker DNS for a scaled service) counts as many replicas.
 * The client sends each run to the replica with the fewest runs in flight. Equal replicas take turns.
 * When a replica is full (503, 429) or does not connect, the client waits a random time
 * and tries again, on another replica if it can. It gives up after `busyDeadlineMs`.
 */
export function createSandboxClient(
  target: string | string[],
  options: SandboxClientOptions = {},
): SandboxClient {
  const bases = (Array.isArray(target) ? target : target.split(","))
    .map((entry) => entry.trim().replace(/\/$/, ""))
    .filter((entry) => entry.length > 0);
  if (bases.length === 0) throw new SandboxError("The code sandbox URL is empty");

  const fetchFn = options.fetch ?? fetch;
  const resolve = options.resolve ?? defaultResolve;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const busyDeadlineMs = options.busyDeadlineMs ?? 30_000;
  const maxAttempts = options.maxAttempts ?? 10;
  const backoffBaseMs = options.backoffBaseMs ?? 100;
  const backoffMaxMs = options.backoffMaxMs ?? 2000;
  const cooldownMs = options.cooldownMs ?? 5000;
  const dnsTtlMs = options.dnsTtlMs ?? 5000;

  // The state of a replica lives as long as the client, so the counts stay right when DNS refreshes.
  const known = new Map<string, Endpoint>();
  const endpointFor = (url: string): Endpoint => {
    let endpoint = known.get(url);
    if (!endpoint) {
      endpoint = { url, inflight: 0, downUntil: 0 };
      known.set(url, endpoint);
    }
    return endpoint;
  };
  const dnsCache = new Map<string, { expires: number; urls: string[] }>();
  let turn = 0;

  async function expand(base: string): Promise<string[]> {
    let parsed: URL;
    try {
      parsed = new URL(base);
    } catch {
      throw new SandboxError(`The code sandbox URL is not valid: ${base}`);
    }
    // Only plain HTTP: with HTTPS the address would not match the certificate.
    if (
      parsed.protocol !== "http:" ||
      parsed.hostname === "localhost" ||
      isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0
    ) {
      return [base];
    }
    const cached = dnsCache.get(base);
    if (cached && cached.expires > now()) return cached.urls;
    let addresses: string[] = [];
    try {
      addresses = await resolve(parsed.hostname);
    } catch {
      // Keep the old addresses, or use the name and let fetch fail if it must.
      return cached?.urls ?? [base];
    }
    const urls = addresses.map((address) => {
      const copy = new URL(base);
      copy.hostname = isIP(address) === 6 ? `[${address}]` : address;
      return copy.toString().replace(/\/$/, "");
    });
    const result = urls.length > 0 ? urls : [base];
    dnsCache.set(base, { expires: now() + dnsTtlMs, urls: result });
    return result;
  }

  async function pick(): Promise<Endpoint> {
    const lists = await Promise.all(bases.map(expand));
    const endpoints = [...new Set(lists.flat())].map(endpointFor);
    const start = turn++ % endpoints.length;
    const rotated = [...endpoints.slice(start), ...endpoints.slice(0, start)];
    const time = now();
    const rank = (endpoint: Endpoint) => (endpoint.downUntil > time ? 1 : 0);
    // Array.sort is stable, so equal replicas keep the rotated order.
    rotated.sort((a, b) => rank(a) - rank(b) || a.inflight - b.inflight);
    return rotated[0] as Endpoint;
  }

  return {
    async run(request, signal, onLogs) {
      const startedAt = now();
      let failure: Failure = { kind: "busy" };

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal.aborted) throw signal.reason;
        const endpoint = await pick();
        endpoint.inflight++;
        let response: Response | undefined;
        try {
          response = await fetchFn(`${endpoint.url}/run`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            // The sandbox stops the code at timeoutMs. The extra time is for the HTTP round trip.
            signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs + 5000)]),
          });
        } catch (error) {
          if (signal.aborted) throw error;
          // The sandbox did not answer in time. The code may still run there: do not send it again.
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new SandboxError("The code sandbox did not answer in time");
          }
          endpoint.downUntil = now() + cooldownMs;
          failure = { kind: "unreachable" };
        } finally {
          endpoint.inflight--;
        }

        if (response) {
          if (response.status === 429 || response.status === 503) {
            await response.body?.cancel();
            const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            endpoint.downUntil = now() + Math.min(retryAfterMs ?? 0, backoffMaxMs);
            failure = { kind: "busy", retryAfterMs };
          } else if (response.status === 502 || response.status === 504) {
            await response.body?.cancel();
            endpoint.downUntil = now() + cooldownMs;
            failure = { kind: "unreachable" };
          } else {
            let body: SandboxResponse;
            try {
              body = (await response.json()) as SandboxResponse;
            } catch {
              throw new SandboxError(
                `The code sandbox sent a bad answer (HTTP ${response.status})`,
              );
            }
            if (body.logs && body.logs.length > 0) onLogs?.(body.logs);
            if ("error" in body) throw new SandboxError(body.error.message);
            return body.result;
          }
        }

        const cap = Math.min(backoffMaxMs, backoffBaseMs * 2 ** attempt);
        const wait = Math.max(random() * cap, Math.min(failure.retryAfterMs ?? 0, backoffMaxMs));
        if (attempt + 1 >= maxAttempts || now() + wait - startedAt > busyDeadlineMs) break;
        await sleep(wait, signal);
      }

      throw new SandboxError(
        failure.kind === "busy"
          ? "The code sandbox is busy. Try again later"
          : "The code sandbox is not reachable",
      );
    },
  };
}
