// SPDX-License-Identifier: AGPL-3.0-only
import { readStream } from "@zerodot/queue";
import type { Redis } from "ioredis";

const encoder = new TextEncoder();
const PING_MS = 15_000;

/**
 * Forward a Valkey stream as server-sent events. The stream entry id is the SSE id,
 * so the browser sends Last-Event-ID when it reconnects.
 */
export async function streamEvents(
  request: Request,
  key: string,
  stopOnFinish: boolean,
  reader: () => Redis,
) {
  const redis = reader();
  let lastId = request.headers.get("last-event-id") ?? "0";

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      try {
        while (!request.signal.aborted) {
          const entries = await readStream(redis, key, lastId, PING_MS);
          if (entries.length === 0) {
            controller.enqueue(encoder.encode(": ping\n\n"));
            continue;
          }
          for (const { id, event } of entries) {
            lastId = id;
            controller.enqueue(
              encoder.encode(`id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
            );
            if (stopOnFinish && event.type === "run.finished") {
              controller.close();
              return;
            }
          }
        }
        controller.close();
      } catch (error) {
        if (!request.signal.aborted) controller.error(error);
      } finally {
        redis.disconnect();
      }
    },
    cancel() {
      redis.disconnect();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
