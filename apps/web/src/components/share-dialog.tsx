// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  toast,
} from "@zerodot/ui";
import { EllipsisVertical, RefreshCw, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { formatAge } from "../lib/admin-format";
import {
  createWorkflowShareFn,
  deleteWorkflowShareFn,
  listWorkflowSharesFn,
  updateWorkflowShareFn,
} from "../server/fns";

type Share = Awaited<ReturnType<typeof createWorkflowShareFn>>;
type Access = "anyone" | "password";

const ACCESS = [
  { value: "anyone", label: "Anyone with the link" },
  { value: "password", label: "Password protected" },
] as const;

const MIN_PASSWORD = 8;

const ago = (iso: string) => formatAge(Date.now() - new Date(iso).getTime());

const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Something went wrong";

function describe(share: Share): string {
  if (share.usedAt) return `Used ${ago(share.usedAt)} ago`;
  return [
    share.protected ? "Password" : "Anyone with the link",
    share.singleUse ? "One import" : null,
    `Copy from ${ago(share.updatedAt)} ago`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Public links to copies of the workflow. Another zerodot imports a link in Workflows > Import.
 * A workflow can have many links, for example one for each buyer, each with its own password and
 * single use. A copy does not change when the workflow changes, until one updates it.
 */
export function ShareDialog({
  projectSlug,
  workflowId,
  workflowName,
  beforeShare,
  onClose,
}: {
  projectSlug: string;
  workflowId: string;
  workflowName: string;
  /** Runs before a copy is made. The editor saves the canvas here. */
  beforeShare?: () => Promise<void>;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [label, setLabel] = useState("");
  const [access, setAccess] = useState<Access>("anyone");
  const [password, setPassword] = useState("");
  const [singleUse, setSingleUse] = useState(false);
  /** "create", or the token of the link that is changing. */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listWorkflowSharesFn({ data: { projectSlug, workflowId } }).then(setShares, (caught) => {
      setShares([]);
      setError(errorText(caught));
    });
  }, [projectSlug, workflowId]);

  async function work(key: string, task: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(null);
    }
  }

  async function copy(url: string) {
    await navigator.clipboard.writeText(url);
    toast.success("Link copied");
  }

  const passwordShort = access === "password" && password.length < MIN_PASSWORD;

  function onCreate(event: FormEvent) {
    event.preventDefault();
    if (passwordShort) return;
    void work("create", async () => {
      await beforeShare?.();
      const made = await createWorkflowShareFn({
        data: {
          projectSlug,
          workflowId,
          label: label.trim() || null,
          password: access === "password" ? password : null,
          singleUse,
        },
      });
      setShares((current) => [made, ...(current ?? [])]);
      setLabel("");
      setPassword("");
      await copy(made.url).catch(() => undefined);
    });
  }

  function onRefresh(share: Share) {
    void work(share.token, async () => {
      await beforeShare?.();
      const next = await updateWorkflowShareFn({
        data: { projectSlug, token: share.token, refresh: true },
      });
      setShares((current) => current?.map((s) => (s.token === next.token ? next : s)) ?? null);
    });
  }

  function onDelete(share: Share) {
    void work(share.token, async () => {
      await deleteWorkflowShareFn({ data: { projectSlug, token: share.token } });
      setShares((current) => current?.filter((s) => s.token !== share.token) ?? null);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && busy === null && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {workflowName}</DialogTitle>
          <DialogDescription>
            People with a link see the steps and their settings, and can import them into their
            zerodot. Credentials and variable values are not in the link.
          </DialogDescription>
        </DialogHeader>

        {shares === null ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : (
          shares.length > 0 && (
            <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border">
              {shares.map((share, index) => (
                <li key={share.token} className="flex items-center gap-2 py-2 pr-2 pl-3">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className={`truncate ${share.usedAt ? "text-muted-foreground" : ""}`}>
                      {share.label || `Link ${shares.length - index}`}
                    </span>
                    <span className="truncate text-muted-foreground">{describe(share)}</span>
                  </span>
                  {busy === share.token && <Spinner />}
                  {!share.usedAt && (
                    <Button
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void copy(share.url)}
                    >
                      Copy
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`More actions for ${share.label || "this link"}`}
                      disabled={busy !== null}
                      className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                    >
                      <EllipsisVertical className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {!share.usedAt && (
                        <DropdownMenuItem onClick={() => onRefresh(share)}>
                          <RefreshCw />
                          Update copy
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem variant="destructive" onClick={() => onDelete(share)}>
                        <Trash2 />
                        Delete link
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )
        )}

        <form onSubmit={onCreate} className="flex flex-col gap-3">
          <span className="font-medium">New link</span>
          <Field>
            <FieldLabel htmlFor="share-label">Label</FieldLabel>
            <Input
              id="share-label"
              value={label}
              maxLength={120}
              placeholder="Optional, for example the name of the buyer"
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="share-access">Access</FieldLabel>
            <Select
              value={access}
              items={ACCESS.map((a) => ({ value: a.value, label: a.label }))}
              onValueChange={(value) => {
                if (!value) return;
                setAccess(value as Access);
                setPassword("");
              }}
            >
              <SelectTrigger id="share-access">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS.map((a) => (
                  <SelectItem key={a.value} value={a.value}>
                    {a.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {access === "password" && (
            <Field>
              <FieldLabel htmlFor="share-password">Password</FieldLabel>
              <Input
                id="share-password"
                type="password"
                autoComplete="new-password"
                value={password}
                minLength={MIN_PASSWORD}
                required
                placeholder={`At least ${MIN_PASSWORD} characters`}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="flex flex-col">
              <span>One import only</span>
              <span className="text-muted-foreground">
                The link stops working after one import.
              </span>
            </span>
            <Switch
              aria-label="One import only"
              checked={singleUse}
              onCheckedChange={setSingleUse}
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy !== null} onClick={onClose}>
              Done
            </Button>
            <Button type="submit" disabled={busy !== null || passwordShort}>
              {busy === "create" && <Spinner />}
              Create link
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
