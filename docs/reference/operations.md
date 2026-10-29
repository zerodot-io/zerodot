# Operations

## System page

The System page shows the queues, the workers and the counters of the whole server. It is for the instance admin only, not for project admins.

- **Who is admin:** a signed-in user whose email is in `ZERODOT_ADMIN_EMAILS` (comma separated). When the list is empty, the first user who signed up is the admin.
- **Turn it off:** `ZERODOT_ADMIN_UI=false`. Then every admin call answers 404.
- **What an admin can do:** cancel any run, retry, remove or promote a job, clean a queue, pause and resume a queue. Each change writes one row to the `admin_audit` table (who, what, which id). Rows hold ids and counts only.
- **What it never shows:** job data, node input or node output.

## Feedback widget

The web app has a feedback widget. A signed-in user opens it from **Send feedback** in the Account menu of the sidebar, and sends a feature request to the Zerodot board on FeedbackJar. There is no floating button, and the sign-in pages do not load it.

- **What loads:** the browser of a signed-in user loads `https://cdn.feedbackjar.com/sdk.js`.
- **What goes with a feedback:** the name and email of the signed-in user, the user role (`instance admin` or `member`), the Zerodot version, and the system of the server (for example `linux 6.8.0 x64`). FeedbackJar also sees the usual request data of the browser. Zerodot sends no workflow data and no credentials.
- **Turn it off:** `ZERODOT_FEEDBACK_WIDGET=false` in the web app. Then the browser loads nothing from FeedbackJar.

## Retention

A daily job in the worker deletes old data. It never changes data tables.

| Data                       | Rule                   | Setting                                                                   |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------- |
| Test runs                  | Deleted after 7 days   | `ZERODOT_TEST_RUN_RETENTION_DAYS`                                         |
| Production runs (finished) | Deleted after 30 days  | `ZERODOT_RUN_RETENTION_DAYS`, or the project setting on the Settings page |
| Insight rollups            | Deleted after 365 days | `ZERODOT_STATS_RETENTION_DAYS`                                            |

A run that has not finished stays. Insight rollups stay when their runs are deleted.

The job deletes runs in batches (1000 runs for each statement, a short pause between batches). One job deletes at most 200 batches, so it never holds locks for long. If more old runs remain, the next job continues. `purgeRuns` takes `batchSize`, `maxBatches` and `pauseMs`, so a caller can run it each hour with a small `maxBatches`.
