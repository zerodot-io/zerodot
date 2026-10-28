// SPDX-License-Identifier: AGPL-3.0-only
import type { QueueCounts } from "@zerodot/queue";

export type WorkerMetrics = {
  /** Job counts of each queue. `queue` is "runs" or "system". */
  queues: { queue: string; counts: QueueCounts }[];
  /** Jobs this worker can run at once, for each queue. */
  concurrency: { queue: string; value: number }[];
  runsProcessed: number;
  runsFailed: number;
  version: string;
};

/** Prometheus text format. */
export function renderMetrics(m: WorkerMetrics): string {
  const lines: string[] = [
    "# HELP zerodot_queue_jobs Jobs in each queue, by state.",
    "# TYPE zerodot_queue_jobs gauge",
    ...m.queues.flatMap(({ queue, counts }) =>
      Object.entries(counts).map(
        ([state, n]) => `zerodot_queue_jobs{queue="${queue}",state="${state}"} ${n}`,
      ),
    ),
    "# HELP zerodot_worker_concurrency Jobs this worker can run at once, by queue.",
    "# TYPE zerodot_worker_concurrency gauge",
    ...m.concurrency.map((c) => `zerodot_worker_concurrency{queue="${c.queue}"} ${c.value}`),
    "# HELP zerodot_worker_jobs_total Jobs this worker finished since it started.",
    "# TYPE zerodot_worker_jobs_total counter",
    `zerodot_worker_jobs_total{result="completed"} ${m.runsProcessed}`,
    `zerodot_worker_jobs_total{result="failed"} ${m.runsFailed}`,
    "# HELP zerodot_build_info Version of this worker.",
    "# TYPE zerodot_build_info gauge",
    `zerodot_build_info{version="${m.version.replace(/"/g, "")}"} 1`,
  ];
  return `${lines.join("\n")}\n`;
}
