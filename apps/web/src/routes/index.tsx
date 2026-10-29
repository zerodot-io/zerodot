// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getHomeFn } from "../server/fns";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const home = await getHomeFn();
    if (!home.signedIn || !home.slug) throw redirect({ to: "/sign-in" });
    throw redirect({
      to: "/p/$projectSlug/workflows",
      params: { projectSlug: home.slug },
      search: { all: true },
    });
  },
});
