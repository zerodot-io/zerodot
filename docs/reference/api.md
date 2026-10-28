# API and MCP

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
