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
import { ApiKeyDialog } from "../components/api-key-dialog";
import { formatTime } from "../lib/format";
import { deleteApiKeyFn, listApiKeysFn } from "../server/api-key-fns";

export const Route = createFileRoute("/p/$projectSlug/api-keys")({
  loader: async ({ params, context }) => {
    const isAdmin = context.project.role.split(",").some((r) => r === "owner" || r === "admin");
    return isAdmin ? listApiKeysFn({ data: { projectSlug: params.projectSlug } }) : null;
  },
  component: ApiKeys,
});

function ApiKeys() {
  const keys = Route.useLoaderData();
  const { projectSlug } = Route.useParams();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (keys === null) {
    return (
      <main className="mx-auto w-full max-w-4xl p-4">
        <h1 className="font-semibold">API keys</h1>
        <p className="text-muted-foreground">Only an owner or an admin can manage API keys.</p>
      </main>
    );
  }

  async function remove(id: string, name: string) {
    setMessage(null);
    if (!window.confirm(`Delete "${name}"? Clients that use this key stop working.`)) return;
    try {
      await deleteApiKeyFn({ data: { projectSlug, id } });
      await router.invalidate();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not delete");
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold">API keys</h1>
        <Button onClick={() => setCreating(true)}>New API key</Button>
      </div>
      <p className="text-muted-foreground">
        Keys give a client access to this project through the REST API (
        <code className="font-mono text-xs">/api/v1</code>, with{" "}
        <a className="underline underline-offset-2" href="/api/v1/openapi.json">
          OpenAPI
        </a>
        ) and the MCP server (<code className="font-mono text-xs">/mcp</code>). Send the key in the{" "}
        <code className="font-mono text-xs">Authorization: Bearer</code> header.
      </p>
      {message && (
        <p role="alert" className="text-destructive">
          {message}
        </p>
      )}
      {keys.length === 0 ? (
        <p className="text-muted-foreground">No API keys yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                <TableCell>
                  <Badge variant="secondary">{k.role}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {k.expiresAt ? formatTime(k.expiresAt) : "Never"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {k.lastUsedAt ? formatTime(k.lastUsedAt) : "Never"}
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" onClick={() => remove(k.id, k.name)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {creating && (
        <ApiKeyDialog
          projectSlug={projectSlug}
          onClose={() => setCreating(false)}
          onCreated={() => void router.invalidate()}
        />
      )}
    </main>
  );
}
