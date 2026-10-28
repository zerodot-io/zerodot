// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: () => Response.json({ ok: true, service: "web" }),
    },
  },
});
