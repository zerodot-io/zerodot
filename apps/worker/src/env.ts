// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

const int = (fallback: number) => z.coerce.number().int().positive().default(fallback);
/** Zero is allowed. It turns a cap off. */
const cap = (fallback: number) => z.coerce.number().int().min(0).default(fallback);

export const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    /** 32 bytes, base64. The worker does not start without it. */
    ZERODOT_SECRET_KEY: z.string().min(1),
    VALKEY_URL: z.string().min(1),
    PORT: int(3001),
    /** Public address of the web app. A node that waits for an answer builds its link from it. */
    ZERODOT_BASE_URL: z.string().url().optional(),
    ZERODOT_WORKER_CONCURRENCY: int(20),
    /** Jobs the system worker (cron, poll, retention, sweep) runs at once. */
    ZERODOT_SYSTEM_CONCURRENCY: int(5),
    /** Most runs of one project that run at once, over all workers. 0: no cap. */
    ZERODOT_ORG_MAX_CONCURRENT_RUNS: cap(0),
    /** Most runs of one workflow that run at once, over all workers. 0: no cap. */
    ZERODOT_WORKFLOW_MAX_CONCURRENT_RUNS: cap(0),
    /** Most listen triggers one worker keeps open. */
    ZERODOT_MAX_LISTEN_TRIGGERS: int(100),
    /** Most Postgres connections the worker opens. Default: run concurrency plus system concurrency plus 5. */
    ZERODOT_DB_POOL_MAX: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.coerce.number().int().positive().optional(),
    ),
    /** A queued run with no job for this long is queued again. */
    ZERODOT_SWEEP_QUEUED_AFTER_MS: int(2 * 60_000),
    ZERODOT_RUN_TIMEOUT_MS: int(5 * 60_000),
    ZERODOT_MAX_NODE_OUTPUT_BYTES: int(5 * 1024 * 1024),
    /** The most node runs in one workflow run. A loop that does not end stops here. */
    ZERODOT_MAX_NODE_RUNS: int(1000),
    ZERODOT_SHUTDOWN_GRACE_MS: int(30_000),
    /** Most rows one data table can hold. */
    ZERODOT_TABLE_MAX_ROWS: int(100_000),
    /** Insight rollups older than this are deleted by a daily job. */
    ZERODOT_STATS_RETENTION_DAYS: int(365),
    /** Test runs older than this are deleted by a daily job. */
    ZERODOT_TEST_RUN_RETENTION_DAYS: int(7),
    /** Finished production runs older than this are deleted, unless the project sets its own days. */
    ZERODOT_RUN_RETENTION_DAYS: int(30),
    /** The code sandbox, for example http://sandbox:3002. Without it, code nodes fail. */
    SANDBOX_URL: z
      .string()
      .min(1)
      .optional()
      .refine(
        (v) => v === undefined || v.split(",").every((entry) => URL.canParse(entry.trim())),
        "SANDBOX_URL must be a URL, or URLs separated by commas",
      ),
    /** Names of server variables that expressions may read as $env. */
    ZERODOT_ENV_ALLOWLIST: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      ),
  })
  .parse(process.env);
