// SPDX-License-Identifier: AGPL-3.0-only

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@zerodot/ui";
import { useState } from "react";
import { type credentialPackagesFn, installNodePackageFn } from "../server/fns";
import { NodeIcon } from "./node-icon";
import { CommunityInstallConfirm, refreshServerCatalog } from "./node-packages";

export type NeededPackages = Awaited<ReturnType<typeof credentialPackagesFn>>;
type NeededPackage = NeededPackages["packages"][number];

/** The package that gives the credential type, when one does. */
export const packageForType = (needed: NeededPackages | null, type: string) =>
  needed?.packages.find((item) => item.types.includes(type));

/**
 * A saved credential has a type that no installed package gives. An instance admin installs the
 * package here. Others see which package to ask for.
 */
export function MissingCredentialDialog({
  type,
  needed,
  onClose,
  onInstalled,
}: {
  type: string;
  needed: NeededPackages | null;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<NeededPackage | null>(null);
  const item = packageForType(needed, type);
  const canInstall =
    !!needed &&
    !!item?.compatible &&
    (item.registry ? needed.canInstallCommunity : needed.canInstall);

  async function install(target: NeededPackage) {
    setBusy(true);
    setError(null);
    try {
      await installNodePackageFn({
        data: target.registry
          ? {
              name: target.name,
              registry: target.registry.url,
              version: target.version,
              acceptRisk: true,
            }
          : { name: target.name },
      });
      await refreshServerCatalog();
      onInstalled();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not install the package");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install a package to use this credential</DialogTitle>
          <DialogDescription>
            {!item
              ? `No package in the node catalog or a registry gives the type "${type}".`
              : canInstall
                ? "Install the package to edit and use this credential. The package code runs on the server with the same rights as zerodot."
                : item.compatible
                  ? "Ask an instance admin to install the package. Until then, nodes cannot use this credential."
                  : "The package needs a newer zerodot."}
          </DialogDescription>
        </DialogHeader>
        {item && (
          <div className="flex items-center gap-3 py-2">
            <NodeIcon name={item.icon ?? "PackageIcon"} src={item.iconUrl ?? undefined} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span>
                {item.label}
                {item.registry && (
                  <span className={item.verified ? undefined : "text-destructive"}>
                    {" "}
                    · {item.verified ? "Verified" : "Community"}, {item.registry.name}
                  </span>
                )}
              </span>
              <span className="truncate text-muted-foreground">{item.name}</span>
            </span>
          </div>
        )}
        {needed?.catalogError && (
          <p className="text-muted-foreground">
            The node catalog is not reachable: {needed.catalogError}
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {confirm?.registry && (
          <CommunityInstallConfirm
            item={{
              name: confirm.name,
              label: confirm.label,
              version: confirm.version,
              registry: confirm.registry,
              verified: confirm.verified,
            }}
            busy={busy}
            onCancel={() => setConfirm(null)}
            onConfirm={() => void install(confirm)}
          />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Close
          </Button>
          {item && canInstall && (
            <Button
              disabled={busy}
              onClick={() => (item.registry ? setConfirm(item) : void install(item))}
            >
              {busy && <Spinner />}
              Install
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
