// SPDX-License-Identifier: AGPL-3.0-only
import { Badge, Button, toast } from "@zerodot/ui";
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

type Overview = Awaited<ReturnType<typeof getNodePackagesFn>>;
type PackageView = Overview["packages"][number];

const STATUS_TEXT: Record<PackageView["status"], string> = {
  loaded: "Installed",
  error: "Failed to load",
  "not-loaded": "Installed, not loaded yet",
  available: "Not installed",
};

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
  return (
    <div className="flex items-start justify-between gap-4 rounded-xl border p-4">
      <NodeIcon name={item.icon ?? "Package"} src={item.iconUrl ?? undefined} className="mt-0.5" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center gap-2 font-medium">
          {item.label}
          <Badge variant={item.status === "error" ? "destructive" : "secondary"}>
            {installed ? `${STATUS_TEXT[item.status]} ${item.version}` : STATUS_TEXT[item.status]}
          </Badge>
          {item.source === "env" && <Badge variant="outline">ZERODOT_NODE_PACKAGES</Badge>}
        </span>
        <span className="text-muted-foreground">{item.name}</span>
        {item.description && <span className="text-muted-foreground">{item.description}</span>}
        {item.nodes.length > 0 && (
          <span className="text-muted-foreground">
            {item.nodes.map((node) => node.label).join(", ")}
          </span>
        )}
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
    </div>
  );
}

/** The Nodes section of the System page: what is installed, and what one can install. */
export function NodePackagesSection() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
    }
  }

  if (!overview) return null;
  const installed = overview.packages.filter((item) => item.version !== null);
  const available = overview.packages.filter((item) => item.version === null);
  return (
    <section className="flex flex-col gap-3">
      <p className="text-muted-foreground">
        zerodot comes with the core nodes. Install the others when you need them.
        {!overview.installEnabled && " Installing is off on this instance (ZERODOT_NODES_INSTALL)."}
      </p>
      {installed.length === 0 && available.length === 0 && (
        <p className="text-muted-foreground">No packages yet.</p>
      )}
      {installed.map((item) => (
        <PackageRow
          key={item.name}
          item={item}
          canChange={overview.installEnabled}
          busy={busy === item.name}
          onInstall={() => undefined}
          onRemove={() =>
            void change(
              item.name,
              () => uninstallNodePackageFn({ data: { name: item.name } }),
              `${item.label} removed`,
            )
          }
        />
      ))}
      {available.map((item) => (
        <PackageRow
          key={item.name}
          item={item}
          canChange={overview.installEnabled}
          busy={busy === item.name}
          onInstall={() =>
            void change(
              item.name,
              () => installNodePackageFn({ data: { name: item.name } }),
              `${item.label} installed`,
            )
          }
          onRemove={() => undefined}
        />
      ))}
      {overview.catalogError && (
        <p className="text-muted-foreground">
          The list of packages could not be read: {overview.catalogError}
        </p>
      )}
    </section>
  );
}

type Available = Awaited<ReturnType<typeof getAvailableNodePackagesFn>>;

const matches = (item: Available["packages"][number], query: string): boolean =>
  `${item.label} ${item.name} ${item.description} ${item.nodes.map((node) => node.label).join(" ")}`
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
                ? item.nodes.map((node) => node.label).join(", ") || item.description
                : "Needs a newer zerodot"}
            </span>
          </span>
          {item.compatible &&
            (available.canInstall ? (
              <Button disabled={busy !== null} onClick={() => void install(item)}>
                {busy === item.name ? "Installing" : "Install"}
              </Button>
            ) : (
              <span className="text-muted-foreground">Ask an admin</span>
            ))}
        </div>
      ))}
    </div>
  );
}
