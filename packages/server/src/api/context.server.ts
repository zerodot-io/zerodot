// SPDX-License-Identifier: AGPL-3.0-only

import { timingSafeEqual } from "node:crypto";
import {
  type Db,
  findApiKey,
  forOrganization,
  type OrganizationScope,
  seedApiKey,
} from "@zerodot/db";
import type { RunWaiter } from "@zerodot/queue";
import type { Redis } from "ioredis";
import type { HeldLimiter } from "../held-limit";
import { ApiError, forbidden, unauthorized } from "./errors";

export type Role = "admin" | "member";

/** Who makes a call. A key or a session. A key belongs to one project. */
export type Principal = {
  organizationId: string;
  role: Role;
  userId: string | null;
  apiKeyId: string | null;
};

/** What the API needs from the app. Tests give a small fake. */
export type ApiServices = {
  db: Db;
  secretKey: Buffer;
  tableMaxRows: number;
  baseUrl: string;
  syncTimeoutMs: number;
  /** Caps the requests that wait for a run (`wait=true`). Without it there is no cap. */
  heldLimiter?: HeldLimiter;
  rateLimitPerMinute: number;
  /** Wakes `wait=true` calls when a run ends. Without it they poll. */
  runWaiter?: RunWaiter;
  /** An admin key from the environment. The first call with it saves it. */
  bootstrap?: { key: string; project: string | undefined };
  enqueue(input: {
    runId: string;
    organizationId: string;
    mode: "production" | "test";
  }): Promise<void>;
  /** Number of calls with this key in the current one-minute window, this call included. */
  hit(key: string): Promise<number>;
  /** Session auth for the web app. Null when the request has no valid session or project. */
  session(request: Request): Promise<Principal | null>;
  /** Make the cron schedulers of a workflow match its state. */
  syncSchedules(organizationId: string, workflowId: string): Promise<void>;
  /** Tell open editors that the draft of a workflow changed. */
  draftChanged(organizationId: string, workflowId: string): Promise<void>;
  /** A new Valkey connection for one SSE reader. The caller closes it. */
  reader(): Redis;
};

export type ApiContext = {
  principal: Principal;
  scope: OrganizationScope;
  services: ApiServices;
};

export function createContext(services: ApiServices, principal: Principal): ApiContext {
  return {
    principal,
    services,
    scope: forOrganization(services.db, principal.organizationId, {
      secretKey: services.secretKey,
      tableMaxRows: services.tableMaxRows,
    }),
  };
}

/** A write that needs the `admin` role. */
export function requireAdmin(ctx: ApiContext): void {
  if (ctx.principal.role !== "admin") {
    throw forbidden("This action needs an admin API key or an admin role");
  }
}

const BEARER = /^Bearer\s+(\S+)$/i;

function sameKey(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The key from the environment is not in the database until the first call with it. */
async function seedBootstrap(services: ApiServices, key: string) {
  const { bootstrap } = services;
  if (!bootstrap || !sameKey(key, bootstrap.key)) return null;
  if (!(await seedApiKey(services.db, key, bootstrap.project))) return null;
  return findApiKey(services.db, key);
}

/** API key in `Authorization: Bearer`, or a web session. Throws `ApiError` for 401. */
export async function authenticate(services: ApiServices, request: Request): Promise<Principal> {
  const header = request.headers.get("authorization");
  if (header) {
    const key = BEARER.exec(header)?.[1];
    if (!key) throw unauthorized();
    const found = (await findApiKey(services.db, key)) ?? (await seedBootstrap(services, key));
    if (!found) throw unauthorized();
    if (found.expiresAt && found.expiresAt.getTime() <= Date.now()) {
      throw unauthorized("This API key has expired");
    }
    return {
      organizationId: found.organizationId,
      role: found.role,
      userId: null,
      apiKeyId: found.id,
    };
  }
  const principal = await services.session(request);
  if (!principal) throw unauthorized("Sign in, or send an API key in the Authorization header");
  return principal;
}

/** Fixed window rate limit for each key or session user. Throws a 429 with `retryAfter`. */
export async function enforceRateLimit(services: ApiServices, principal: Principal) {
  const subject = principal.apiKeyId ?? `user:${principal.userId ?? "none"}`;
  const hits = await services.hit(subject);
  if (hits > services.rateLimitPerMinute) {
    throw new ApiError(429, "rate_limited", "Too many requests", { retryAfterSeconds: 60 });
  }
}
