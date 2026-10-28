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

The `test` command needs a separate Postgres database. It deletes the data in that database. Do not use the development database.

### Troubleshooting

- **A service says an environment variable is not set.** Check that `.env` is in the repository root and that it has the four required values.
- **A Code node cannot run.** The worker needs `SANDBOX_URL` (`http://localhost:3002` in `.env.example`) and the sandbox must run. `pnpm run dev` starts it.
- **Nothing is saved.** Check that the dev server runs. The editor saves to the server, and a stopped server cannot save.

See [SPEC.md](SPEC.md).

## Credentials and the secret key

Zerodot encrypts credentials with AES-256-GCM. The key is `ZERODOT_SECRET_KEY` (32 bytes, base64). Services do not start without it. Keep a copy: with a lost key, saved credentials cannot be opened.

To change the key:

```sh
ZERODOT_SECRET_KEY=<old key> ZERODOT_NEW_SECRET_KEY=<new key> DATABASE_URL=<url> pnpm run rotate-key
```

Then set `ZERODOT_SECRET_KEY` to the new key in every service and restart them.

## OAuth2 credentials

Use the `OAuth2` credential to connect an account of a service that uses OAuth2. A node that accepts it (today `HTTP Request` and `HTTP Poll`) sends the access token as `Authorization: Bearer <token>`.

1. At the service, make an OAuth app. Set its redirect URL to `<ZERODOT_BASE_URL>/oauth2/callback`. The credential form shows the exact address.
2. In zerodot, open Credentials, pick `OAuth2`, and enter the client id, the client secret, the authorize URL, the token URL, and the scopes (separated by spaces). Choose "Save and connect" and allow access at the service.

Zerodot refreshes the access token before a run, when it is less than 60 seconds from its end. Many runs at the same time make one refresh request. If the service refuses the refresh token, the credential shows "Reconnect needed", and runs that use it fail until you connect again. The authorize and token URLs must use HTTPS (HTTP is allowed for `localhost`). Zerodot uses PKCE (S256).

Some services need extra settings. For Google, a refresh token comes only when the authorize request has `access_type=offline` and `prompt=consent`, and an app in "testing" mode loses its refresh tokens after 7 days.

## GitHub nodes

`GitHub` has the resources `issue` (create, createComment, edit, get, lock), `repository` (getProfile, getIssues, getPullRequests), `file` (get, list, create, edit), and `release` (create, get, getAll). The names follow the GitHub REST API. A list returns an array, with `limit` items or all items (`returnAll`). `file.get` adds the decoded text of the file as `text`.

`GitHub Trigger` starts a run on events of one repository (`push`, `issues`, `pull_request`, and others, or all). Activate makes the webhook at GitHub. Deactivate removes it. The run input is `{ event, action, delivery, body }`, where `body` is the payload from GitHub. Zerodot checks the `X-Hub-Signature-256` header of each delivery.

- The `Authentication` field of the node says which credential to use. `Access Token` uses a personal access token (`GitHub access token`). `OAuth2` uses the `GitHub OAuth2` credential (see "OAuth2 credentials").
- For GitHub Enterprise Server, set `server` in the credential to its API address, for example `https://ghe.example.com/api/v3`.
- GitHub sends webhook deliveries only to a public HTTPS address. Set `ZERODOT_BASE_URL` to it.
- The token needs the scope `repo` (classic token) or "Webhooks: read and write" and "Issues: read and write" (fine-grained token) to use the webhook, issues, and files. The default OAuth2 scopes are `repo read:user`.

## Data and file nodes

