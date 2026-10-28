// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

/** The list that a data node works on. An expression, usually the whole input. */
export const listField = z.unknown().meta({ ui: "expression" });

export const DEFAULT_LIST = "{{ $input }}";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The list to work on. A single value counts as a list of one. Null counts as empty. */
export function toList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

/** Reads a field by path, for example "user.name" or "tags.0". Missing gives undefined. */
export function getPath(item: unknown, path: string): unknown {
  if (path === "") return item;
  let current: unknown = item;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) current = current[Number(part)];
    else if (isRecord(current)) current = current[part];
    else return undefined;
  }
  return current;
}
