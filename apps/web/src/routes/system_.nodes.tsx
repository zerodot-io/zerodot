// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { NodePackagesSection } from "../components/node-packages";
import { getHomeFn, getIsInstanceAdmin } from "../server/fns";

export const Route = createFileRoute("/system_/nodes")({
  beforeLoad: async () => {
    const home = await getHomeFn();
    if (!home.signedIn) throw redirect({ to: "/sign-in" });
    if (!(await getIsInstanceAdmin())) throw notFound();
    return { homeSlug: home.slug };
  },
  component: SystemNodes,
});

function SystemNodes() {
  const { homeSlug } = Route.useRouteContext();
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Link to="/system" className="text-muted-foreground hover:text-foreground">
            System
          </Link>
          <h1 className="text-lg font-semibold">Nodes</h1>
        </div>
        {homeSlug && (
          <Link
            to="/p/$projectSlug/workflows"
            params={{ projectSlug: homeSlug }}
            className="text-muted-foreground hover:text-foreground"
          >
            Back to app
          </Link>
        )}
      </div>
      <NodePackagesSection />
    </main>
  );
}
