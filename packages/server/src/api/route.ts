// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";
import type { ApiContext } from "./context.server";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** A handler can set a status other than the route default. */
export class Reply<T> {
  constructor(
    readonly status: number,
    readonly body: T,
  ) {}
}

export type RawInput = {
  params: Record<string, string>;
  query: Record<string, string | string[]>;
  body: unknown;
  request: Request;
};

/** A route with its types erased. The router and the OpenAPI builder use this shape. */
export type Route = {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  /** `admin` routes need an admin API key or an owner or admin session. */
  role: "member" | "admin";
  status: number;
  /** Other statuses that carry the same response body. */
  alsoStatus: number[];
  schemas: {
    params: z.ZodType | undefined;
    query: z.ZodType | undefined;
    body: z.ZodType | undefined;
    response: z.ZodType;
  };
  /** True for a route that answers with a stream. */
  stream: boolean;
  run(ctx: ApiContext, raw: RawInput): Promise<Reply<unknown> | Response | unknown>;
};

const empty = z.object({});

type Def<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType, R extends z.ZodType> = {
  method: Method;
  path: string;
  summary: string;
  description?: string;
  tag: string;
  role?: "member" | "admin";
  status?: number;
  alsoStatus?: number[];
  stream?: boolean;
  params?: P;
  query?: Q;
  body?: B;
  response: R;
  handler(
    ctx: ApiContext,
    input: { params: z.output<P>; query: z.output<Q>; body: z.output<B>; request: Request },
  ): Promise<z.input<R> | Reply<z.input<R>> | Response>;
};

/** Types come from the Zod schemas. Input is parsed before the handler runs. */
export function defineRoute<
  P extends z.ZodType = typeof empty,
  Q extends z.ZodType = typeof empty,
  B extends z.ZodType = typeof empty,
  R extends z.ZodType = z.ZodUnknown,
>(def: Def<P, Q, B, R>): Route {
  return {
    method: def.method,
    path: def.path,
    summary: def.summary,
    description: def.description,
    tag: def.tag,
    role: def.role ?? "member",
    status: def.status ?? 200,
    alsoStatus: def.alsoStatus ?? [],
    stream: def.stream ?? false,
    schemas: { params: def.params, query: def.query, body: def.body, response: def.response },
    async run(ctx, raw) {
      const params = (def.params ?? empty).parse(raw.params) as z.output<P>;
      const query = (def.query ?? empty).parse(raw.query) as z.output<Q>;
      const body = (def.body ?? empty).parse(raw.body ?? {}) as z.output<B>;
      return def.handler(ctx, { params, query, body, request: raw.request });
    },
  };
}
