# @zerodot/node-sdk

The contract for [zerodot](https://github.com/zerodot-io/zerodot) node packages: `defineNode`, the node and credential types, helpers for items, binary data and icons, and `SDK_VERSION`.

See [nodes](https://github.com/zerodot-io/nodes) for real packages.

## Install

```sh
npm install --save-peer @zerodot/node-sdk zod
```

Declare the contract versions that your package works with in its `package.json`. zerodot checks the range before it runs any package code.

```json
{ "zerodot": { "sdk": "^1.4" } }
```

## A node

```ts
import { defineNode } from "@zerodot/node-sdk";
import { z } from "zod";

export default defineNode({
  type: "acme.greet",
  label: "Greet",
  description: "Says hello to a person",
  category: "integration",
  icon: "UserIcon",
  config: z.object({ name: z.string().min(1) }),
  defaultConfig: { name: "" },
  ports: { in: ["in"], out: ["out"] },
  run: ({ config, input }) => ({ port: "out", data: { message: `Hello ${config.name}`, input } }),
});
```

The config can hold expressions, for example `{{ $input.name }}`. zerodot resolves them before `run` gets the config.

## Nodes as agent tools

An AI Agent can use a node as a tool. Set `usableAsTool` to control this. If you do not set it, an `integration` node is a tool and other nodes are not. Trigger nodes, supply nodes and join nodes are never tools.

```ts
defineNode({ type: "acme.greet", usableAsTool: true /* ... */ });
```

In a tool node, `$fromAI` marks a value that the model gives. zerodot makes the input schema of the tool from these calls. The type is `string` (default), `number`, `boolean`, or `json`.

```text
{{ $fromAI("name", "The name of the person") }}
{{ $fromAI("count", "How many times", "number") }}
```

The model gets the output of `run`. Binary data is sent as its type, file name and size only.

Community packages (not `@zerodot/*`) are tools only when the server sets `ZERODOT_COMMUNITY_NODES_AS_TOOLS=true`.

## Supply nodes

A supply node gives a value (for example a chat model or a memory) to a supply port of another node. It has no ports and no step. Supply nodes and supply ports work only in official `@zerodot/*` packages.

```ts
import { defineSupplyNode } from "@zerodot/node-sdk";

export default defineSupplyNode({
  type: "acme.model",
  label: "Acme Chat Model",
  category: "integration",
  icon: "AiBrain01Icon",
  config: z.object({ model: z.string() }),
  defaultConfig: { model: "" },
  supplies: "ai.model",
  supply: ({ config, credential }) => createModel(config.model, credential),
});
```

A node that takes supplies declares `supplyPorts`, and `run` gets the values in `supplies`:

```ts
supplyPorts: [
  { name: "model", kind: "ai.model", label: "Chat Model", required: true },
  { name: "tools", kind: "ai.tool", label: "Tool", multiple: true },
],
```

`TOOL_KIND` (`"ai.tool"`) is the kind of a tool port. A tool port also takes normal nodes that can be tools.

From 1.5:

- A node that runs as a tool gets its `supplies` too, for each call.
- A supply node can declare `supplyPorts`. `supply` then gets the values in `supplies` (for example, a vector store tool with an embedding supply).
- The engine builds a supply value one time for the run when its config and credential use no `$input`, `$node`, or `$fromAI`, and the supply nodes under it do not either. Otherwise it builds the value for each run of the parent.
- A supply port can have `showWhen` and `hideWhen`, as a config field has. A hidden port gives no value and is not required. The rules read the saved config, before expressions resolve.
- When a supply value has a `close()` function, the engine calls it when the value is not used again: at the end of the run for a value it keeps, or when the parent is done. The last value built closes first. A close that fails or takes more than 5 seconds shows on the supply node and does not stop the run. Use this to keep one connection for the run.
- A value from the run cache writes its logs to the node that uses it now. When a node attempt that used cached values fails, the engine closes them and builds them again for the next use, so a retry gets a new connection.

## Option icons

An option of a select can show an icon. Both fields are optional. `iconUrl` (a data URL, see `fileIcon`) wins over `icon` (a Hugeicons name, for example `Globe02Icon`).

```ts
// A nested field (FieldSpec)
options: [{ value: "get", label: "Get", hint: "Read a row", icon: "Download01Icon" }];

// A select in the config schema, by value, like `hints`
z.enum(["get", "put"]).meta({ icons: { get: { icon: "Download01Icon" }, put: { iconUrl } } });
```

The type is `ItemIcon`: `{ icon?: string; iconUrl?: string }`.

## Versions

`SDK_VERSION` is the version of the contract. A minor version only adds. A major version can break a package. `satisfiesSdk(range)` tells if the contract fits a range.

| Contract | Adds                                                                            |
| -------- | ------------------------------------------------------------------------------- |
| 1.4      | Supply ports and supply nodes, nodes as agent tools (`usableAsTool`, `$fromAI`) |
| 1.5      | Supplies for tool runs and supply nodes, run cache, `close()`, port `showWhen`  |

MIT license.
