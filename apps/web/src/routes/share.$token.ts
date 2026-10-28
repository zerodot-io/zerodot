// SPDX-License-Identifier: AGPL-3.0-only
import { createFileRoute } from "@tanstack/react-router";

import { SHARE_IMPORT_HEADER, SHARE_PASSWORD_HEADER } from "@zerodot/server/share-fetch";

/** Another zerodot reads the link from the browser, so any origin can read it. */
const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": `${SHARE_PASSWORD_HEADER}, ${SHARE_IMPORT_HEADER}`,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

/** The `.zerodot.json` file behind a share link. One imports the link in Workflows > Import. */
export const Route = createFileRoute("/share/$token")({
  server: {
    handlers: {
      OPTIONS: () => new Response(null, { status: 204, headers: HEADERS }),
      GET: async ({ params, request }) => {
        const { readShare } = await import("@zerodot/server/share.server");
        const result = await readShare(
          params.token,
          request.headers.get(SHARE_PASSWORD_HEADER),
          request.headers.has(SHARE_IMPORT_HEADER),
        );
        switch (result.status) {
          case "ok":
            return reply(result.file);
          case "not-found":
            return reply(
              { error: "This link does not exist, or its owner stopped sharing it" },
              404,
            );
          case "used":
            return reply({ error: "This link was for one import, and it was used already" }, 410);
          case "import-only":
            return reply(
              { error: "This link is for one import. Paste it in zerodot: Workflows > Import" },
              403,
            );
          case "password":
            return reply(
              {
                error: result.wrong ? "The password is not correct" : "This link needs a password",
                passwordRequired: true,
              },
              401,
            );
          case "too-many":
            return reply({ error: "Too many wrong passwords. Try again in 5 minutes" }, 429);
        }
      },
    },
  },
});
