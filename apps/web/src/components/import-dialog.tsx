// SPDX-License-Identifier: AGPL-3.0-only

import { SHARE_IMPORT_HEADER, SHARE_PASSWORD_HEADER } from "@zerodot/server/share-fetch";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Spinner,
} from "@zerodot/ui";
import { type ChangeEvent, type FormEvent, useRef, useState } from "react";
import { importWorkflowFn, installNodePackageFn, previewImportFn } from "../server/fns";
import { NodeIcon } from "./node-icon";
import { refreshServerCatalog } from "./node-packages";

export type ImportResult = Awaited<ReturnType<typeof importWorkflowFn>>;
type Preview = Awaited<ReturnType<typeof previewImportFn>>;
type Needed = NonNullable<Preview["needed"]>;

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

type LinkRead = { file: unknown } | { passwordRequired: true; error: string | null };

/**
 * Reads a share link, or any URL of a `.zerodot.json` file, from the browser. The server does not
 * fetch it, so a link cannot reach the private network of the server.
 */
async function readLink(url: string, password: string | null): Promise<LinkRead> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Type a full link, for example https://example.com/share/abc");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The link must start with https:// or http://");
  }
  let response: Response;
  try {
    response = await fetch(parsed, {
      headers: {
        [SHARE_IMPORT_HEADER]: "1",
        ...(password ? { [SHARE_PASSWORD_HEADER]: password } : {}),
      },
      credentials: "omit",
    });
  } catch {
    throw new Error("Could not read the link. Download the file and import it instead");
  }
  const body: unknown = await response.json().catch(() => {
    throw new Error("The link does not give a workflow file");
  });
  const info = (body ?? {}) as { error?: unknown; passwordRequired?: unknown };
  if (response.status === 401 && info.passwordRequired === true) {
    return { passwordRequired: true, error: password ? String(info.error ?? "") : null };
  }
  if (!response.ok) {
    throw new Error(
      typeof info.error === "string" ? info.error : `The link gave status ${response.status}`,
    );
  }
  return { file: body };
}

/**
 * Imports a workflow from a share link or a file. When the workflow uses nodes that are not
 * installed, a second dialog offers to install their packages first.
 */
export function ImportDialog({
  projectSlug,
  onClose,
  onImported,
}: {
  projectSlug: string;
  onClose: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [password, setPassword] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ file: unknown; needed: Needed } | null>(null);

  /** Imports the file, or asks for the missing nodes first. */
  async function start(file: unknown) {
    const preview = await previewImportFn({ data: { projectSlug, file } });
    if (preview.needed) {
      setPending({ file, needed: preview.needed });
      return;
    }
    onImported(await importWorkflowFn({ data: { projectSlug, file } }));
  }

  async function onLink(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const read = await readLink(link.trim(), password);
      if ("passwordRequired" in read) {
        setPassword((current) => current ?? "");
        setError(read.error);
        return;
      }
      await start(read.file);
    } catch (caught) {
      setError(errorText(caught, "Could not import the link"));
    } finally {
      setBusy(false);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await start(JSON.parse(await file.text()));
    } catch (caught) {
      setError(
        caught instanceof SyntaxError
          ? "This file is not valid JSON"
          : errorText(caught, "Could not import the file"),
      );
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <MissingNodesDialog
        projectSlug={projectSlug}
        file={pending.file}
        needed={pending.needed}
        onCancel={() => setPending(null)}
        onImported={onImported}
      />
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import a workflow</DialogTitle>
          <DialogDescription>
            Paste a share link from any zerodot, or choose a .zerodot.json file.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onLink} className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="import-link">Link</FieldLabel>
            <Input
              id="import-link"
              type="url"
              required
              value={link}
              placeholder="https://example.com/share/…"
              onChange={(event) => {
                setLink(event.target.value);
                setPassword(null);
              }}
            />
          </Field>
          {password !== null && (
            <Field>
              <FieldLabel htmlFor="import-password">Password</FieldLabel>
              <Input
                id="import-password"
                type="password"
                autoComplete="off"
                required
                autoFocus
                value={password}
                placeholder="The owner of the link gives it to you"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              Choose a file
            </Button>
            <Button type="submit" disabled={busy || !link.trim()}>
              {busy && <Spinner />}
              Import
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-label="Import a .zerodot.json file"
            onChange={onFile}
          />
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The workflow uses nodes that this zerodot does not have. An instance admin installs their
 * packages here and the import continues. Others can import anyway and ask an admin.
 */
function MissingNodesDialog({
  projectSlug,
  file,
  needed,
  onCancel,
  onImported,
}: {
  projectSlug: string;
  file: unknown;
  needed: Needed;
  onCancel: () => void;
  onImported: (result: ImportResult) => void;
}) {
  const [installing, setInstalling] = useState<string | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const installable = needed.packages.filter((item) => item.compatible);
  const canInstall = needed.canInstall && installable.length > 0;

  async function finish(install: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (install) {
        for (const item of installable) {
          if (installed.has(item.name)) continue;
          setInstalling(item.name);
          await installNodePackageFn({ data: { name: item.name } });
          setInstalled((current) => new Set(current).add(item.name));
        }
        setInstalling(null);
        await refreshServerCatalog();
      }
      onImported(await importWorkflowFn({ data: { projectSlug, file } }));
    } catch (caught) {
      setError(errorText(caught, "Could not finish the import"));
    } finally {
      setInstalling(null);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install nodes to continue</DialogTitle>
          <DialogDescription>
            This workflow uses nodes that are not installed here.{" "}
            {canInstall
              ? "Install them, then the import continues. The package code runs on the server with the same rights as zerodot."
              : "Ask an instance admin to install them. You can import now, but those steps do not run until then."}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col">
          {needed.packages.map((item) => {
            const labels = item.nodes
              .filter((node) => item.types.includes(node.type))
              .map((node) => node.label);
            return (
              <li key={item.name} className="flex items-center gap-3 py-2">
                <NodeIcon name={item.icon ?? "Package"} src={item.iconUrl ?? undefined} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{item.label}</span>
                  <span className="truncate text-muted-foreground">
                    {item.compatible ? labels.join(", ") : "Needs a newer zerodot"}
                  </span>
                </span>
                {installing === item.name ? (
                  <Spinner />
                ) : installed.has(item.name) ? (
                  <span className="text-muted-foreground">Installed</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {needed.unknown.length > 0 && (
          <p className="text-muted-foreground">
            Not in the node catalog: {needed.unknown.join(", ")}.
          </p>
        )}
        {needed.catalogError && (
          <p className="text-muted-foreground">
            The node catalog is not reachable: {needed.catalogError}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            Back
          </Button>
          <Button
            variant={canInstall ? "outline" : "default"}
            disabled={busy}
            onClick={() => void finish(false)}
          >
            {busy && !canInstall && <Spinner />}
            Import anyway
          </Button>
          {canInstall && (
            <Button disabled={busy} onClick={() => void finish(true)}>
              {busy && <Spinner />}
              Install and import
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
