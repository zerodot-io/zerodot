# Scale and high availability

The worker has two queues in Valkey. Each has its own worker loop in the same process:

- `zerodot-runs` holds run jobs. `ZERODOT_WORKER_CONCURRENCY` (default 20) sets how many run at once.
- `zerodot-system` holds cron, poll, retention, and sweep jobs. `ZERODOT_SYSTEM_CONCURRENCY` (default 5) sets how many run at once. A slow run cannot delay a cron tick.

To run more jobs at once, raise `ZERODOT_WORKER_CONCURRENCY`, or add workers. With Docker Compose, set `WORKER_REPLICAS` in `.env` or run `docker compose up -d --scale worker=3`. All workers take jobs from the same queue. Each worker opens about `ZERODOT_WORKER_CONCURRENCY + ZERODOT_SYSTEM_CONCURRENCY + 5` Postgres connections, so check `max_connections` before you add many. Docker Compose sets it to 200. Change it with `ZERODOT_DB_MAX_CONNECTIONS` in `.env`.

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

| Mode     | Variables                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------- |
| Sentinel | `VALKEY_SENTINELS=host:port,host:port`, `VALKEY_SENTINEL_NAME` (default `mymaster`), `VALKEY_PASSWORD` (optional) |
| Cluster  | `VALKEY_CLUSTER=true`, `VALKEY_PASSWORD` (optional)                                                               |
- `VALKEY_URL` must stay set. In Sentinel mode the apps ignore it. In Cluster mode it is the first node, and the client finds the other nodes.
- In Cluster mode all queue keys use the prefix `{zerodot}`, so they share one hash slot. Changing mode does not move jobs: drain the queues first.
- Valkey must keep its data (AOF on). The sweep job queues again the runs that lost their job.
