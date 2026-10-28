// SPDX-License-Identifier: AGPL-3.0-only
import type { ColumnJson } from "../server/table-fns";
import type { Json } from "./json";

/** Text from an input to a value of a column type. Empty text is null. */
export function parseCell(
  type: ColumnJson["type"],
  text: string,
): { value: Json } | { problem: string } {
  if (text.trim() === "" && type !== "string") return { value: null };
  switch (type) {
    case "string":
      return { value: text === "" ? null : text };
    case "number": {
      const n = Number(text);
      return Number.isFinite(n) ? { value: n } : { problem: "Enter a number" };
    }
    case "boolean": {
      const t = text.trim().toLowerCase();
      return t === "true" || t === "false"
        ? { value: t === "true" }
        : { problem: "Enter true or false" };
    }
    case "date": {
      const time = new Date(text).getTime();
      return Number.isNaN(time)
        ? { problem: "Enter a date" }
        : { value: new Date(time).toISOString() };
    }
    case "json":
      try {
        return { value: JSON.parse(text) as Json };
      } catch {
        return { problem: "This is not valid JSON" };
      }
  }
}

/** A value as text for an input. */
export function cellText(value: Json | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}
