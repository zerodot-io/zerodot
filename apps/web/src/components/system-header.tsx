// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from "@tanstack/react-router";

const tab = "rounded-lg px-2.5 py-1 transition-colors duration-150 ease-out";
const active = { className: "bg-muted font-medium text-foreground" };
const inactive = { className: "text-muted-foreground hover:text-foreground" };

/** Header of the System pages: the title, the tabs, and a link back to the app. */
export function SystemHeader({
  homeSlug,
  children,
}: {
  homeSlug: string | null | undefined;
  /** Shows next to the title, for example the live status. */
  children?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 border-b pb-4">
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
      <nav aria-label="System" className="-mx-2.5 flex gap-1">
        <Link
          to="/system"
          className={tab}
          activeOptions={{ exact: true }}
          activeProps={active}
          inactiveProps={inactive}
        >
          Overview
        </Link>
        <Link to="/system/nodes" className={tab} activeProps={active} inactiveProps={inactive}>
          Nodes
        </Link>
      </nav>
    </header>
  );
}
