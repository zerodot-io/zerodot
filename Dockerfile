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
# Install first from manifests only. This layer stays cached until the lockfile changes,
# so the isolated-vm compile does not rerun on every source edit.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/sandbox/package.json apps/sandbox/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/blob/package.json packages/blob/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/node-sdk/package.json packages/node-sdk/
COPY packages/nodes/package.json packages/nodes/
COPY packages/queue/package.json packages/queue/
COPY packages/server/package.json packages/server/
COPY packages/ui/package.json packages/ui/
# Run make in parallel. node-gyp builds one file at a time by default.
ENV JOBS=max
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/root/.cache/node-gyp \
    pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

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
