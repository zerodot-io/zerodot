// SPDX-License-Identifier: AGPL-3.0-only
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({ routeTree, scrollRestoration: true });
}
