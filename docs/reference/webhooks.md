# Webhooks

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
