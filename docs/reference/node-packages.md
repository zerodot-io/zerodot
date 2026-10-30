# Node packages

## Polling triggers and node packages

A polling trigger asks another service for news on a timer, while the workflow is active. A node type with a `poll()` function is a polling trigger. The worker calls it every `intervalSeconds` (at least 15, default 300). Each new item starts one run, and the item is the trigger input.

- The first poll after you activate the workflow, or after you change the trigger config, starts no runs. It only records where the trigger is.
- `poll()` returns `{ items: [{ key, data }], cursor }`, oldest first. The `key` is a stable id. An item whose key was seen (the last 500 keys are kept) starts no run. The `cursor` comes back in the next poll.
- A poll that fails keeps the old cursor, and the next tick asks again. The error is in `trigger_state.last_error`.
- The built-in `HTTP Poll` node checks a JSON API.
- Config values of a poll trigger are fixed. They cannot be expressions, because the worker polls without a run.

## Node packages

zerodot comes with the core nodes only. Other nodes are packages that you install when you need them. Official packages are `@zerodot/*` on npm. Their source is in [nodes](https://github.com/zerodot-io/nodes).

Install a package in the app. An instance admin opens **System > Nodes** and clicks Install. In the editor, search in the Add node list: a node that is not installed shows under "Not installed". The app picks the newest version that works with this zerodot, and every process (web, API, worker) loads it without a restart.

To use another version, open the package in **System > Nodes** and pick a version that fits this node contract, newer or older. Every process loads it without a restart. If the new version does not load, the old version comes back.

To install packages at start (for example in Docker or GitOps), list them:

```sh
ZERODOT_NODE_PACKAGES=@zerodot/redis,@zerodot/github
```

Official packages: `@zerodot/redis`, `@zerodot/mysql`, `@zerodot/postgres`, `@zerodot/mongodb`, `@zerodot/email` (send and IMAP trigger), `@zerodot/ssh` (SSH, FTP, SFTP), `@zerodot/s3`, `@zerodot/edit-image`, `@zerodot/mcp`, `@zerodot/telegram`, `@zerodot/github`, and `@zerodot/ai-agent` (AI Agent with chat models, memory, and tools; needs zerodot 0.2.9 or later). Each package documents its nodes in [nodes](https://github.com/zerodot-io/nodes).

- Packages live in `ZERODOT_NODES_DIR` (default `./.zerodot/nodes`; `/nodes` in the Docker image, on the `node-packages` volume). web, API, and worker share it.
- `ZERODOT_NODES_INSTALL=false` turns off installing and removing in the app.
- `ZERODOT_NPM_REGISTRY` sets the npm registry that packages come from (default `https://registry.npmjs.org`), for example a private mirror.
- `ZERODOT_NODE_CATALOG_URL` sets where the app reads the list of packages (default: the `catalog.json` of nodes).
- The official catalog lists only `@zerodot/*` packages. Other packages come from community registries (see below).
- Install scripts of packages do not run.

A package has `"zerodot": { "sdk": "^1.0" }` in its `package.json`: the range of node contract versions it works with. `SDK_VERSION` in `@zerodot/node-sdk` is the version of this zerodot. zerodot checks the range before it runs any package code. A package with no range, or with a range that does not fit, is not loaded. The package exports `nodes`, a list of node definitions, and can export `credentialTypes`. A package can not replace a built-in node type. A package that fails to load is logged and skipped.

## Community registries

> **Warning:** zerodot does not check community packages, except verified versions. A package runs in its own process, so it cannot read the secret keys, the database, or the files of zerodot, and it cannot reach addresses inside the network of the server. But it gets the credentials and the data that your workflows give to its nodes, and it can send them to any server on the internet. Add a registry and install a package only when you trust the author.

To make a community package, start from the template in [create](https://github.com/zerodot-io/create). It has example nodes and a script that writes `registry.json`.

A community registry is a `registry.json` file on an https address. It lists node packages on npm that other people wrote. An instance admin adds a registry in **System > Nodes > Community registries**. Its packages then show in the Community group of that page. The admin must accept the risk before a registry is added.

To install a community package, the admin must tick a box to accept the risk and type the package name. zerodot installs the version that the registry lists, and no other one. When the registry lists a new version after the admin opened the page, the install stops. To change the version of a community package later, the admin must accept the risk again. Each step is in the audit log with `riskAccepted: true`.

Community packages show in **System > Nodes**, and in the import of a workflow that uses their nodes. There, each community package has its own Install button with the same warning. Official packages install together. The Add node list of the editor shows official packages only. The `/workflows/import/preview` API looks in the official catalog only.

The registry file:

```json
{
  "name": "Acme nodes",
  "homepage": "https://example.com",
  "packages": [
    {
      "name": "@acme/zerodot-slack",
      "label": "Slack",
      "summary": "Send messages to Slack",
      "description": "Nodes that send and read Slack messages.",
      "version": "1.2.0",
      "sdk": "^1.0",
      "integrity": "sha512-...",
      "icon": "MessageSquare",
      "nodes": [{ "type": "acme.slack.send", "label": "Send message" }]
    }
  ]
}
```

- `name` and `packages` are necessary. Each package needs `name`, `version` (`x.y.z`, no pre-release), `sdk`, and `integrity`: the npm checksum of that version (`npm view <name>@<version> dist.integrity`). An entry with no checksum is dropped.
- The package name without the scope must start with `zerodot-`, for example `zerodot-slack` or `@acme/zerodot-slack`. Other names are dropped. A registry cannot list `@zerodot/*` packages. When two registries list the same package, the first registry wins. An official package wins over a community package.
- The file must be 1 MB or less. zerodot does not follow redirects. It reads each registry again after ten minutes.
- An instance can have 20 registries. When you remove a registry, the packages that you installed from it stay installed.
- Community registries and community installs are off by default. The operator sets `ZERODOT_COMMUNITY_NODES=true` to turn them on. When they are off, packages that are installed already stay installed. `ZERODOT_NODES_INSTALL=false` turns them off too.
- `ZERODOT_NODE_PACKAGES` can list any npm package. The operator who sets it accepts the risk.

### How a community package runs

Each process of zerodot (web, API, worker) starts one separate process for each community package. Official `@zerodot/*` packages run inside zerodot.

The process of a community package:

- has no environment variables, so it cannot read `ZERODOT_SECRET_KEY`, `BETTER_AUTH_SECRET`, or `DATABASE_URL`.
- runs with the permission model of Node.js. It can read files in the nodes folder only. It cannot write files, start programs or worker threads, or load native addons.
- can use the internet, but not addresses inside the network of the server: private and local addresses (`10.x`, `172.16.x` to `172.31.x`, `192.168.x`, `127.x`, `169.254.x` with the cloud metadata address, `100.64.x`, and the IPv6 forms), and local sockets. zerodot checks the address after the DNS lookup, so a name that points inside is refused too. UDP is off. `ZERODOT_COMMUNITY_NODES_ALLOW_HOSTS` lists hosts inside the network that packages may reach anyway (names or IP addresses, comma-separated), for example a database that a node must use.
- has 256 MB of memory. When it stops, zerodot starts it again on the next call.
- gets only what one call needs: the config, the input, and the credential of that node. It gets no expression scope (`$vars`, `$node`), no data tables, no code sandbox, and no sub-workflows.

A community node cannot be a tool of an AI Agent by default, because a model then picks its values. Set `ZERODOT_COMMUNITY_NODES_AS_TOOLS=true` on web, api and worker to allow it. Nodes of official `@zerodot/*` packages are not affected.

zerodot keeps a copy of the config schema of each node. It checks the config first, and the package checks it again with its own schema.

A community package cannot use these parts of the node contract. A node or a credential type that uses one is skipped, and System > Nodes shows why:

- `outPorts()` and `inPorts()`: ports that depend on the config.
- `waitForm()` and `waitsForCallback()`: nodes that wait for a person or a call.
- An `oauth2` function in a credential type. A fixed OAuth2 config works.

### Checksums

zerodot installs a community package only when the files are the ones that the registry names:

1. The registry entry has `integrity`, the npm checksum of the version.
2. Before the install, zerodot checks that npm has the same checksum for that version.
3. npm checks the downloaded files against the checksum.
4. After the install, zerodot reads the checksum from the npm lock file of the nodes folder. When it is not the same, zerodot removes the package.

zerodot saves the checksum with the installed package. When a process starts and the files on disk have another checksum, zerodot installs the package again. A community package can change only to the version that its registry lists, with that checksum.

Dependencies of the package are not checked one by one. npm installs them from the ranges in the `package.json` of the package.

### Verified packages

The zerodot team reviews versions of community packages when the author sends the source. A reviewed version is in `verified.json` in [nodes](https://github.com/zerodot-io/nodes). It matches only when the name, the version, and the checksum are the same. System > Nodes and the import of a workflow show it as "Verified". A verified version still runs with the same limits.

- `ZERODOT_UNVERIFIED_NODES=false`: only verified versions can be installed.
- `ZERODOT_VERIFIED_NODES_URL` sets where zerodot reads the list (default: the `verified.json` of nodes). When the list is not reachable, no package counts as verified.

The [create](https://github.com/zerodot-io/create) template tells authors how to ask for a review.

### Limits

The guards of the package process run in Node.js, not in the operating system. Node.js does not promise that its permission model stops all bad code. For more safety, run zerodot in containers, give Postgres and Valkey a password (scripts/install.sh does this), and block private addresses for outgoing traffic with a firewall.
