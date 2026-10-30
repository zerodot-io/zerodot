// SPDX-License-Identifier: AGPL-3.0-only

import {
  Activity01Icon,
  CheckListIcon,
  Layers01Icon,
  LockPasswordIcon,
  PackageIcon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { Link, useLocation } from "@tanstack/react-router";
import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@zerodot/ui";
import { AdminUpdateNotice } from "./update-notice";

/** Tabs of the /system page, kept in the `tab` search param. Nodes is its own route. */
export const SYSTEM_TABS = ["overview", "queues", "jobs", "instance", "auth"] as const;
export type SystemTab = (typeof SYSTEM_TABS)[number];
const TABS: Record<SystemTab, { label: string; icon: IconSvgElement }> = {
  overview: { label: "Overview", icon: Activity01Icon },
  queues: { label: "Queues", icon: Layers01Icon },
  jobs: { label: "Jobs", icon: CheckListIcon },
  instance: { label: "Instance", icon: ServerStack01Icon },
  auth: { label: "Auth", icon: LockPasswordIcon },
};

/** Header of the System pages: the title, the tabs, and a link back to the app. */
export function SystemHeader({
  homeSlug,
  children,
}: {
  homeSlug: string | null | undefined;
  /** Shows next to the title, for example the live status. */
  children?: React.ReactNode;
}) {
  const { pathname, search } = useLocation();
  const tab = SYSTEM_TABS.find((t) => t === (search as { tab?: unknown }).tab) ?? "overview";
  const current = pathname === "/system/nodes" ? "nodes" : tab;
  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">System</h1>
          {children}
        </div>
        {homeSlug && (
          <Link
            to="/p/$projectSlug/workflows"
            params={{ projectSlug: homeSlug }}
            search={{ all: true }}
            className="text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground"
          >
            Back to app
          </Link>
        )}
      </div>
      {/* The tabs are links, so each tab has its own URL and the back button works.
          On a phone only the current tab shows its label. */}
      <Tabs value={current}>
        <TabsList
          variant="line"
          size="default"
          aria-label="System"
          className="scrollbar-hide w-full justify-start overflow-x-auto"
        >
          <TabsIndicator />
          {SYSTEM_TABS.map((t) => {
            const { label, icon: Icon } = TABS[t];
            return (
              <TabsTrigger
                key={t}
                value={t}
                nativeButton={false}
                className="flex-none"
                render={<Link to="/system" search={t === "overview" ? {} : { tab: t }} />}
              >
                <HugeiconsIcon icon={Icon} aria-hidden="true" />
                <span className={t === current ? undefined : "max-md:sr-only"}>{label}</span>
              </TabsTrigger>
            );
          })}
          <TabsTrigger
            value="nodes"
            nativeButton={false}
            className="flex-none"
            render={<Link to="/system/nodes" />}
          >
            <HugeiconsIcon icon={PackageIcon} aria-hidden="true" />
            <span className={current === "nodes" ? undefined : "max-md:sr-only"}>Nodes</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {/* System pages are for the instance admin only, so the dot shows here too. */}
      <AdminUpdateNotice />
    </header>
  );
}
