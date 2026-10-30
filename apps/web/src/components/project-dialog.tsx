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

/** Makes a project. The user is the owner. Gives the slug, or an error message. */
async function createProject(name: string): Promise<{ slug: string } | { error: string }> {
  const slug = slugFor(name);
  const { error } = await authClient.organization.create({ name: name.trim(), slug });
  if (error) return { error: error.message ?? "Could not create the project" };
  return { slug };
}

/**
 * Inline form for a new project, for use inside a menu. Enter makes the project. Escape cancels.
 * Keys stop at the input, so the menu does not use them for typeahead or to close.
 */
export function NewProjectInput({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (slug: string) => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    setError(null);
    setPending(true);
    const result = await createProject(name);
    setPending(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onCreated(result.slug);
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-1 py-0.5">
      <Input
        size="sm"
        value={name}
        autoFocus
        maxLength={60}
        disabled={pending}
        aria-label="Project name"
        placeholder="Project name"
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      {error && <p className="px-1 text-destructive">{error}</p>}
    </form>
  );
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
    const result = await createProject(name);
    setPending(false);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    onCreated(result.slug);
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
