# SPDX-License-Identifier: AGPL-3.0-only
FROM node:22-slim AS base
# corepack in this image cannot run pnpm 12, so install it with npm.
RUN npm install -g pnpm@12.15.0
WORKDIR /app
# Installed node packages live here. Compose mounts a volume, so they survive an upgrade.
ENV ZERODOT_NODES_DIR=/nodes
RUN mkdir -p /nodes && chown node:node /nodes

FROM base AS build
# isolated-vm (the code sandbox) is a native module. It needs a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile && pnpm run build

FROM base AS web
COPY --from=build --chmod=a+rX /app /app
# vite preview bundles its config into node_modules/.vite-temp at start.
RUN mkdir -p apps/web/node_modules/.vite-temp && chown node:node apps/web/node_modules/.vite-temp
ENV PORT=3000
EXPOSE 3000
USER node
CMD ["pnpm", "--filter", "@zerodot/web", "start"]

FROM base AS api
COPY --from=build --chmod=a+rX /app /app
ENV ZERODOT_API_PORT=3003
EXPOSE 3003
USER node
CMD ["node", "apps/api/dist/index.js"]

FROM base AS worker
COPY --from=build --chmod=a+rX /app /app
USER node
CMD ["node", "apps/worker/dist/index.js"]

FROM base AS sandbox
COPY --from=build --chmod=a+rX /app /app
USER node
# isolated-vm needs --no-node-snapshot on Node 20 and later.
CMD ["node", "--no-node-snapshot", "apps/sandbox/dist/index.js"]
