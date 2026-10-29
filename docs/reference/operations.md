# Operations

## System page

The System page shows the queues, the workers and the counters of the whole server. It is for the instance admin only, not for project admins.

- **Who is admin:** a signed-in user whose email is in `ZERODOT_ADMIN_EMAILS` (comma separated). When the list is empty, the first user who signed up is the admin.
- **Turn it off:** `ZERODOT_ADMIN_UI=false`. Then every admin call answers 404.
- **What an admin can do:** cancel any run, retry, remove or promote a job, clean a queue, pause and resume a queue. Each change writes one row to the `admin_audit` table (who, what, which id). Rows hold ids and counts only.
- **What it never shows:** job data, node input or node output.

## Update notice

The instance admin sees a toast when a new version is out, one time for each version. The About dialog keeps a link to the release.

- **How it works:** the web app asks the GitHub tags API for the newest `vX.Y.Z` tag, at most once a day. A failed request waits one hour. The request has no cookie and no data about your instance. GitHub sees the IP address of the server.
- **Turn it off:** `ZERODOT_UPDATE_CHECK=false` in the web app. Then Zerodot makes no call to GitHub.
- **Who sees it:** the instance admin only. Other users see nothing.

## Retention

A daily job in the worker deletes old data. It never changes data tables.

| Data                       | Rule                   | Setting                                                                   |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Test runs                  | Deleted after 7 days   | `ZERODOT_TEST_RUN_RETENTION_DAYS`                                         |
| Production runs (finished) | Deleted after 30 days  | `ZERODOT_RUN_RETENTION_DAYS`, or the project setting on the Settings page |
| Insight rollups            | Deleted after 365 days | `ZERODOT_STATS_RETENTION_DAYS`                                            |

A run that has not finished stays. Insight rollups stay when their runs are deleted.

The job deletes runs in batches (1000 runs for each statement, a short pause between batches). One job deletes at most 200 batches, so it never holds locks for long. If more old runs remain, the next job continues. `purgeRuns` takes `batchSize`, `maxBatches` and `pauseMs`, so a caller can run it each hour with a small `maxBatches`.
