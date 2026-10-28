// SPDX-License-Identifier: AGPL-3.0-only
import type { StuckRun } from "@zerodot/db";
import { log } from "./log";

/**
 * Queue again the runs that lost their job. This happens when Valkey loses its data.
 * A run that has a job in the queue is left alone. The worker can run a run again safely,
 * because it goes on from the stored node results.
 */
export async function handleSweepJob(deps: {
  listStuck: () => Promise<StuckRun[]>;
  findLive: (runIds: string[]) => Promise<Set<string>>;
  requeue: (run: StuckRun) => Promise<void>;
}): Promise<number> {
  const stuck = await deps.listStuck();
  if (stuck.length === 0) return 0;
  const live = await deps.findLive(stuck.map((r) => r.id));
  let requeued = 0;
  for (const run of stuck) {
    if (live.has(run.id)) continue;
    await deps.requeue(run);
    requeued++;
    log("warn", "run.requeued", { run: { id: run.id }, organization: { id: run.organizationId } });
  }
  return requeued;
}
