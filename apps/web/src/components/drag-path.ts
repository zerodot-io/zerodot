// SPDX-License-Identifier: AGPL-3.0-only
import type { DragEvent } from "react";

const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Append one key to an expression path: `.name`, `["odd name"]` or `[0]`. */
export function extend(path: string, key: string, isIndex: boolean) {
  if (isIndex) return `${path}[${key}]`;
  return SAFE_KEY.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** Start a drag that carries the path as an expression. Text fields take it as text. */
export function startDrag(event: DragEvent, path: string) {
  event.dataTransfer.setData("text/plain", `{{ ${path} }}`);
  event.dataTransfer.effectAllowed = "copy";
}
