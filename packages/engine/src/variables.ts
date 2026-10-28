// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

export const VARIABLE_TYPES = ["string", "number", "boolean", "json"] as const;
export type VariableType = (typeof VARIABLE_TYPES)[number];

export const MAX_VARIABLES = 500;
export const MAX_VARIABLE_VALUE_BYTES = 64 * 1024;

export const VARIABLE_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Returns an error message, or null when the value fits the type and the size limit. */
export function checkVariableValue(type: VariableType, value: unknown): string | null {
  const ok =
    (type === "string" && typeof value === "string") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "json" && value !== undefined);
  if (!ok) return `The value must be of type ${type}`;
  const size = new TextEncoder().encode(JSON.stringify(value)).length;
  return size > MAX_VARIABLE_VALUE_BYTES ? "The value is larger than 64 KB" : null;
}

export const variableInputSchema = z
  .object({
    key: z
      .string()
      .max(64)
      .regex(VARIABLE_KEY_PATTERN, "Use letters, digits, and _. Do not start with a digit."),
    type: z.enum(VARIABLE_TYPES),
    value: z.unknown(),
    description: z.string().max(500).default(""),
  })
  .superRefine((input, ctx) => {
    const problem = checkVariableValue(input.type, input.value);
    if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["value"] });
  });
