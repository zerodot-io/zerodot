# Core nodes

## Data and file nodes

- `HTML Extract` reads HTML (a string, or the `data` field of the input) with CSS selectors. Each selector gives one key. Return the text, the HTML, an attribute, or the `value`. `Return Array` gives every match.
- `XML` turns XML into JSON and JSON into XML. Attributes use the prefix `@_` and mixed text uses `#text`. Both can be changed.
- `RSS Read` fetches an RSS 2.0, RSS 1.0, or Atom feed and returns one item for each entry.
- `Convert to File` makes a CSV, JSON, or text file from items. `Extract from File` reads them back. The file is base64 text in `binary.<property>` of the item. There is no separate binary store.
- `Compression` makes or opens a gzip file. Zip is not supported.
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
