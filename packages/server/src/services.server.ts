// SPDX-License-Identifier: AGPL-3.0-only
import { createAuth } from "@zerodot/auth";
import { blobSetup } from "@zerodot/blob";
import {
  createDb,
  getSignupDisabled,
  parseSecretKey,
  runMigrations,
  setBlobSetup,
} from "@zerodot/db";
import { createConnection, createRunQueue, createSystemQueue } from "@zerodot/queue";
import { z } from "zod";
import { createHeldLimiter } from "./held-limit";

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const env = z.object({
  DATABASE_URL: z.string().min(1),
  VALKEY_URL: z.string().min(1),
  /** 32 bytes, base64. The server does not start without it. */
  ZERODOT_SECRET_KEY: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  ZERODOT_BASE_URL: z.string().url().default("http://localhost:3000"),
  /** More origins that may call the sign-in routes, comma separated. A host can start with `*.`. */
  ZERODOT_TRUSTED_ORIGINS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((o) => o.trim())
        .filter((o) => o !== ""),
    ),
  /** Read the caller address from X-Forwarded-For. Turn it on only behind a proxy that sets it. */
  ZERODOT_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ZERODOT_SIGNUP_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ZERODOT_MAX_WEBHOOK_BODY_BYTES: int(5 * 1024 * 1024),
  ZERODOT_TABLE_MAX_ROWS: int(100_000),
  /** Most Postgres connections one process opens. */
  ZERODOT_DB_POOL_MAX: int(10),
  ZERODOT_WEBHOOK_RATE_LIMIT_PER_MINUTE: int(600),
  ZERODOT_API_RATE_LIMIT_PER_MINUTE: int(600),
  /** `wait=true` on the API holds a request at most this long. */
  ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS: int(30_000),
  /** Most requests one process holds open for a run (`wait=true`, response modes). Over it: 503. */
  ZERODOT_MAX_HELD_WEBHOOKS: int(500),
  /** A webhook lookup stays in the process this long. A deactivated hook can answer this long. 0 turns it off. */
  ZERODOT_WEBHOOK_CACHE_MS: z.coerce.number().int().min(0).default(5_000),
});

async function init() {
  const config = env.parse(process.env);
  const secretKey = parseSecretKey(config.ZERODOT_SECRET_KEY);
  const handle = createDb(config.DATABASE_URL, { max: config.ZERODOT_DB_POOL_MAX });
  await runMigrations(handle);
  // Reads of node results get large and binary data back from the blob store.
  setBlobSetup(blobSetup());
  const auth = createAuth({
    db: handle.db,
    baseURL: config.ZERODOT_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: config.ZERODOT_TRUSTED_ORIGINS,
    // The variable always wins. Without it, the System page setting decides.
    signupDisabled: async () =>
      config.ZERODOT_SIGNUP_DISABLED || (await getSignupDisabled(handle.db)),
  });
  const redis = createConnection(config.VALKEY_URL);
  // Node packages load once Valkey is there, so an install in another process reaches this one.
  const { startNodePackages } = await import("./node-packages.server");
  await startNodePackages(handle.db, createConnection(config.VALKEY_URL), (level, msg, fields) =>
    console.log(JSON.stringify({ level, msg, ...fields })),
  );
  const queue = createRunQueue(createConnection(config.VALKEY_URL, { blocking: true }));
  /** Schedulers and pollers live here, not in the run queue. */
  const systemQueue = createSystemQueue(createConnection(config.VALKEY_URL, { blocking: true }));
  return {
    config,
    secretKey,
    /** Caps the requests that wait for a run. Shared by the webhook route and the API. */
    heldLimiter: createHeldLimiter(config.ZERODOT_MAX_HELD_WEBHOOKS),
    db: handle.db,
    auth,
    redis,
    queue,
    systemQueue,
    /** SSE readers use XREAD BLOCK. Each reader needs its own connection. */
    readerConnection: () => createConnection(config.VALKEY_URL),
  };
}

// The singleton lives on globalThis. In dev, a hot reload runs this module again. A module level
// variable would start empty, and every reload would open new database and Valkey connections
// and keep the old ones until the server has none left.
const holder = globalThis as typeof globalThis & { zerodotServices?: ReturnType<typeof init> };

/** Lazy singleton. First call connects and runs migrations. */
export function getServices() {
  holder.zerodotServices ??= init();
  return holder.zerodotServices;
}
