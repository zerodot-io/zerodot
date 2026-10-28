// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@zerodot/ui";
import { type FormEvent, useState } from "react";
import { createApiKeyFn } from "../server/api-key-fns";

const EXPIRY = [
  { value: "never", label: "Never", days: null },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "365", label: "1 year", days: 365 },
] as const;

const ROLES = [
  { value: "member", label: "Member: workflows, runs, and rows" },
  { value: "admin", label: "Admin: also variables, credentials, and tables" },
] as const;

type Role = (typeof ROLES)[number]["value"];

/** Makes a key. The full key shows once, after it is made. */
export function ApiKeyDialog({
  projectSlug,
  onClose,
  onCreated,
}: {
  projectSlug: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [expiry, setExpiry] = useState<string>("90");
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      const days = EXPIRY.find((e) => e.value === expiry)?.days ?? null;
      const result = await createApiKeyFn({
        data: { projectSlug, name, role, expiresInDays: days },
      });
      setCreated(result.key);
      onCreated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create the key");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{created ? "Copy your key" : "New API key"}</DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground">
              This is the only time you see the key. Store it in a safe place.
            </p>
            <code className="break-all rounded-md bg-muted p-2 font-mono text-xs">{created}</code>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  await navigator.clipboard.writeText(created);
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="api-key-name">Name</FieldLabel>
              <Input
                id="api-key-name"
                value={name}
                required
                placeholder="CI deploy"
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-role">Role</FieldLabel>
              <Select
                value={role}
                items={ROLES.map((r) => ({ value: r.value, label: r.label }))}
                onValueChange={(value) => value && setRole(value as Role)}
              >
                <SelectTrigger id="api-key-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="api-key-expiry">Expires</FieldLabel>
              <Select
                value={expiry}
                items={EXPIRY.map((e) => ({ value: e.value, label: e.label }))}
                onValueChange={(value) => value && setExpiry(value)}
              >
                <SelectTrigger id="api-key-expiry">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRY.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                Create key
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
