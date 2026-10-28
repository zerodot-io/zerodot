// SPDX-License-Identifier: AGPL-3.0-only
import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";

const BODYLESS = new Set(["GET", "HEAD"]);

/** The shared handlers take a standard `Request`. Build one from the Node request. */
export function toRequest(req: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  const url = `${req.protocol}://${req.headers.host ?? "localhost"}${req.url}`;
  const body = BODYLESS.has(req.method) ? undefined : (req.body as Readable | undefined);
  return new Request(url, {
    method: req.method,
    headers,
    signal,
    ...(body ? { body: Readable.toWeb(body) as ReadableStream, duplex: "half" } : {}),
  });
}

/** Write a standard `Response` to the Node reply. The body streams, so SSE works. */
export function sendResponse(reply: FastifyReply, response: Response) {
  reply.status(response.status);
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") continue;
    reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  if (!response.body) return reply.send();
  return reply.send(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream));
}
