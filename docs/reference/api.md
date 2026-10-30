# API and MCP

Create an API key in the project (API keys page). Send it as `Authorization: Bearer <key>`.

- REST API: `/api/v1`. OpenAPI 3.1 document: `/api/v1/openapi.json`.
- MCP server (Streamable HTTP): `/mcp`. Same keys, same project scope and roles.
- Set `ZERODOT_BOOTSTRAP_API_KEY` (`zerodot_` and at least 32 letters or digits) to use a key that you chose. Sign up first. The first call with the key saves it as an admin key in `ZERODOT_BOOTSTRAP_PROJECT` (a project slug), or in the oldest project. Delete it in the app to revoke it. If you change the variable, the old key stays until you delete it.
- Make a key without a browser: sign in with `POST /api/auth/sign-in/email` (keep the cookie), then `POST /api/v1/api-keys` with the cookie and the header `x-zerodot-project: <project slug>`. Body: `{"name":"ci","role":"admin","expiresInDays":null}`. The answer has the full key once. An API key cannot make or delete keys.
- Roles: `member` (workflows, runs, table rows) and `admin` (also variables, credentials, table schemas).
- Settings: `ZERODOT_API_RATE_LIMIT_PER_MINUTE` (default 600 for each key), `ZERODOT_WEBHOOK_RATE_LIMIT_PER_MINUTE` (default 6000 for each webhook token, 0 turns it off; over it a webhook gets `429`), and `ZERODOT_WEBHOOK_SYNC_TIMEOUT_MS` (default 30000, the longest `wait=true` request). `wait=true` and the webhook response modes hold a request open. One process holds at most `ZERODOT_MAX_HELD_WEBHOOKS` (default 500) of them. A webhook call over the cap gets `503` with `Retry-After: 5` and starts no run. An API `wait=true` call over the cap does not wait: it returns at once with the run id, like a timeout. The slot is freed when the run ends, the time is up, or the client closes the connection.

```sh
curl -H "Authorization: Bearer $ZERODOT_KEY" -X POST \
  "$ZERODOT_URL/api/v1/workflows/$ID/run?wait=true" -d '{"input":{"name":"Ada"}}' \
  -H "content-type: application/json"
```
