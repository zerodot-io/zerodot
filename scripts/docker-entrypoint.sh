#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# One image runs all services. The first argument selects the service.
set -e

case "$1" in
  web)
    # Set PORT for web only. sandbox and worker also read PORT, with other defaults.
    export PORT=3000
    exec pnpm --filter @zerodot/web start
    ;;
  api) exec node apps/api/dist/index.js ;;
  worker) exec node apps/worker/dist/index.js ;;
  # isolated-vm needs --no-node-snapshot on Node 20 and later.
  sandbox) exec node --no-node-snapshot apps/sandbox/dist/index.js ;;
  *) exec "$@" ;;
esac
