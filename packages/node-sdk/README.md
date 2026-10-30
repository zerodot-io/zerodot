# @zerodot/node-sdk

The contract for [zerodot](https://github.com/zerodot-io/zerodot) node packages: `defineNode`, the node and credential types, helpers for items, binary data and icons, and `SDK_VERSION`.

A node package depends on this package as a peer dependency and declares the contract versions it works with in its `package.json`:

```json
{ "zerodot": { "sdk": "^1.0" } }
```

zerodot checks the range before it runs any package code. See [nodes](https://github.com/zerodot-io/nodes) for examples.

## Option icons

An option of a select can show an icon. Both fields are optional. `iconUrl` (a data URL, see `fileIcon`) wins over `icon` (a Hugeicons name, for example `Globe02Icon`).

```ts
// A nested field (FieldSpec)
options: [{ value: "get", label: "Get", hint: "Read a row", icon: "Download01Icon" }];

// A select in the config schema, by value, like `hints`
z.enum(["get", "put"]).meta({ icons: { get: { icon: "Download01Icon" }, put: { iconUrl } } });
```

The type is `ItemIcon`: `{ icon?: string; iconUrl?: string }`.

MIT license.
