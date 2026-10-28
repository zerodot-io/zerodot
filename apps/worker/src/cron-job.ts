// SPDX-License-Identifier: AGPL-3.0-only
import { type Db, forOrganization } from "@zerodot/db";
import type { CronJob } from "@zerodot/queue";
import { log } from "./log";

/**
 * A scheduler job fired. Make a production run for the published version and queue it.
 * The job id is the idempotency key, so a repeated job does not make a second run.
 */
export async function handleCronJob(
  deps: {
    db: Db;
    enqueueRun: (input: { runId: string; organizationId: string }) => Promise<void>;
  },
  data: CronJob,
  job: { id?: string; timestamp: number; opts?: { delay?: number } },
): Promise<void> {
  // The job is created ahead of time with a delay. The tick is the creation time plus the delay.
  const scheduledAt = new Date(job.timestamp + (job.opts?.delay ?? 0));
  const scope = forOrganization(deps.db, data.organizationId);
  const trigger = await scope.workflows.cronTrigger(data.triggerId);
  if (!trigger?.active || !trigger.publishedVersionId) {
    log("warn", "cron.skipped", { trigger: { id: data.triggerId }, reason: "not active" });
    return;
  }
  const { run, created } = await scope.runs.create({
    workflowId: trigger.workflowId,
    mode: "production",
    versionId: trigger.publishedVersionId,
    triggerType: "cron",
    triggerNodeId: data.nodeId,
    triggerInput: { scheduledAt: scheduledAt.toISOString(), timezone: data.timezone },
    idempotencyKey: `cron:${job.id ?? job.timestamp}`,
  });
  if (created) await deps.enqueueRun({ runId: run.id, organizationId: data.organizationId });
}
