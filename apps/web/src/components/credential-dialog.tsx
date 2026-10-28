// SPDX-License-Identifier: AGPL-3.0-only
import { credentialTypeCatalog } from "@zerodot/nodes";
import {
  Button,
  cn,
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
import { AlertTriangle, CheckCircle2, Loader2, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { catalogByType } from "../lib/flow";
import {
  createCredentialFn,
  credentialUsageFn,
  deleteCredentialFn,
  listCredentialsFn,
  oauth2RedirectUrlFn,
  startOAuth2Fn,
  testCredentialFn,
  updateCredentialFn,
} from "../server/settings-fns";
import { NodeIcon } from "./node-icon";

export type SavedCredential = {
  id: string;
  name: string;
  type: string;
  status?: "ok" | "needs_reconnect";
  connected?: boolean;
};

/** A credential type that a node can use, with the nodes that use it. */
type AppEntry = { type: string; label: string; icon?: string; iconUrl?: string; apps: string[] };

type Props = {
  projectSlug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit this credential. Without it, the dialog makes a new one. */
  existing?: SavedCredential;
  /** For a new credential: the types the caller can use. */
  allowedTypes?: string[];
  onSaved: (credential: SavedCredential) => void;
  /** Shows a Delete button. Called after the credential is gone. */
  onDeleted?: (id: string) => void;
};

const ACRONYMS: Record<string, string> = {
  url: "URL",
  id: "ID",
  api: "API",
  ssl: "SSL",
  tls: "TLS",
};

/** "accessToken" gives "Access token". "baseUrl" gives "Base URL". */
function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" ");
  return words
    .map(
      (w, i) =>
        ACRONYMS[w.toLowerCase()] ?? (i === 0 ? w[0]?.toUpperCase() + w.slice(1) : w.toLowerCase()),
    )
    .join(" ");
}

type TestState = "idle" | "testing" | "ok" | "unsupported" | { failed: string };

/**
 * The form never shows a saved value. When you edit, a field that you leave empty keeps its value.
 */
