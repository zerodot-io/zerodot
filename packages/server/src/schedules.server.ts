// SPDX-License-Identifier: AGPL-3.0-only
import {
  forOrganization,
  listCronWorkflowIds,
  listWorkflowCronSchedules,
  listWorkflowPollSchedules,
} from "@zerodot/db";
import {
  syncPollers,
  syncSchedulers,
  workflowPollerPrefix,
  workflowSchedulerPrefix,
} from "@zerodot/queue";
import { getServices } from "./services.server";

/**
 * Make the schedulers of one workflow match its state. An active, published workflow gets one
 * scheduler for each cron trigger and one poller for each poll trigger. Any other workflow gets
 * none. A poll trigger that stops loses what it remembered, so it starts with a first poll.
 */
export async function syncWorkflowSchedules(organizationId: string, workflowId: string) {
  const { db, systemQueue } = await getServices();
  const schedules = await listWorkflowCronSchedules(db, organizationId, workflowId);
  await syncSchedulers(systemQueue, schedules, workflowSchedulerPrefix(workflowId));
  const pollers = await listWorkflowPollSchedules(db, organizationId, workflowId);
  await syncPollers(systemQueue, pollers, workflowPollerPrefix(workflowId));
  await forOrganization(db, organizationId).workflows.resetPollState(
    workflowId,
    pollers.map((p) => p.triggerId),
  );
}

/** Sync every workflow of a project. A project time zone change needs it. */
export async function syncProjectSchedules(organizationId: string) {
  const { db } = await getServices();
  for (const workflowId of await listCronWorkflowIds(db, organizationId)) {
    await syncWorkflowSchedules(organizationId, workflowId);
  }
}
