// SPDX-License-Identifier: AGPL-3.0-only

/** One JSON line per event. Never log secrets or full node data. */
export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
) {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  (level === "error" ? console.error : console.log)(line);
}
