// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@zerodot/ui";
import { useState } from "react";
import { VariableDialog, type VariableItem } from "../components/variable-dialog";
import { deleteVariableFn, listVariablesFn, variableUsageFn } from "../server/settings-fns";

export const Route = createFileRoute("/p/$projectSlug/variables")({
  loader: ({ params }) => listVariablesFn({ data: { projectSlug: params.projectSlug } }),
  component: Variables,
});

function preview(item: VariableItem): string {
  const text = typeof item.value === "string" ? item.value : JSON.stringify(item.value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function Variables() {
  const variables = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const { project } = Route.useRouteContext();
  const router = useRouter();
  const canEdit = project.role.split(",").some((r) => r === "owner" || r === "admin");
  const [editing, setEditing] = useState<VariableItem | "new" | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function remove(item: VariableItem) {
    setMessage(null);
    const users = await variableUsageFn({ data: { projectSlug, key: item.key } });
    const warning =
      users.length > 0
        ? `"${item.key}" is used by: ${users.map((w) => w.name).join(", ")}. Those workflows will fail. `
        : "";
    if (!window.confirm(`${warning}Delete "${item.key}"?`)) return;
    try {
      await deleteVariableFn({ data: { projectSlug, key: item.key } });
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold">Variables</h1>
        {canEdit && <Button onClick={() => setEditing("new")}>New variable</Button>}
      </div>
      <p className="text-muted-foreground">
        Fixed values that workflows share. Read them with{" "}
        <code className="font-mono text-xs">{"{{ $vars.name }}"}</code>. Workflows cannot change
        them.
      </p>
      {message && (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      )}
      {variables.length === 0 ? (
        <p className="text-muted-foreground">No variables yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Value</TableHead>
              <TableHead>Description</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {variables.map((v) => (
              <TableRow key={v.key}>
                <TableCell className="font-mono font-medium">{v.key}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{v.type}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs">{preview(v)}</TableCell>
                <TableCell className="text-muted-foreground">{v.description}</TableCell>
                <TableCell className="text-right">
                  {canEdit && (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(v)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => remove(v)}>
                        Delete
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {editing && (
        <VariableDialog
          key={editing === "new" ? "new" : editing.key}
          projectSlug={projectSlug}
          existing={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void router.invalidate()}
        />
      )}
    </main>
  );
}
