// SPDX-License-Identifier: AGPL-3.0-only
import { authClient } from "@zerodot/auth/client";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Field,
  FieldLabel,
  Input,
} from "@zerodot/ui";
import { type FormEvent, useState } from "react";

function slugFor(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
  return `${base || "project"}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Makes a project. The user is the owner. */
export function ProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const slug = slugFor(name);
    const { error: failed } = await authClient.organization.create({ name: name.trim(), slug });
    setPending(false);
    if (failed) {
      setError(failed.message ?? "Could not create the project");
      return;
    }
    onCreated(slug);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="project-name">Name</FieldLabel>
            <Input
              id="project-name"
              value={name}
              required
              autoFocus
              maxLength={60}
              placeholder="Marketing"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {error && <p className="text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || name.trim() === ""}>
              Create
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
