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
  Switch,
  Textarea,
} from "@zerodot/ui";
import { type FormEvent, useState } from "react";
import type { Json } from "../lib/json";
import { createVariableFn, updateVariableFn } from "../server/settings-fns";

export type VariableType = "string" | "number" | "boolean" | "json";
export type VariableItem = { key: string; type: VariableType; value: Json; description: string };

const TYPES: VariableType[] = ["string", "number", "boolean", "json"];

function toText(variable: VariableItem | undefined): string {
  if (!variable) return "";
  return variable.type === "string"
    ? String(variable.value)
    : JSON.stringify(variable.value, null, 2);
}

/** Variables are not secrets. Their values show in the UI and in run data. */
export function VariableDialog({
  projectSlug,
  existing,
  onClose,
  onSaved,
}: {
  projectSlug: string;
  existing?: VariableItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(existing?.key ?? "");
  const [type, setType] = useState<VariableType>(existing?.type ?? "string");
  const [text, setText] = useState(toText(existing));
  const [flag, setFlag] = useState(existing?.type === "boolean" ? existing.value === true : false);
  const [description, setDescription] = useState(existing?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function readValue(): { value: Json } | { problem: string } {
    if (type === "string") return { value: text };
    if (type === "boolean") return { value: flag };
    if (type === "number") {
      const n = Number(text);
      return text.trim() !== "" && Number.isFinite(n)
        ? { value: n }
        : { problem: "Enter a number" };
    }
    try {
      return { value: JSON.parse(text) as Json };
    } catch {
      return { problem: "This is not valid JSON" };
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const parsed = readValue();
    if ("problem" in parsed) {
      setError(parsed.problem);
      return;
    }
    setPending(true);
    try {
      const body = { projectSlug, key, type, value: parsed.value, description };
      if (existing) await updateVariableFn({ data: body });
      else await createVariableFn({ data: body });
      onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit variable" : "New variable"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor="variable-key">Key</FieldLabel>
            <Input
              id="variable-key"
              value={key}
              required
              disabled={Boolean(existing)}
              placeholder="baseUrl"
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="variable-type">Type</FieldLabel>
            <Select value={type} onValueChange={(value) => value && setType(value as VariableType)}>
              <SelectTrigger id="variable-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="variable-value">Value</FieldLabel>
            {type === "boolean" ? (
              <Switch id="variable-value" checked={flag} onCheckedChange={setFlag} />
            ) : type === "json" ? (
              <Textarea
                id="variable-value"
                rows={5}
                spellCheck={false}
                className="font-mono"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            ) : (
              <Input
                id="variable-value"
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="variable-description">Description</FieldLabel>
            <Input
              id="variable-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <p className="text-muted-foreground">
            Not for secrets. Values show in the UI and in run data. Use a credential for a secret.
          </p>
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
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
