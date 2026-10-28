// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMetrics } from "./metrics";

describe("renderMetrics", () => {
  it("writes queue counts and worker totals", () => {
    const text = renderMetrics({
      queues: [
        {
          queue: "runs",
          counts: { waiting: 3, active: 2, delayed: 1, prioritized: 0, failed: 4, completed: 9 },
        },
        {
          queue: "system",
          counts: { waiting: 0, active: 1, delayed: 6, prioritized: 0, failed: 0, completed: 2 },
        },
      ],
      concurrency: [
        { queue: "runs", value: 5 },
        { queue: "system", value: 2 },
      ],
      runsProcessed: 7,
      runsFailed: 1,
      version: "1.2.3",
    });
    assert.match(text, /zerodot_queue_jobs\{queue="runs",state="waiting"\} 3/);
    assert.match(text, /zerodot_queue_jobs\{queue="system",state="delayed"\} 6/);
    assert.match(text, /zerodot_worker_concurrency\{queue="runs"\} 5/);
    assert.match(text, /zerodot_worker_jobs_total\{result="failed"\} 1/);
    assert.match(text, /zerodot_build_info\{version="1.2.3"\} 1/);
  });
});
