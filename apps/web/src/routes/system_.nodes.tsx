// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { NodePackagesSection } from "../components/node-packages";
import { SystemHeader } from "../components/system-header";
import { getHomeFn, getIsInstanceAdmin } from "../server/fns";

export const Route = createFileRoute("/system_/nodes")({
  head: () => ({ meta: [{ title: "Node packages · zerodot" }] }),
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
    <main className="reveal mx-auto flex w-full max-w-5xl flex-col gap-8 p-6">
      <SystemHeader homeSlug={homeSlug} />
      <NodePackagesSection />
    </main>
  );
}