export function CredentialDialog({
  projectSlug,
  open,
  onOpenChange,
  existing,
  allowedTypes,
  onSaved,
  onDeleted,
}: Props) {
  // The list comes from the nodes that are loaded.
  const entries = useMemo<AppEntry[]>(() => {
    const usedBy = new Map<string, string[]>();
    for (const node of catalogByType.values()) {
      for (const type of node.credentialTypes) {
        usedBy.set(type, [...(usedBy.get(type) ?? []), node.label]);
      }
    }
    return credentialTypeCatalog
      .filter((t) => (allowedTypes ? allowedTypes.includes(t.type) : usedBy.has(t.type)))
      .map((t) => ({
        type: t.type,
        label: t.label,
        icon: t.icon,
        iconUrl: t.iconUrl,
        apps: usedBy.get(t.type) ?? [],
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [allowedTypes]);
  const singleType = existing?.type ?? (entries.length === 1 ? entries[0]?.type : undefined);
  const [type, setType] = useState(singleType ?? "");
  const [search, setSearch] = useState("");
  const [redirectUrl, setRedirectUrl] = useState<string | null>(null);
  const [name, setName] = useState(existing?.name ?? "");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A new credential becomes a saved one after the first save. The dialog stays open.
  const [savedId, setSavedId] = useState(existing?.id ?? null);
  const [test, setTest] = useState<TestState>("idle");
  const [usedBy, setUsedBy] = useState<string[] | null>(null);
  const definition = credentialTypeCatalog.find((t) => t.type === type);
  const isOAuth2 = definition?.oauth2 === true;

  useEffect(() => {
    if (!isOAuth2) return;
    oauth2RedirectUrlFn({ data: { projectSlug } })
      .then((result) => setRedirectUrl(result.url))
      .catch(() => setRedirectUrl(null));
  }, [isOAuth2, projectSlug]);
  const runTest = useCallback(
    async (id: string) => {
      setTest("testing");
      try {
        const result = await testCredentialFn({ data: { projectSlug, id } });
        setTest(
          result.status === "failed"
            ? { failed: result.message }
            : result.status === "ok"
              ? "ok"
              : "unsupported",
        );
      } catch (caught) {
        setTest({ failed: caught instanceof Error ? caught.message : "Could not test" });
      }
    },
    [projectSlug],
  );

  // An open credential tests itself. An OAuth2 credential that never connected cannot.
  // A new credential starts with the name of its type, made unique with a number.
  const label = definition?.label;
  useEffect(() => {
    if (existing || !label) return;
    let stale = false;
    listCredentialsFn({ data: { projectSlug } })
      .then((rows) => {
        const taken = new Set(rows.map((r) => r.name));
        let next = label;
        for (let n = 2; taken.has(next); n++) next = `${label} ${n}`;
        if (!stale) setName((current) => (current === "" ? next : current));
      })
      .catch(() => {
        if (!stale) setName((current) => (current === "" ? label : current));
      });
    return () => {
      stale = true;
    };
  }, [existing, label, projectSlug]);

  const existingId = existing?.id;
  const needsConnect = isOAuth2 && existing?.connected === false;
  useEffect(() => {
    if (existingId && !needsConnect) void runTest(existingId);
  }, [existingId, needsConnect, runTest]);

  useEffect(() => {
    if (!savedId) return;
    credentialUsageFn({ data: { projectSlug, id: savedId } })
      .then((rows) => setUsedBy(rows.map((r) => r.name)))
      .catch(() => setUsedBy(null));
  }, [savedId, projectSlug]);

  const schema = definition?.fieldsSchema as
    | {
        properties?: Record<
          string,
          { enum?: string[]; title?: string; description?: string; placeholder?: string }
        >;
        required?: string[];
      }
    | undefined;
  const properties = Object.keys(schema?.properties ?? {}).filter(
    (field) => !definition?.serverFields.includes(field),
  );

  async function save(connect: boolean) {
    setError(null);
    setPending(true);
    try {
      const saved = savedId
        ? await updateCredentialFn({ data: { projectSlug, id: savedId, name, fields } })
        : await createCredentialFn({ data: { projectSlug, name, type, fields } });
      setSavedId(saved.id);
      onSaved({ id: saved.id, name: saved.name, type: saved.type });
      if (connect) {
        // The browser goes to the provider. The callback brings it back to the credentials page.
        const { url } = await startOAuth2Fn({ data: { projectSlug, id: saved.id } });
        window.location.assign(url);
        return;
      }
      setFields({});
      if (isOAuth2) onOpenChange(false);
      else void runTest(saved.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save");
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!savedId || !onDeleted) return;
    setError(null);
    const users = await credentialUsageFn({ data: { projectSlug, id: savedId } });
    if (users.length > 0) {
      setError(`In use by: ${users.map((w) => w.name).join(", ")}. Remove it there first.`);
      return;
    }
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await deleteCredentialFn({ data: { projectSlug, id: savedId } });
      onDeleted(savedId);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete");
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void save(false);
  }

  const query = search.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      query === "" ||
      e.label.toLowerCase().includes(query) ||
      e.apps.some((app) => app.toLowerCase().includes(query)),
  );
  const picking = type === "";

  const labelOf = (name: string) => schema?.properties?.[name]?.title ?? humanize(name);

  const field = (name: string) => {
    const spec = schema?.properties?.[name];
    return spec?.enum ? (
      <Select
        value={fields[name] ?? ""}
        items={spec.enum.map((v) => ({ value: v, label: v }))}
        onValueChange={(v) => setFields((f) => ({ ...f, [name]: v ?? "" }))}
      >
        <SelectTrigger id={`credential-${name}`}>
          <SelectValue placeholder={savedId ? "Keep the saved value" : "Default"} />
        </SelectTrigger>
        <SelectContent>
          {spec.enum.map((v) => (
            <SelectItem key={v} value={v}>
              {v}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : (
      <Input
        id={`credential-${name}`}
        type={definition?.secretFields.includes(name) ? "password" : "text"}
        autoComplete="off"
        required={!savedId && schema?.required?.includes(name)}
        placeholder={
          savedId ? "Leave empty to keep the saved value" : schema?.properties?.[name]?.placeholder
        }
        value={fields[name] ?? ""}
        onChange={(event) => setFields((f) => ({ ...f, [name]: event.target.value }))}
      />
    );
  };

  const status =
    savedId && test !== "idle" && test !== "unsupported" ? (
      <button
        type="button"
        disabled={test === "testing"}
        onClick={() => void runTest(savedId)}
        title="Test again"
        className={cn(
          "flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs transition-colors duration-150",
          test === "ok" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
          typeof test === "object" && "bg-destructive/10 text-destructive",
          test === "testing" && "bg-muted text-muted-foreground",
        )}
      >
        {test === "testing" ? (
          <Loader2 className="size-3 animate-spin" />
        ) : test === "ok" ? (
          <CheckCircle2 className="size-3" />
        ) : (
          <AlertTriangle className="size-3" />
        )}
        {test === "testing" ? "Checking" : test === "ok" ? "Working" : "Failed"}
      </button>
    ) : null;

  if (picking) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add new credential</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Field>
              <FieldLabel htmlFor="credential-search">
                Select an app or service to connect to
              </FieldLabel>
              <Input
                id="credential-search"
                type="search"
                autoComplete="off"
                autoFocus
                placeholder="Search for app..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </Field>
            <ul className="flex max-h-72 flex-col overflow-y-auto">
              {shown.map((entry) => (
                <li key={entry.type}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-muted"
                    onClick={() => setType(entry.type)}
                  >
                    <NodeIcon name={entry.icon ?? "KeyRound"} src={entry.iconUrl} />
                    <span className="flex-1">{entry.label}</span>
                    {entry.apps.length > 0 && (
                      <span className="max-w-40 truncate text-muted-foreground">
                        {entry.apps.slice(0, 3).join(", ")}
                      </span>
                    )}
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-2 py-2 text-muted-foreground">No match.</li>}
            </ul>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0" initialFocus={false}>
        <form onSubmit={onSubmit} className="flex flex-col">
          <DialogHeader className="flex-row items-center gap-3 px-5 pt-5 pr-12">
            <NodeIcon name={definition?.icon ?? "KeyRound"} src={definition?.iconUrl} />
            <DialogTitle className="sr-only">{definition?.label}</DialogTitle>
            <Input
              aria-label="Credential name"
              value={name}
              required
              className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1 font-semibold shadow-none"
              onChange={(event) => setName(event.target.value)}
            />
            {status}
          </DialogHeader>
          <div className="flex max-h-[60svh] flex-col gap-4 overflow-y-auto px-5 py-4">
            {typeof test === "object" && savedId && (
              <p role="alert" className="text-destructive">
                {test.failed}
              </p>
            )}
            {properties.map((name) => (
              <Field key={name}>
                <FieldLabel htmlFor={`credential-${name}`}>{labelOf(name)}</FieldLabel>
                {field(name)}
                {schema?.properties?.[name]?.description && (
                  <p className="text-muted-foreground">{schema.properties[name].description}</p>
                )}
              </Field>
            ))}
            {isOAuth2 && (
              <Field>
                <FieldLabel htmlFor="credential-redirect">Redirect URL</FieldLabel>
                <Input
                  id="credential-redirect"
                  readOnly
                  value={redirectUrl ?? ""}
                  onFocus={(e) => e.target.select()}
                />
                <p className="text-muted-foreground">
                  Add this address to the app at the provider.
                </p>
              </Field>
            )}
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 border-t px-5 py-3">
            <p className="min-w-0 flex-1 truncate text-muted-foreground">
              {usedBy && usedBy.length > 0
                ? `Used by ${usedBy.join(", ")}`
                : "Stored encrypted. Never shown again."}
            </p>
            {savedId && onDeleted && (
              <Button type="button" variant="ghost" onClick={() => void remove()}>
                <Trash2 />
                Delete
              </Button>
            )}
            {isOAuth2 && (
              <Button type="button" disabled={pending} onClick={() => void save(true)}>
                {existing?.connected ? "Save and reconnect" : "Save and connect"}
              </Button>
            )}
            <Button type="submit" variant={isOAuth2 ? "outline" : "default"} disabled={pending}>
              Save
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
