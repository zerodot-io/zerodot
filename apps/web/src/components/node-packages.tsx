// SPDX-License-Identifier: AGPL-3.0-only

import { Alert02Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Tooltip,
  toast,
} from "@zerodot/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { addServerCatalog } from "../lib/flow";
import {
  addNodeRegistryFn,
  getAvailableNodePackagesFn,
  getExtraCatalogFn,
  getNodePackagesFn,
  getNodePackageVersionsFn,
  installNodePackageFn,
  refreshNodePackagesFn,
  removeNodeRegistryFn,
  uninstallNodePackageFn,
  updateNodePackageFn,
} from "../server/fns";
import { ConfirmDialog } from "./confirm-dialog";
import { NodeIcon } from "./node-icon";

/** A small warning icon. The tooltip tells what is wrong and what to do. */
export function Warning({
  label,
  tone = "warning",
}: {
  label: string;
  tone?: "warning" | "error";
}) {
  return (
    <Tooltip label={label}>
      <span
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user must reach the tooltip.
        tabIndex={0}
        className={`inline-flex rounded-sm ${tone === "error" ? "text-destructive" : "text-amber-600"}`}
      >
        <HugeiconsIcon icon={Alert02Icon} className="size-4" />
      </span>
    </Tooltip>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong";
}

/**
 * Asks the server for the nodes and credential types that packages added, and adds them to the
 * editor. Call it after an install, so a new node shows without a page reload.
 */
export async function refreshServerCatalog(): Promise<void> {
  addServerCatalog(await getExtraCatalogFn());
}

/** What a person must know before they install: the code runs on the server. */
function InstallConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: { name: string; label: string; version: string | null };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Install ${item.label}?`}
      description={`This adds the nodes of ${item.name}${item.version ? ` ${item.version}` : ""} to every project. The package code runs on the server with the same rights as zerodot. Install only packages that you trust.`}
      action={busy ? "Installing" : "Install"}
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** What a community package can do on this server. Shown before each step that adds such code. */
function RiskWarning({
  title,
  lead,
  verified = false,
}: {
  title: string;
  lead: string;
  /** The zerodot team reviewed the source of this version. */
  verified?: boolean;
}) {
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg bg-destructive/10 p-3">
      <p className="font-medium text-destructive">{title}</p>
      <p className="text-pretty">{lead}</p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-pretty">
        <li>
          {verified
            ? "The zerodot team read the source of this version. That makes bad code less likely, but not impossible."
            : "zerodot does not check this code. A new version can add bad code at any time."}
        </li>
        <li>
          The code runs on your server, in its own process. It cannot read the secret keys, the
          database, or the files of zerodot.
        </li>
        <li>
          It gets the credentials and the data that your workflows give to its nodes. It can send
          them to any server on the internet.
        </li>
        <li>
          It can use the internet. zerodot stops it from reaching addresses inside the network of
          your server.
        </li>
        <li>It runs as soon as it is installed, also when no workflow uses its nodes.</li>
      </ul>
      <p className="text-pretty font-medium">
        Continue only when you know and trust the author. If you are not sure, stop.
      </p>
    </div>
  );
}

/** A box that the admin must tick to accept the risk. */
function AcceptRisk({
  checked,
  disabled,
  onChange,
  children,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-pretty">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 shrink-0 accent-destructive"
      />
      <span>{children}</span>
    </label>
  );
}

/**
 * Asks before a community package is installed. The admin ticks a box and types the package name,
 * so the install cannot happen by one fast click.
 */
export function CommunityInstallConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: {
    name: string;
    label: string;
    version: string;
    registry: { name: string; url: string };
    verified: boolean;
  };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [accepted, setAccepted] = useState(false);
  const [typed, setTyped] = useState("");
  const typedId = useId();
  const ready = accepted && typed.trim() === item.name;
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Install community package {item.label}?</DialogTitle>
          <DialogDescription>
            <span className="font-mono">
              {item.name}@{item.version}
            </span>{" "}
            from the registry {item.registry.name} (
            <span className="break-all font-mono">{item.registry.url}</span>).
          </DialogDescription>
        </DialogHeader>
        <RiskWarning
          title={
            item.verified
              ? "Verified, but not written by zerodot"
              : "zerodot did not check this package"
          }
          lead="Somebody outside zerodot wrote this package. If it has bad code, it can steal the credentials and the data that your workflows give to its nodes."
          verified={item.verified}
        />
        <AcceptRisk checked={accepted} disabled={busy} onChange={setAccepted}>
          I know who wrote this package, I trust them, and I accept the risk for this instance.
        </AcceptRisk>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={typedId}>
            Type <span className="font-mono">{item.name}</span> to continue
          </label>
          <Input
            id={typedId}
            value={typed}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !ready} onClick={onConfirm}>
            {busy && <Spinner />}
            {busy ? "Installing" : "Install anyway"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Adds a community registry, after the admin reads what it means. */
function AddRegistryDialog({
  busy,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [accepted, setAccepted] = useState(false);
  const urlId = useId();
  const ready = accepted && url.trim().startsWith("https://");
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a community registry</DialogTitle>
          <DialogDescription>
            A registry is a <span className="font-mono">registry.json</span> file that lists node
            packages on npm. Its packages show on this page. Nothing is installed until you install
            a package.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !busy) onConfirm(url.trim());
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={urlId}>Registry address</label>
            <Input
              id={urlId}
              type="url"
              value={url}
              disabled={busy}
              placeholder="https://example.com/registry.json"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <RiskWarning
            title="Anybody can make a registry"
            lead="zerodot does not check registries or the packages in them. A registry can list packages with bad code, or packages with names that look like ones you know. Each package that you install from it can do all of this:"
          />
          <AcceptRisk checked={accepted} disabled={busy} onChange={setAccepted}>
            I trust the owner of this registry, and I accept the risk for this instance.
          </AcceptRisk>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={busy || !ready}>
              {busy && <Spinner />}
              {busy ? "Adding" : "Add registry"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Asks before a package goes away: workflows that use its nodes stop working. */
function RemoveConfirm({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: { name: string; label: string };
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      title={`Remove ${item.label}?`}
      description={`This removes the nodes of ${item.name} from every project. Workflows that use these nodes stop working until you install the package again.`}
      action={busy ? "Removing" : "Remove"}
      cancel="Keep"
      destructive
      busy={busy}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

/** Numbers of a version, to tell an update from a downgrade. Plain numbers only. */
const parts = (version: string): number[] => version.split(".").map((n) => Number.parseInt(n, 10));

/** True when `latest` is a higher version than `installed`. Plain numbers only. */
function isNewer(latest: string | null, installed: string | null): boolean {
  if (!latest || !installed) return false;
  const a = parts(latest);
  const b = parts(installed);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/** Picks another version of an installed package, newer or older. The change needs no restart. */
function VersionDialog({
  item,
  community,
  busy,
  onCancel,
  onConfirm,
}: {
  item: { name: string; label: string; version: string };
  /** True for a package from a community registry: the admin must accept the risk again. */
  community: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (version: string) => void;
}) {
  const [versions, setVersions] = useState<string[] | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const close = useRef(onCancel);
  close.current = onCancel;

  useEffect(() => {
    getNodePackageVersionsFn({ data: { name: item.name } }).then(
      (found) => {
        setVersions(found.versions);
        setTarget(found.versions.find((version) => version !== item.version) ?? null);
      },
      (error) => {
        toast.error(errorText(error));
        close.current();
      },
    );
  }, [item.name, item.version]);

  const newer = target !== null && isNewer(target, item.version);
  const action = target === null ? "Change" : newer ? "Update" : "Downgrade";
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Change version of {item.label}</DialogTitle>
          <DialogDescription>
            The new version runs at once, with no restart. Open workflow runs finish with the old
            version. The package code runs on the server with the same rights as zerodot. If the new
            version does not load, the old one stays.
          </DialogDescription>
        </DialogHeader>
        {versions === null ? (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner />
            Loading versions
          </p>
        ) : versions.every((version) => version === item.version) ? (
          <p className="text-muted-foreground">
            No other version is available. {item.version} is the only version that this zerodot can
            use.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <span className="tabular-nums text-muted-foreground">{item.version}</span>
            <span aria-hidden="true">→</span>
            <Select
              items={versions.map((version) => ({ value: version, label: version }))}
              value={target ?? ""}
              onValueChange={(next) => setTarget(next)}
            >
              <SelectTrigger className="w-40" aria-label="Version">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((version) => (
                  <SelectItem key={version} value={version} disabled={version === item.version}>
                    {version}
                    {version === item.version ? " (installed)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {community && (
          <>
            <RiskWarning
              title="This version was not checked"
              lead="This is a community package. zerodot did not check this version, or any other one."
            />
            <AcceptRisk checked={accepted} disabled={busy} onChange={setAccepted}>
              I trust the author of this version, and I accept the risk for this instance.
            </AcceptRisk>
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={community ? "destructive" : "default"}
            disabled={busy || target === null || (community && !accepted)}
            onClick={() => target && onConfirm(target)}
          >
            {busy ? "Changing" : action}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Overview = Awaited<ReturnType<typeof getNodePackagesFn>>;
type PackageView = Overview["packages"][number];

const STATUS: Record<PackageView["status"], { text: string; dot: string }> = {
  loaded: { text: "Installed", dot: "bg-emerald-500" },
  error: { text: "Failed to load", dot: "bg-destructive" },
  "not-loaded": { text: "Not loaded yet", dot: "bg-amber-500" },
  available: { text: "Not installed", dot: "bg-muted-foreground/40" },
};

const matchesPackage = (item: PackageView, query: string): boolean =>
  `${item.label} ${item.name} ${item.description} ${item.nodes
    .map((node) => `${node.label} ${node.description ?? ""} ${node.type}`)
    .join(" ")}`
    .toLowerCase()
    .includes(query);

function PackageRow({
  item,
  canChange,
  busy,
  onInstall,
  onVersion,
  onRemove,
}: {
  item: PackageView;
  canChange: boolean;
  busy: boolean;
  onInstall: () => void;
  onVersion: () => void;
  onRemove: () => void;
}) {
  const installed = item.version !== null;
  const status = STATUS[item.status];
  const [open, setOpen] = useState(false);
  const summary = item.summary || item.description;
  const hasDetails = item.description !== "" || item.nodes.length > 0;
  const hasUpdate = item.compatible && isNewer(item.latest, item.version);
  return (
    <li className="flex items-start gap-4 px-4 py-4 max-md:flex-wrap">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <NodeIcon name={item.icon ?? "PackageIcon"} src={item.iconUrl ?? undefined} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{item.label}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${status.dot}`} />
            {status.text}
            {installed && <span className="tabular-nums">· {item.version}</span>}
          </span>
          {item.error && <Warning label={item.error} tone="error" />}
          {!installed && item.incompatible && <Warning label={item.incompatible} />}
          {hasUpdate && <Badge variant="secondary">Update {item.latest}</Badge>}
          {item.source === "env" && <Badge variant="outline">ZERODOT_NODE_PACKAGES</Badge>}
          {item.registry && (
            <Badge variant="outline" title={item.registry.url}>
              {item.verified ? (
                <span>Verified</span>
              ) : (
                <span className="text-destructive">Community</span>
              )}{" "}
              · {item.registry.name}
            </Badge>
          )}
        </div>
        {summary && <p className="text-pretty">{summary}</p>}
        <div className="flex flex-wrap items-center gap-x-3 text-muted-foreground">
          <span className="font-mono">{item.name}</span>
          {hasDetails && (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="rounded-md px-1 transition-colors duration-150 ease-out hover:text-foreground"
            >
              {open ? "Hide details" : "Details"}
            </button>
          )}
        </div>
        {open && (
          <div className="mt-1 flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
            {item.description && <p className="text-pretty">{item.description}</p>}
            {item.nodes.length > 0 && (
              <ul className="flex flex-col gap-1">
                {item.nodes.map((node) => (
                  <li key={node.type} className="flex flex-col">
                    <span className="font-medium">{node.label}</span>
                    {node.description && (
                      <span className="text-pretty text-muted-foreground">{node.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      {/* On a phone the buttons go under the text, in line with it. */}
      {canChange && (
        <div className="flex shrink-0 gap-2 max-md:w-full max-md:pl-14">
          {installed ? (
            <>
              <Button
                variant={hasUpdate ? "default" : "outline"}
                disabled={busy || item.source === "env"}
                title={item.source === "env" ? "Change it in ZERODOT_NODE_PACKAGES" : undefined}
                onClick={onVersion}
              >
                {hasUpdate ? "Update" : "Version"}
              </Button>
              <Button
                variant="outline"
                disabled={busy || item.source === "env"}
                title={item.source === "env" ? "Remove it from ZERODOT_NODE_PACKAGES" : undefined}
                onClick={onRemove}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button disabled={busy || !item.compatible} onClick={onInstall}>
              {busy ? "Installing" : "Install"}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function PackageGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="flex items-baseline gap-2 font-medium">
        {title}
        <span className="tabular-nums text-muted-foreground">{count}</span>
      </h2>
      <ul className="divide-y overflow-hidden rounded-xl border">{children}</ul>
    </section>
  );
}

type RegistryView = Overview["registries"][number];

/** The community registries of this instance, and a way to add or remove one. */
function RegistryList({
  registries,
  enabled,
  onAdd,
  onRemove,
}: {
  registries: RegistryView[];
  enabled: boolean;
  onAdd: () => void;
  onRemove: (registry: RegistryView) => void;
}) {
  return (
    <section aria-label="Community registries" className="overflow-hidden rounded-xl border">
      <div className="flex items-start justify-between gap-4 bg-muted/50 px-4 py-3 max-md:flex-col max-md:gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-baseline gap-2 font-medium">
            Community registries
            <span className="tabular-nums text-muted-foreground">{registries.length}</span>
          </h2>
          <p className="max-w-prose text-pretty text-muted-foreground">
            Other people make these packages. zerodot does not check them, and their code can do
            anything on this server.
          </p>
        </div>
        {enabled && (
          <Button variant="outline" onClick={onAdd}>
            Add registry
          </Button>
        )}
      </div>
      {!enabled && (
        <p className="border-t px-4 py-3 text-pretty">
          Community packages are off on this instance. To turn them on, the operator sets{" "}
          <code className="font-mono">ZERODOT_COMMUNITY_NODES=true</code>.
        </p>
      )}
      {registries.length > 0 && (
        <ul className="divide-y border-t">
          {registries.map((registry) => (
            <li key={registry.url} className="flex items-start gap-4 px-4 py-3">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{registry.name}</span>
                  {!registry.error && (
                    <span className="tabular-nums text-muted-foreground">
                      {registry.count} {registry.count === 1 ? "package" : "packages"}
                    </span>
                  )}
                </span>
                <span className="break-all font-mono text-muted-foreground">{registry.url}</span>
                {registry.error && <span className="text-destructive">{registry.error}</span>}
              </div>
              <Button variant="outline" onClick={() => onRemove(registry)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type Filter = "all" | "installed" | "available";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "installed", label: "Installed" },
  { value: "available", label: "Not installed" },
];

/** The Nodes page of the System section: what is installed, and what one can install. */
export function NodePackagesSection() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirm, setConfirm] = useState<PackageView | null>(null);
  const [versionOf, setVersionOf] = useState<PackageView | null>(null);
  const [removing, setRemoving] = useState<PackageView | null>(null);
  const [addingRegistry, setAddingRegistry] = useState(false);
  const [removingRegistry, setRemovingRegistry] = useState<RegistryView | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setOverview(await getNodePackagesFn());
    } catch (error) {
      toast.error(errorText(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Reads the catalog again. The server keeps it for ten minutes, so a new version waits. */
  async function refresh() {
    setRefreshing(true);
    try {
      setOverview(await refreshNodePackagesFn());
      toast.success("Packages refreshed");
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setRefreshing(false);
    }
  }

  async function change(name: string, work: () => Promise<unknown>, done: string) {
    setBusy(name);
    try {
      await work();
      await refreshServerCatalog();
      toast.success(done);
      await load();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
      setConfirm(null);
      setVersionOf(null);
      setRemoving(null);
    }
  }

  async function changeRegistry(work: () => Promise<unknown>, done: string) {
    setBusy("registry");
    try {
      await work();
      toast.success(done);
      await load();
      setAddingRegistry(false);
      setRemovingRegistry(null);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  }

  if (!overview) {
    return (
      <div role="status" aria-label="Loading packages" className="flex flex-col gap-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  const text = query.trim().toLowerCase();
  const found = overview.packages.filter((item) => !text || matchesPackage(item, text));
  const installed = found.filter((item) => item.version !== null);
  const available = found.filter((item) => item.version === null && !item.registry);
  const community = found.filter((item) => item.version === null && item.registry);
  const counts: Record<Filter, number> = {
    all: found.length,
    installed: installed.length,
    available: available.length + community.length,
  };
  const showInstalled = filter !== "available" && installed.length > 0;
  const showAvailable = filter !== "installed" && available.length > 0;
  const showCommunity = filter !== "installed" && community.length > 0;

  const row = (item: PackageView) => (
    <PackageRow
      key={item.name}
      item={item}
      canChange={
        overview.installEnabled &&
        (!item.registry ||
          item.version !== null ||
          (overview.communityEnabled && (item.verified || overview.unverifiedEnabled)))
      }
      busy={busy === item.name}
      onInstall={() => setConfirm(item)}
      onVersion={() => setVersionOf(item)}
      onRemove={() => setRemoving(item)}
    />
  );

  return (
    <div className="flex flex-col gap-6">
      <p className="max-w-prose text-pretty text-muted-foreground">
        zerodot comes with the core nodes. Install a package to add more nodes, for example
        databases, email, or chat apps.
        {!overview.installEnabled && " Installing is off on this instance (ZERODOT_NODES_INSTALL)."}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter packages" className="-mx-2.5 flex gap-1">
          {FILTERS.map((option) => {
            const on = option.value === filter;
            return (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setFilter(option.value)}
                className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 transition-colors duration-150 ease-out hover:text-foreground ${on ? "bg-muted font-medium text-foreground" : "text-muted-foreground"}`}
              >
                {option.label}
                <span className="tabular-nums text-muted-foreground">{counts[option.value]}</span>
              </button>
            );
          })}
        </div>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, node, or use"
            aria-label="Search packages"
            className="w-full sm:w-72"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh packages"
            title="Refresh packages"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            <HugeiconsIcon icon={RefreshIcon} className={refreshing ? "animate-spin" : undefined} />
          </Button>
        </div>
      </div>

      {showInstalled && (
        <PackageGroup title="Installed" count={installed.length}>
          {installed.map(row)}
        </PackageGroup>
      )}
      {showAvailable && (
        <PackageGroup title="Available" count={available.length}>
          {available.map(row)}
        </PackageGroup>
      )}
      {showCommunity && (
        <PackageGroup title="Community" count={community.length}>
          {community.map(row)}
        </PackageGroup>
      )}
      {!showInstalled && !showAvailable && !showCommunity && (
        <Empty>
          <EmptyHeader>
            <EmptyDescription>
              {overview.packages.length === 0
                ? "No packages yet."
                : text
                  ? `No package matches "${query.trim()}".`
                  : "Nothing in this list."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {overview.catalogError && (
        <p className="text-muted-foreground">
          The list of packages could not be read: {overview.catalogError}
        </p>
      )}

      {overview.installEnabled && (
        <RegistryList
          registries={overview.registries}
          enabled={overview.communityEnabled}
          onAdd={() => setAddingRegistry(true)}
          onRemove={setRemovingRegistry}
        />
      )}
      {addingRegistry && (
        <AddRegistryDialog
          busy={busy === "registry"}
          onCancel={() => setAddingRegistry(false)}
          onConfirm={(url) =>
            void changeRegistry(
              () => addNodeRegistryFn({ data: { url, acceptRisk: true } }),
              "Registry added",
            )
          }
        />
      )}
      {removingRegistry && (
        <ConfirmDialog
          title={`Remove ${removingRegistry.name}?`}
          description="Its packages no longer show here. Packages that you installed from it stay installed. Remove them one by one."
          action={busy === "registry" ? "Removing" : "Remove"}
          cancel="Keep"
          destructive
          busy={busy === "registry"}
          onCancel={() => setRemovingRegistry(null)}
          onConfirm={() =>
            void changeRegistry(
              () => removeNodeRegistryFn({ data: { url: removingRegistry.url } }),
              `${removingRegistry.name} removed`,
            )
          }
        />
      )}

      {versionOf?.version && (
        <VersionDialog
          item={{ name: versionOf.name, label: versionOf.label, version: versionOf.version }}
          community={versionOf.registry !== null}
          busy={busy === versionOf.name}
          onCancel={() => setVersionOf(null)}
          onConfirm={(version) =>
            void change(
              versionOf.name,
              () =>
                updateNodePackageFn({
                  data: {
                    name: versionOf.name,
                    version,
                    acceptRisk: versionOf.registry !== null,
                  },
                }),
              `${versionOf.label} is now ${version}`,
            )
          }
        />
      )}
      {removing && (
        <RemoveConfirm
          item={removing}
          busy={busy === removing.name}
          onCancel={() => setRemoving(null)}
          onConfirm={() =>
            void change(
              removing.name,
              () => uninstallNodePackageFn({ data: { name: removing.name } }),
              `${removing.label} removed`,
            )
          }
        />
      )}
      {confirm?.registry && confirm.latest && (
        <CommunityInstallConfirm
          item={{
            name: confirm.name,
            label: confirm.label,
            version: confirm.latest,
            registry: confirm.registry,
            verified: confirm.verified,
          }}
          busy={busy === confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void change(
              confirm.name,
              () =>
                installNodePackageFn({
                  data: {
                    name: confirm.name,
                    registry: confirm.registry?.url,
                    version: confirm.latest ?? undefined,
                    acceptRisk: true,
                  },
                }),
              `${confirm.label} installed`,
            )
          }
        />
      )}
      {confirm && !confirm.registry && (
        <InstallConfirm
          item={{ name: confirm.name, label: confirm.label, version: confirm.latest }}
          busy={busy === confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            void change(
              confirm.name,
              () => installNodePackageFn({ data: { name: confirm.name } }),
              `${confirm.label} installed`,
            )
          }
        />
      )}
    </div>
  );
}

type Available = Awaited<ReturnType<typeof getAvailableNodePackagesFn>>;

const matches = (item: Available["packages"][number], query: string): boolean =>
  `${item.label} ${item.name} ${item.description} ${item.nodes
    .map((node) => `${node.label} ${node.description ?? ""} ${node.type}`)
    .join(" ")}`
    .toLowerCase()
    .includes(query);

/**
 * Packages that are not installed, in the Add node list. A search narrows the list.
 * An instance admin can install one here. Others see who to ask.
 */
export function AvailableNodePackages({
  query,
  onInstalled,
  showEmpty = false,
}: {
  query: string;
  onInstalled: () => void;
  /** Say "No nodes found" when this list has no match too. The caller has no node match. */
  showEmpty?: boolean;
}) {
  const [available, setAvailable] = useState<Available | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Available["packages"][number] | null>(null);

  useEffect(() => {
    getAvailableNodePackagesFn().then(setAvailable, () => setAvailable(null));
  }, []);

  async function install(item: Available["packages"][number]) {
    setBusy(item.name);
    try {
      await installNodePackageFn({ data: { name: item.name } });
      await refreshServerCatalog();
      setAvailable((current) =>
        current
          ? { ...current, packages: current.packages.filter((p) => p.name !== item.name) }
          : current,
      );
      toast.success(`${item.label} installed`);
      onInstalled();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const text = query.trim().toLowerCase();
  if (!available) return null;
  const found = available.packages.filter((item) => matches(item, text));
  if (found.length === 0) {
    return showEmpty ? <p className="px-2 text-muted-foreground">No nodes found</p> : null;
  }
  return (
    <div className="flex flex-col">
      <span className="px-2 py-1.5 font-medium">Not installed ({found.length})</span>
      {found.map((item) => (
        <div key={item.name} className="flex items-center gap-3 rounded-lg px-2 py-2">
          <NodeIcon name={item.icon ?? "PackageIcon"} src={item.iconUrl ?? undefined} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-center gap-1.5">
              {item.label}
              {item.incompatible && <Warning label={item.incompatible} />}
            </span>
            <span className="text-muted-foreground">{item.summary || item.description}</span>
          </span>
          {available.canInstall ? (
            <Button disabled={busy !== null || !item.compatible} onClick={() => setConfirm(item)}>
              {busy === item.name ? "Installing" : "Install"}
            </Button>
          ) : (
            item.compatible && <span className="text-muted-foreground">Ask an admin</span>
          )}
        </div>
      ))}
      {confirm && (
        <InstallConfirm
          item={{ name: confirm.name, label: confirm.label, version: confirm.version }}
          busy={busy === confirm.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void install(confirm)}
        />
      )}
    </div>
  );
}
