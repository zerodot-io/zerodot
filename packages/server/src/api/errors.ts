// SPDX-License-Identifier: AGPL-3.0-only
import { ConflictError } from "@zerodot/db";
import { GraphError, TableError } from "@zerodot/engine";
import { ZodError } from "zod";

export type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/** A problem the caller can see. The message goes to the client as it is. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new ApiError(400, "bad_request", message, details);
export const unauthorized = (message = "Missing or invalid API key") =>
  new ApiError(401, "unauthorized", message);
export const forbidden = (message = "This API key cannot do this") =>
  new ApiError(403, "forbidden", message);
export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new ApiError(409, "conflict", message);

/** Maps any thrown value to the one error shape. Unknown errors give a plain 500. */
export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, details: error.details } },
    };
  }
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: "bad_request",
          message: "The request is not valid",
          details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
    };
  }
  if (error instanceof ConflictError) {
    return { status: 409, body: { error: { code: "conflict", message: error.message } } };
  }
  if (error instanceof TableError || error instanceof GraphError) {
    return { status: 400, body: { error: { code: "bad_request", message: error.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "internal", message: "Something went wrong on the server" } },
  };
}

export function errorResponse(error: unknown, headers: Record<string, string> = {}): Response {
  const { status, body } = toErrorBody(error);
  return Response.json(body, { status, headers });
}
