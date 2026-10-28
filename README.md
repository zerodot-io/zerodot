<p align="center">
  <img src="assets/cover.png" alt="zerodot" width="480">
</p>

# zerodot

Minimal, self-hosted workflow automation. AGPL-3.0-only. No telemetry. You own your workflow files.

## Quickstart

```sh
cp .env.example .env   # set ZERODOT_SECRET_KEY (openssl rand -base64 32) and BETTER_AUTH_SECRET
docker compose up -d
open http://localhost:3000
```

To run Zerodot on a VPS with a domain and HTTPS, see [docs/deploy-vps.md](docs/deploy-vps.md).

## Develop

In development, the apps run on your computer. Only Postgres and Valkey run in Docker.

You need:

- Node.js 22 or later
- pnpm 12.15.0. Corepack can fail with this version. If it does, install pnpm with `npm install -g pnpm@12.15.0`.
- Docker
- A C++ compiler and Python 3. `isolated-vm` (the code sandbox) is a native module and needs them to build.

1. Install the packages:

   ```sh
   pnpm install
   ```

2. Make the settings file:

   ```sh
   cp .env.example .env
   ```

   Set `ZERODOT_SECRET_KEY` (`openssl rand -base64 32`) and `BETTER_AUTH_SECRET`. The other values work for local development. The `.env` file is in the repository root. All apps read it.

3. Start Postgres and Valkey. The dev file publishes their ports (5432 and 6379) to your computer:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres valkey
   ```

   The two secrets from step 2 must be set in `.env`, because Compose reads them. Do not start the `web`, `api`, and `worker` containers at the same time as `pnpm run dev`. They use the same ports and the same database.

4. Start the web app, the API, the worker, and the sandbox:

   ```sh
   pnpm run dev
   ```

5. Open http://localhost:3000 and make an account.

The web app (port 3000) sends `/api`, `/hooks`, `/resume`, `/mcp`, and `/oauth2` requests to the API (port 3003). In Docker, the `proxy` service does this. The API serves webhooks and the REST API, so they keep working when the web app is down.

The database migrations run when the web app, the API, or the worker starts. You do not run them by hand.

Other commands:

```sh
pnpm run check-types
pnpm run lint
pnpm run test
```

`pnpm install` sets a Git pre-commit hook (`.githooks/pre-commit`). It runs `lint` and `check-types`, like CI. A failure stops the commit.

The `test` command needs a separate Postgres database. It deletes the data in that database. Do not use the development database.

### Troubleshooting

- **A service says an environment variable is not set.** Check that `.env` is in the repository root and that it has the four required values.
- **A Code node cannot run.** The worker needs `SANDBOX_URL` (`http://localhost:3002` in `.env.example`) and the sandbox must run. `pnpm run dev` starts it.
- **Nothing is saved.** Check that the dev server runs. The editor saves to the server, and a stopped server cannot save.

## More

- [Reference](docs/reference/README.md): credentials, nodes, webhooks, API and MCP, scaling, operations.
- [Deploy on a VPS](docs/deploy-vps.md)
- [SPEC.md](SPEC.md)
