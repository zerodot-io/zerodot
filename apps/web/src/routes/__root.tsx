// SPDX-License-Identifier: AGPL-3.0-only

import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Toaster, TooltipProvider } from "@zerodot/ui";
import appCss from "../app.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "zerodot" },
    ],
    links: [
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: () => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <TooltipProvider>
          <Outlet />
        </TooltipProvider>
        <Toaster />
        <Scripts />
      </body>
    </html>
  ),
});
