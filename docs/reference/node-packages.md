# Node packages

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

To use another version, open the package in **System > Nodes** and pick a version that fits this node contract, newer or older. Every process loads it without a restart. If the new version does not load, the old version comes back.

To install packages at start (for example in Docker or GitOps), list them:

```sh
ZERODOT_NODE_PACKAGES=@zerodot/redis,@zerodot/github
```

Official packages: `@zerodot/redis`, `@zerodot/mysql`, `@zerodot/postgres`, `@zerodot/mongodb`, `@zerodot/email` (send and IMAP trigger), `@zerodot/ssh` (SSH, FTP, SFTP), `@zerodot/s3`, `@zerodot/edit-image`, `@zerodot/mcp`, `@zerodot/telegram`, and `@zerodot/github`. Each package documents its nodes in [zerodot-nodes](https://github.com/zerodot-io/zerodot-nodes).

- Packages live in `ZERODOT_NODES_DIR` (default `./.zerodot/nodes`; `/nodes` in the Docker image, on the `node-packages` volume). web, API, and worker share it.
- `ZERODOT_NODES_INSTALL=false` turns off installing and removing in the app.
- `ZERODOT_NODE_CATALOG_URL` sets where the app reads the list of packages (default: the `catalog.json` of zerodot-nodes).
- The official catalog lists only `@zerodot/*` packages. Other packages come from community registries (see below).
- Install scripts of packages do not run.

A package has `"zerodot": { "sdk": "^1.0" }` in its `package.json`: the range of node contract versions it works with. `SDK_VERSION` in `@zerodot/node-sdk` is the version of this zerodot. zerodot checks the range before it runs any package code. A package with no range, or with a range that does not fit, is not loaded. The package exports `nodes`, a list of node definitions, and can export `credentialTypes`. A package can not replace a built-in node type. A package that fails to load is logged and skipped.

## Community registries

> **Warning:** zerodot does not check community packages. A package runs with all the rights of the server. It can read every credential, variable, and workflow, your database, and your environment variables. Add a registry and install a package only when you trust the author.

To make a community package, start from the template in [create](https://github.com/zerodot-io/create). It has example nodes and a script that writes `registry.json`.

A community registry is a `registry.json` file on an https address. It lists node packages on npm that other people wrote. An instance admin adds a registry in **System > Nodes > Community registries**. Its packages then show in the Community group of that page. The admin must accept the risk before a registry is added.

To install a community package, the admin must tick a box to accept the risk and type the package name. zerodot installs the version that the registry lists, and no other one. When the registry lists a new version after the admin opened the page, the install stops. To change the version of a community package later, the admin must accept the risk again. Each step is in the audit log with `riskAccepted: true`.

Community packages show only in **System > Nodes**. The Add node list of the editor shows official packages only.

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
      "icon": "MessageSquare",
      "nodes": [{ "type": "acme.slack.send", "label": "Send message" }]
    }
  ]
}
```

- `name` and `packages` are necessary. Each package needs `name`, `version` (`x.y.z`, no pre-release), and `sdk`.
- The package name without the scope must start with `zerodot-`, for example `zerodot-slack` or `@acme/zerodot-slack`. Other names are dropped. A registry cannot list `@zerodot/*` packages. When two registries list the same package, the first registry wins. An official package wins over a community package.
- The file must be 1 MB or less. zerodot does not follow redirects. It reads each registry again after ten minutes.
- An instance can have 20 registries. When you remove a registry, the packages that you installed from it stay installed.
- `ZERODOT_COMMUNITY_NODES=false` turns off community registries and community installs. Packages that are installed already stay installed. `ZERODOT_NODES_INSTALL=false` turns them off too.
- `ZERODOT_NODE_PACKAGES` can list any npm package. The operator who sets it accepts the risk.