- `HTML Extract` reads HTML (a string, or the `data` field of the input) with CSS selectors. Each selector gives one key. Return the text, the HTML, an attribute, or the `value`. `Return Array` gives every match.
- `XML` turns XML into JSON and JSON into XML. Attributes use the prefix `@_` and mixed text uses `#text`. Both can be changed.
- `RSS Read` fetches an RSS 2.0, RSS 1.0, or Atom feed and returns one item for each entry.
- `Convert to File` makes a CSV, JSON, or text file from items. `Extract from File` reads them back. The file is base64 text in `binary.<property>` of the item. There is no separate binary store.
- `Compression` makes or opens a gzip file. Zip is not supported.
- `Edit Image` gets the size of an image, or resizes, crops, rotates, blurs, makes it gray, or converts it to JPEG, PNG, WebP, or AVIF (`sharp`).
- `Read/Write Files from Disk` reads a file into a binary field, or writes one to disk. It reaches only the folder in `ZERODOT_FILES_DIR` on the worker. With the variable empty, the node is off. A path that leaves the folder (`..` or a symbolic link) fails.
- `Execute Command` runs a shell command on the worker and returns `exitCode`, `stdout`, and `stderr`. It is off unless `ZERODOT_ENABLE_EXECUTE_COMMAND=true`, because everyone who can edit a workflow could run commands on the worker. In Docker, the command runs inside the worker container.
- `Stop and Error` fails the run with a message or the `message` field of an object. It has no output, so the error workflow and `onError` of the run see it.

## Code node

The `Code` node runs JavaScript in a separate sandbox container (`isolated-vm`). The code can read `$input`, `$trigger`, `$node["Name"].data`, `$vars` (read only), and `$run`. It has no network, no file access, and no Node API. A run stops after `timeoutMs` and at 128 MB of memory.

Calls to `console.log`, `console.info`, `console.warn`, `console.error`, and `console.debug` show under "Logs" for the node on the run page, also when the code fails. A run keeps the first 100 logs, and 2000 characters of each log.

### Scale the sandbox

One sandbox container runs `SANDBOX_MAX_CONCURRENCY` (default 4) pieces of code at the same time. For more, run more replicas:

```sh
SANDBOX_REPLICAS=3 docker compose up -d      # or: docker compose up -d --scale sandbox=3
```

- `SANDBOX_URL` on the worker can be one URL, a host name with many addresses (Docker DNS of a scaled service), or a comma-separated list: `http://sandbox-1:3002,http://sandbox-2:3002`. The worker sends each run to the replica with the fewest runs in flight, and the replicas take turns when they are equal. The worker looks up DNS again every 5 seconds.
- A full sandbox does not queue for long. It waits at most `SANDBOX_MAX_WAIT_MS` (default 250) with at most `SANDBOX_MAX_QUEUE` (default: `SANDBOX_MAX_CONCURRENCY`) waiting requests. Then it answers `503` with `Retry-After`.
- On `503`, or when a replica does not connect, the worker waits a random time (backoff, up to 2 seconds) and tries again, on another replica if there is one. After 30 seconds or 10 tries, the Code node fails with "The code sandbox is busy. Try again later".
- `GET /healthz` is the health check. `GET /metrics` shows `zerodot_sandbox_active`, `zerodot_sandbox_queued`, `zerodot_sandbox_max_concurrency`, `zerodot_sandbox_runs_total`, and `zerodot_sandbox_rejected_total` in Prometheus format. A growing `rejected_total` means: add replicas.
- The isolation stays the same for each replica: only the internal network (no way out), read-only file system, all capabilities dropped, no volumes.

The code that you write in a Code node is yours. It is not a derivative work of zerodot, and the AGPL does not apply to it.

## Email, server and database nodes

- `On new email (IMAP)` is a trigger. It keeps an IMAP connection in IDLE state and starts one run for each unread mail in the mailbox, oldest first. `Action` can mark the mail as read. `Format` is `simple` (parsed fields), `resolved` (also the attachments as binary data), or `raw` (the whole message as base64). It needs an `IMAP` credential. If the connection closes, the worker starts the trigger again.
- `SSH` runs a command on a server and returns `exitCode`, `stdout`, and `stderr`. `SFTP` and `FTP` list, download, upload, rename, and delete files. SSH and SFTP use an `SSH` credential (password or private key). FTP uses an `FTP` credential (FTPS with `secure`). The server host key is not checked.
- `MongoDB` finds, inserts, updates, deletes, and aggregates documents, and has find-and-update and find-and-replace. Queries are JSON. Extended JSON works for ids and dates, for example `{"_id": {"$oid": "..."}}`. Ids and dates in the result are text. It needs a `MongoDB` credential (connection string and database).

