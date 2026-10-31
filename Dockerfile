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
# Cap parallel compile jobs. Each g++ job on V8 headers uses about 1 GB of RAM.
ENV JOBS=2
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    --mount=type=cache,target=/root/.cache/node-gyp \
    pnpm install --frozen-lockfile
COPY . .
# The release workflow sets this. The About dialog shows it.
ARG APP_VERSION
ENV APP_VERSION=$APP_VERSION
RUN pnpm run build

# One image for all services. The command selects one: web, api, worker or sandbox.
FROM base AS app
COPY --from=build --chmod=a+rX /app /app
# vite preview bundles its config into node_modules/.vite-temp at start.
RUN mkdir -p apps/web/node_modules/.vite-temp && chown node:node apps/web/node_modules/.vite-temp
COPY --chmod=a+rx scripts/docker-entrypoint.sh /usr/local/bin/zerodot
ENV ZERODOT_API_PORT=3003
EXPOSE 3000 3003
USER node
ENTRYPOINT ["zerodot"]
CMD ["web"]
