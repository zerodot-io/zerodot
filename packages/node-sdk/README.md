# @zerodot/node-sdk

The contract for [zerodot](https://github.com/zerodot-io/zerodot) node packages: `defineNode`, the node and credential types, helpers for items, binary data and icons, and `SDK_VERSION`.

A node package depends on this package as a peer dependency and declares the contract versions it works with in its `package.json`:

```json
{ "zerodot": { "sdk": "^1.0" } }
```

zerodot checks the range before it runs any package code. See [nodes](https://github.com/zerodot-io/nodes) for examples.

MIT license.