## Telegram nodes

`Telegram` follows the Bot API: resources `message`, `chat`, `callback`, `file`, with the same operation and parameter names. `Telegram Trigger` receives updates on the webhook route. Publish or activate sets the Telegram webhook. Deactivate, or a publish that removes the trigger or changes its bot, removes it. A bot has one webhook, so one active workflow for each bot.

- Telegram sends updates only to a public HTTPS address. Set `ZERODOT_BASE_URL` to it.
- **Binary data.** zerodot has no binary store. A node puts a file in its output as `binary.<property>` (`data` as base64, `mimeType`, `fileName`). The node output limit (`ZERODOT_MAX_NODE_OUTPUT_BYTES`, 5 MB) is the file size limit, and base64 adds about a third.
- **Send and wait.** `sendAndWait` sends a message with link buttons, and the run stops. A person opens a signed link (`/resume/<run>/<node>`), and the run goes on with the answer as the node output. After `limitWaitTimeHours` (default 168) the run goes on with `{ "data": { "timedOut": true } }`. The worker needs `ZERODOT_BASE_URL` to build the link.

## Polling triggers and node packages

A polling trigger asks another service for news on a timer, while the workflow is active. A node type with a `poll()` function is a polling trigger. The worker calls it every `intervalSeconds` (at least 15, default 300). Each new item starts one run, and the item is the trigger input.

- The first poll after you activate the workflow, or after you change the trigger config, starts no runs. It only records where the trigger is.
- `poll()` returns `{ items: [{ key, data }], cursor }`, oldest first. The `key` is a stable id. An item whose key was seen (the last 500 keys are kept) starts no run. The `cursor` comes back in the next poll.
- A poll that fails keeps the old cursor, and the next tick asks again. The error is in `trigger_state.last_error`.
- The built-in `HTTP Poll` node checks a JSON API.
- Config values of a poll trigger are fixed. They cannot be expressions, because the worker polls without a run.

## Node packages

