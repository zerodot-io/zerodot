// SPDX-License-Identifier: AGPL-3.0-only
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  toast,
} from "@zerodot/ui";
import { useCallback, useEffect, useState } from "react";
import { addServerCatalog } from "../lib/flow";
import {
  getAvailableNodePackagesFn,
  getExtraCatalogFn,
  getNodePackagesFn,
  installNodePackageFn,
  uninstallNodePackageFn,
} from "../server/fns";
import { NodeIcon } from "./node-icon";

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
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install {item.label}?</DialogTitle>
          <DialogDescription>
            This adds the nodes of {item.name}
            {item.version ? ` ${item.version}` : ""} to every project. The package code runs on the
            server with the same rights as zerodot. Install only packages that you trust.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" disabled={busy} onClick={onConfirm}>
            {busy ? "Installing" : "Install"}
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
  onRemove,
}: {
  item: PackageView;
  canChange: boolean;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const installed = item.version !== null;
  const status = STATUS[item.status];
  return (
    <li className="flex items-start gap-4 px-4 py-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
        <NodeIcon name={item.icon ?? "Package"} src={item.iconUrl ?? undefined} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{item.label}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden="true" className={`size-1.5 rounded-full ${status.dot}`} />
            {status.text}
            {installed && <span className="tabular-nums">· {item.version}</span>}
          </span>
          {isNewer(item.latest, item.version) && (
            <Badge variant="secondary">Update {item.latest}</Badge>
          )}
          {item.source === "env" && <Badge variant="outline">ZERODOT_NODE_PACKAGES</Badge>}
        </div>
        {item.description && <p className="text-pretty">{item.description}</p>}
        <span className="font-mono text-muted-foreground">{item.name}</span>
        {item.error && <span className="text-destructive">{item.error}</span>}
      </div>
      {canChange &&
        (installed ? (
          <Button
            variant="outline"
            disabled={busy || item.source === "env"}
            title={item.source === "env" ? "Remove it from ZERODOT_NODE_PACKAGES" : undefined}
            onClick={onRemove}
          >
            Remove
          </Button>
        ) : (
          <Button disabled={busy} onClick={onInstall}>
            {busy ? "Installing" : "Install"}
          </Button>
        ))}
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
    }
  }

  if (!overview) return null;
  const text = query.trim().toLowerCase();
  const found = overview.packages.filter((item) => !text || matchesPackage(item, text));
  const installed = found.filter((item) => item.version !== null);
  const available = found.filter((item) => item.version === null);
  const counts: Record<Filter, number> = {
    all: found.length,
    installed: installed.length,
    available: available.length,
  };
  const showInstalled = filter !== "available" && installed.length > 0;
  const showAvailable = filter !== "installed" && available.length > 0;

  const row = (item: PackageView) => (
    <PackageRow
      key={item.name}
      item={item}
      canChange={overview.installEnabled}
      busy={busy === item.name}
      onInstall={() => setConfirm(item)}
      onRemove={() =>
        void change(
          item.name,
          () => uninstallNodePackageFn({ data: { name: item.name } }),
          `${item.label} removed`,
        )
      }
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
        <div role="tablist" aria-label="Filter packages" className="flex gap-1">
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
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name, node, or use"
          aria-label="Search packages"
          className="w-72"
        />
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
      {!showInstalled && !showAvailable && (
        <p className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
          {overview.packages.length === 0
            ? "No packages yet."
            : text
              ? `No package matches "${query.trim()}".`
              : "Nothing in this list."}
        </p>
      )}
      {overview.catalogError && (
        <p className="text-muted-foreground">
          The list of packages could not be read: {overview.catalogError}
        </p>
      )}

      {confirm && (
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
}: {
  query: string;
  onInstalled: () => void;
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
  if (found.length === 0) return null;
  return (
    <div className="flex flex-col">
      <span className="px-2 py-1.5 font-medium">Not installed ({found.length})</span>
      {found.map((item) => (
        <div key={item.name} className="flex items-center gap-3 rounded-lg px-2 py-2">
          <NodeIcon name={item.icon ?? "Package"} src={item.iconUrl ?? undefined} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span>{item.label}</span>
            <span className="text-muted-foreground">
              {item.compatible
                ? item.description || item.nodes.map((node) => node.label).join(", ")
                : "Needs a newer zerodot"}
            </span>
          </span>
          {item.compatible &&
            (available.canInstall ? (
              <Button disabled={busy !== null} onClick={() => setConfirm(item)}>
                {busy === item.name ? "Installing" : "Install"}
              </Button>
            ) : (
              <span className="text-muted-foreground">Ask an admin</span>
            ))}
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
