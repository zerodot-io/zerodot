// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { Button, Field, FieldLabel, Input } from "@zerodot/ui";
import { type FormEvent, useState } from "react";
import { TimezoneSelect } from "../components/timezone-select";
import { getSettingsFn, setSettingsFn } from "../server/settings-fns";

export const Route = createFileRoute("/p/$projectSlug/settings")({
  loader: async ({ params }) => {
    const data = { projectSlug: params.projectSlug };
    const settings = await getSettingsFn({ data });
    return { settings };
  },
  component: Settings,
});

function Settings() {
  const { settings } = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const { project } = Route.useRouteContext();
  const router = useRouter();
  const canEdit = project.role.split(",").some((r) => r === "owner" || r === "admin");
  const [days, setDays] = useState(settings.runRetentionDays?.toString() ?? "");
  const [timezone, setTimezone] = useState(settings.timezone ?? "UTC");
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    const value = days.trim() === "" ? null : Number(days);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 3650)) {
      setMessage("Enter a whole number from 1 to 3650, or leave the field empty");
      return;
    }
    try {
      await setSettingsFn({
        data: {
          projectSlug,
          runRetentionDays: value,
          timezone: timezone === "UTC" ? null : timezone,
        },
      });
      await router.invalidate();
      setMessage("Saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="run-retention">Keep production runs (days)</FieldLabel>
          <Input
            id="run-retention"
            className="w-48"
            inputMode="numeric"
            placeholder="Server default"
            value={days}
            disabled={!canEdit}
            onChange={(event) => setDays(event.target.value)}
          />
        </Field>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          A daily job deletes finished production runs older than this. Test runs, insight rollups,
          and data tables follow other rules. Leave the field empty to use the server default.
        </p>
        <Field>
          <FieldLabel htmlFor="project-timezone">Time zone</FieldLabel>
          <TimezoneSelect
            id="project-timezone"
            value={timezone}
            disabled={!canEdit}
            onChange={setTimezone}
          />
        </Field>
        <p className="max-w-prose text-pretty text-sm text-muted-foreground">
          Schedule triggers use this time zone. A workflow or a Schedule node can use its own.
        </p>
        <div className="flex items-center gap-3">
          {canEdit ? (
            <Button type="submit">Save</Button>
          ) : (
            <span className="text-muted-foreground">
              Only an owner or an admin can change this.
            </span>
          )}
          {message && (
            <span role="status" className="text-muted-foreground">
              {message}
            </span>
          )}
        </div>
      </form>
    </main>
  );
}