zerodot comes with the core nodes only. Other nodes are packages that you install when you need them. Official packages are `@zerodot/*` on npm. Their source is in [zerodot-nodes](https://github.com/zerodot-io/zerodot-nodes).

Install a package in the app. An instance admin opens **System > Nodes** and clicks Install. In the editor, search in the Add node list: a node that is not installed shows under "Not installed". The app picks the newest version that works with this zerodot, and every process (web, API, worker) loads it without a restart.

To install packages at start (for example in Docker or GitOps), list them:

```sh
ZERODOT_NODE_PACKAGES=@zerodot/redis,@zerodot/github
```

- Packages live in `ZERODOT_NODES_DIR` (default `./.zerodot/nodes`; `/nodes` in the Docker image, on the `node-packages` volume). web, API, and worker share it.
- `ZERODOT_NODES_INSTALL=false` turns off installing and removing in the app.
- `ZERODOT_NODE_CATALOG_URL` sets where the app reads the list of packages (default: the `catalog.json` of zerodot-nodes).
- Only `@zerodot/*` packages can be installed. A package runs with the rights of the server, so the list is closed for now.
- Install scripts of packages do not run.

A package has `"zerodot": { "sdk": "^1.0" }` in its `package.json`: the range of node contract versions it works with. `SDK_VERSION` in `@zerodot/node-sdk` is the version of this zerodot. zerodot checks the range before it runs any package code. A package with no range, or with a range that does not fit, is not loaded. The package exports `nodes`, a list of node definitions, and can export `credentialTypes`. A package can not replace a built-in node type. A package that fails to load is logged and skipped.

## API and MCP

Create an API key in the project (API keys page). Send it as `Authorization: Bearer <key>`.

- REST API: `/api/v1`. OpenAPI 3.1 document: `/api/v1/openapi.json`.
- MCP server (Streamable HTTP): `/mcp`. Same keys, same project scope and roles.
- Roles: `member` (workflows, runs, table rows) and `admin` (also variables, credentials, table schemas).
- Settings: `ZERODOT_API_RATE_LIMIT_PER_MINUTE` (default 600 for each key) and `ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS` (default 30000, the longest `wait=true` request). `wait=true` and the webhook response modes hold a request open. One process holds at most `ZERODOT_MAX_HELD_WEBHOOKS` (default 500) of them. A webhook call over the cap gets `503` with `Retry-After: 5` and starts no run. An API `wait=true` call over the cap does not wait: it returns at once with the run id, like a timeout. The slot is freed when the run ends, the time is up, or the client closes the connection.

```sh
curl -H "Authorization: Bearer $ZERODOT_KEY" -X POST \
  "$ZERODOT_URL/api/v1/workflows/$ID/run?wait=true" -d '{"input":{"name":"Ada"}}' \
  -H "content-type: application/json"
```

## Webhook node

The Webhook node starts a workflow on an HTTP request. A workflow has one trigger node.

- **URLs.** The editor shows two URLs with the same last part: the test URL (`/hooks-test/<path>`) and the production URL (`/hooks/<path>`). The last part is the **Path** of the node. Without a path, it is a generated token. The test URL works before a publish: click **Listen for test event** and send one request to it. The production URL works after you publish and turn on **Active**. Two triggers cannot use the same path.
- **HTTP Method.** `GET`, `POST` (default), `PUT`, `PATCH`, `DELETE`, or `HEAD`. A request with another method gets `405`.
- **Authentication.** `None`, `Basic Auth` (credential type "Basic auth"), or `Header Auth` (credential type "Header auth"). A bad or missing login gets `401` or `403`.
- **Respond.**
  - `Immediately`: answer `202` with `{ "runId": "…" }` when the run is queued.
  - `When Last Node Finishes`: hold the request until the run ends, then answer with the output of the last node. After `ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS` (30 s) the answer is `202`. A failed run gets `500`.
  - `Using 'Respond to Webhook' Node`: hold the request until a **Respond to Webhook** node runs. The node sets the status code, headers, and body. A run that ends without this node gets `500`.
- **Options** (click **Add option**): Allowed Origins (CORS), IP(s) Allowlist, Ignore Bots, No Response Body, Only Run If (an expression, for example `{{ $trigger.body.type === "order" }}`), Raw Body, Response Code, Response Data, and Response Headers.
- The IP allowlist reads `X-Forwarded-For`. It works only when `ZERODOT_TRUST_PROXY=true` and a proxy that you control sets the header. Without it, the allowlist rejects every request.
- The test URL checks the method only. It does not apply authentication, the allowlist, or the other options.
- Not built: an option for the field name of binary data. zerodot has no binary store for webhook bodies.

## Loops and joins

- An edge can go back to an earlier node. Drag from the **+** of a node to another node, or from the output dot to an input. A loop needs a way out: use an **If** or **Switch** node to choose the edge that goes back, and the edge that leaves.
- A node can have more than one parent. It runs once for each parent that sends data (not once for all of them).
- A node that runs again has a new attempt number in the run page. The page shows the last one.
- A trigger node has no input, so an edge cannot lead into it.
- A run stops with an error after `ZERODOT_MAX_NODE_RUNS` node runs (default 1000). This stops a loop that does not end.
- To remove an edge, put the pointer on it and click the **X**.

### Loop Over Items

The `Loop Over Items` node runs the nodes on its `loop` output once for each item (or batch) of a list.

1. Set `list` to an expression for the list, for example `{{ $input.users }}`. Set `batchSize` (default 1).
2. Connect the `loop` output to the nodes that do the work. Connect the last of them back to the input of the loop node (the node has one input).
3. Connect the `done` output to the nodes that run after the last pass.

On each pass the nodes on `loop` get `{ items, item, index, total }`. `items` is the batch, `item` is its first element, `index` is the position of the first element in the list, and `total` is the length of the list. When the list is empty, the loop goes to `done` at once. `done` sends an array: the data that came back, one entry for each pass. A pass that does not come back to the loop node (for example an `If` branch that ends) ends the whole loop, and `done` does not run.

All node runs of a loop count against `ZERODOT_MAX_NODE_RUNS` (default 1000). A loop of 200 items with 4 nodes in its body uses about 1000. Raise the limit for long loops. A wait inside the loop body works: the run stops, and goes on at the same item.

## Test runs in the editor

- **Test run** runs the whole draft graph.
- **Run to here** (node dialog) runs the path from the trigger to the selected node and stops after it. Other branches do not run.
- **Execute step** (node dialog) runs only the selected node. Its input is the last output of the node before it, or the pinned data of that node. The run does not use the pin of the node that you execute. A node with no input data shows a message.
- **Pin output** keeps the output of a node. Test runs use it and skip the node. Production runs ignore pins.
- Test runs use real credentials and write real data.

The REST route `POST /api/v1/workflows/:id/test` takes `toNodeId` for run to node.

## Import and export

- **Export** (editor) downloads the draft as `<name>.zerodot.json`. The same file comes from `GET /api/v1/workflows/:id/export`.
- **Import** (workflow list) makes a new draft from a file. The API route is `POST /api/v1/workflows/import` with `{ "file": ... }`.
- The file holds the graph, the name, and the variable keys that the graph reads. It holds no variable values and no credential data. Pinned data stays in the file: remove it first if it holds private data.
- An import clears a credential that the project does not have. The page lists the nodes that need a new credential, and the variable keys that the project does not have.

## Scale and high availability

The worker has two queues in Valkey. Each has its own worker loop in the same process:

- `zerodot-runs` holds run jobs. `ZERODOT_WORKER_CONCURRENCY` (default 20) sets how many run at once.
- `zerodot-system` holds cron, poll, retention, and sweep jobs. `ZERODOT_SYSTEM_CONCURRENCY` (default 5) sets how many run at once. A slow run cannot delay a cron tick.

When a worker starts, it removes the old schedulers from `zerodot-runs`. They now live in `zerodot-system`, so nothing fires twice. `GET /metrics` on the worker shows `zerodot_queue_jobs{queue="runs"|"system",state=...}`.

### Fair share between projects

- `ZERODOT_ORG_MAX_CONCURRENT_RUNS` is the most runs of one project that run at once over all workers. `0` (default) means no cap.
- `ZERODOT_WORKFLOW_MAX_CONCURRENT_RUNS` is the same for one workflow. `0` (default) means no cap.

A job that finds no free slot waits 1 to 3 seconds in the queue and tries again. It does not use up a retry. A slot expires after 30 seconds without renewal, so a crashed worker frees its slots. A sub-workflow that a node waits for runs inside the parent run and takes no extra slot.

### Listen triggers

`ZERODOT_MAX_LISTEN_TRIGGERS` (default 100) is the most listen triggers (for example IMAP) that one worker keeps open. Workers try the triggers in random order, so the triggers spread over the workers. Add workers when the cap is reached. The log shows `listen.cap_reached`.

### Large and binary data

By default, files (`binary.<property>`) and all node data are `jsonb` in Postgres. To keep them out of Postgres, set a blob store. Web, API, and worker must all use the same store.

- `ZERODOT_BLOB_DIR`: a directory. Use a volume that all processes share.
- `ZERODOT_BLOB_S3_BUCKET` with `ZERODOT_BLOB_S3_ACCESS_KEY_ID` and `ZERODOT_BLOB_S3_SECRET_ACCESS_KEY`: S3 or an S3-compatible service. Also `ZERODOT_BLOB_S3_ENDPOINT`, `ZERODOT_BLOB_S3_REGION`, `ZERODOT_BLOB_S3_PREFIX`, `ZERODOT_BLOB_S3_FORCE_PATH_STYLE`. S3 wins over the directory.
- `ZERODOT_INLINE_OUTPUT_BYTES` (default 262144): a node input or output above this size is stored as one blob (`output_ref`). Files are always blobs.

The result row keeps a small reference. The API and the UI read the data back. A resumed run reads a blob when a node needs it. Blobs are named `<run id>/<hash>`. They go with their run: `clearData` deletes them, and `deleteOrphanBlobs` (`@zerodot/db`) deletes the blobs of runs that a purge removed. Run it after `purgeRuns`. With no store set, nothing changes.

`ZERODOT_MAX_NODE_OUTPUT_BYTES` still counts the base64 data in memory.

### Fewer node writes

A node result is written once, when the node ends. There is no `running` row. The live event `node.started` still goes out. A node that was running during a crash has no result, so a resumed run starts it again.

`ZERODOT_SAVE_SUCCESS_NODE_DATA=false` (or the workflow setting "save success data" off) stops production runs from keeping the input and output of nodes that succeeded. The rows keep status, port, and timing. The data is written again when the run waits, fails, or is stopped, because a resume or a retry needs it. When the run succeeds, only the last node keeps its output, because it is the answer of `wait=true` and `lastNode` calls. A resumed run runs a node again if its data was not saved.

### Valkey: plain, Sentinel, or Cluster

By default the apps use `VALKEY_URL` only. For high availability set one of these in the web app, the API, and the worker:

| Mode | Variables |
| --- | --- |
| Sentinel | `VALKEY_SENTINELS=host:port,host:port`, `VALKEY_SENTINEL_NAME` (default `mymaster`), `VALKEY_PASSWORD` (optional) |
| Cluster | `VALKEY_CLUSTER=true`, `VALKEY_PASSWORD` (optional) |

- `VALKEY_URL` must stay set. In Sentinel mode the apps ignore it. In Cluster mode it is the first node, and the client finds the other nodes.
- In Cluster mode all queue keys use the prefix `{zerodot}`, so they share one hash slot. Changing mode does not move jobs: drain the queues first.
- Valkey must keep its data (AOF on). The sweep job queues again the runs that lost their job.

## System page

The System page shows the queues, the workers and the counters of the whole server. It is for the instance admin only, not for project admins.

- **Who is admin:** a signed-in user whose email is in `ZERODOT_ADMIN_EMAILS` (comma separated). When the list is empty, the first user who signed up is the admin.
- **Turn it off:** `ZERODOT_ADMIN_UI=false`. Then every admin call answers 404.
- **What an admin can do:** cancel any run, retry, remove or promote a job, clean a queue, pause and resume a queue. Each change writes one row to the `admin_audit` table (who, what, which id). Rows hold ids and counts only.
- **What it never shows:** job data, node input or node output.

## Retention

A daily job in the worker deletes old data. It never changes data tables.

| Data                       | Rule                   | Setting                                                                |
| -------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Test runs                  | Deleted after 7 days   | `ZERODOT_TEST_RUN_RETENTION_DAYS`                                         |
| Production runs (finished) | Deleted after 30 days  | `ZERODOT_RUN_RETENTION_DAYS`, or the project setting on the Settings page |
| Insight rollups            | Deleted after 365 days | `ZERODOT_STATS_RETENTION_DAYS`                                            |

A run that has not finished stays. Insight rollups stay when their runs are deleted.

The job deletes runs in batches (1000 runs for each statement, a short pause between batches). One job deletes at most 200 batches, so it never holds locks for long. If more old runs remain, the next job continues. `purgeRuns` takes `batchSize`, `maxBatches` and `pauseMs`, so a caller can run it each hour with a small `maxBatches`.
