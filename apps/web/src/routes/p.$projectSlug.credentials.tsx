// SPDX-License-Identifier: AGPL-3.0-only

import { createFileRoute, useRouter } from "@tanstack/react-router";
import { credentialTypeCatalog } from "@zerodot/nodes";
import { Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@zerodot/ui";
import { useState } from "react";
import { CredentialDialog, type SavedCredential } from "../components/credential-dialog";
import { NodeIcon } from "../components/node-icon";
import { addServerCatalog } from "../lib/flow";
import { formatTime } from "../lib/format";
import { getExtraCatalogFn } from "../server/fns";
import { credentialUsageFn, deleteCredentialFn, listCredentialsFn } from "../server/settings-fns";

export const Route = createFileRoute("/p/$projectSlug/credentials")({
  loader: async ({ params }) => {
    const [credentials, extra] = await Promise.all([
      listCredentialsFn({ data: { projectSlug: params.projectSlug } }),
      getExtraCatalogFn(),
    ]);
    addServerCatalog(extra);
    return { credentials, extra };
  },
  validateSearch: (search: Record<string, unknown>) => ({
    oauth2: search.oauth2 === "connected" || search.oauth2 === "error" ? search.oauth2 : undefined,
    message: typeof search.message === "string" ? search.message : undefined,
  }),
  component: Credentials,
});

const entryOf = (type: string) => credentialTypeCatalog.find((t) => t.type === type);

/** Only an OAuth2 credential has a status to show. */
function statusOf(c: { type: string; status: string; connected: boolean }): string {
  if (!entryOf(c.type)?.oauth2) return "";
  if (c.status === "needs_reconnect") return "Reconnect needed";
  return c.connected ? "Connected" : "Not connected";
}

function Credentials() {
  const { credentials, extra } = Route.useLoaderData();
  // The loader runs on the server for a full page load. The browser gets the extra nodes here.
  addServerCatalog(extra);
  const { projectSlug } = Route.useParams();
  const { project } = Route.useRouteContext();
  const router = useRouter();
  const canEdit = project.role.split(",").some((r) => r === "owner" || r === "admin");
  const [editing, setEditing] = useState<SavedCredential | "new" | null>(null);
  const search = Route.useSearch();
  const [message, setMessage] = useState<string | null>(
    search.oauth2 === "error" ? (search.message ?? "The connection failed.") : null,
  );

  async function remove(credential: SavedCredential) {
    setMessage(null);
    const users = await credentialUsageFn({ data: { projectSlug, id: credential.id } });
    if (users.length > 0) {
      setMessage(`"${credential.name}" is in use by: ${users.map((w) => w.name).join(", ")}.`);
      return;
    }
    if (!window.confirm(`Delete "${credential.name}"? This cannot be undone.`)) return;
    try {
      await deleteCredentialFn({ data: { projectSlug, id: credential.id } });
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold">Credentials</h1>
        {canEdit && <Button onClick={() => setEditing("new")}>New credential</Button>}
      </div>
      <p className="text-muted-foreground">
        Secrets for nodes. Zerodot stores them encrypted and never shows a saved value.
      </p>
      {search.oauth2 === "connected" && <p role="status">The account is connected.</p>}
      {message && (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      )}
      {credentials.length === 0 ? (
        <p className="text-muted-foreground">No credentials yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {credentials.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  <span className="flex items-center gap-2">
                    <NodeIcon
                      name={entryOf(c.type)?.icon ?? "KeyRound"}
                      src={entryOf(c.type)?.iconUrl}
                    />
                    {entryOf(c.type)?.label ?? c.type}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{statusOf(c)}</TableCell>
                <TableCell className="text-muted-foreground">{formatTime(c.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  {canEdit && (
                    <>
                      <Button variant="ghost" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button variant="ghost" onClick={() => remove(c)}>
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
        <CredentialDialog
          key={editing === "new" ? "new" : editing.id}
          projectSlug={projectSlug}
          open
          existing={editing === "new" ? undefined : editing}
          onOpenChange={(open) => !open && setEditing(null)}
          onSaved={() => void router.invalidate()}
          onDeleted={() => void router.invalidate()}
        />
      )}
    </main>
  );
}
