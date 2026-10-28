// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@zerodot/ui";
import { useState } from "react";
import { TableDialog } from "../components/table-dialog";
import { listTablesFn } from "../server/table-fns";

export const Route = createFileRoute("/p/$projectSlug/tables/")({
  loader: ({ params }) => listTablesFn({ data: { projectSlug: params.projectSlug } }),
  component: Tables,
});

function Tables() {
  const tables = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const { project } = Route.useRouteContext();
  const navigate = useNavigate();
  const canEdit = project.role.split(",").some((r) => r === "owner" || r === "admin");
  const [creating, setCreating] = useState(false);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-lg">Data tables</h1>
        {canEdit && <Button onClick={() => setCreating(true)}>New table</Button>}
      </div>
      <p className="text-muted-foreground">
        Small tables that workflows read and write. Use them for seen ids, counters, and queues.
      </p>
      {tables.length === 0 ? (
        <p className="text-muted-foreground">No tables yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Columns</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Description</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tables.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/p/$projectSlug/tables/$tableId"
                    params={{ projectSlug, tableId: t.id }}
                  >
                    {t.name}
                  </Link>
                </TableCell>
                <TableCell className="tabular-nums">{t.columns.length}</TableCell>
                <TableCell className="tabular-nums">{t.rowCount}</TableCell>
                <TableCell className="text-muted-foreground">{t.description}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {creating && (
        <TableDialog
          projectSlug={projectSlug}
          onClose={() => setCreating(false)}
          onCreated={(table) =>
            void navigate({
              to: "/p/$projectSlug/tables/$tableId",
              params: { projectSlug, tableId: table.id },
            })
          }
        />
      )}
    </main>
  );
}
