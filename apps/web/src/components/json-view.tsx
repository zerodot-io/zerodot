// SPDX-License-Identifier: AGPL-3.0-only
import { cn } from "@zerodot/ui";
import { type ReactNode, useMemo } from "react";
import { extend, startDrag } from "./drag-path";
import { Marked } from "./search-highlight";

const TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}[\],]/g;

/** Monaco JSON view. Menlo is the macOS fallback. */
const JSON_FONT = 'Monaco, Menlo, "Courier New", monospace';

const PUNCTUATION = "text-muted-foreground";

/** Show a quote inside a string as `"`, not `\"`. The copy button still gives valid JSON. */
const plain = (text: string) => text.replace(/\\"/g, '"');

function highlight(text: string, offset: number): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index;
    if (start > last) nodes.push(text.slice(last, start));
    const [token, string, colon] = match;
    const key = offset + start;
    if (string && colon) {
      nodes.push(
        <span key={key} className="text-foreground">
          <Marked text={plain(string)} />
        </span>,
        <span key={`${key}:`} className={PUNCTUATION}>
          {colon}
        </span>,
      );
    } else {
      let color = "text-emerald-700 dark:text-emerald-400";
      if (string) color = "text-violet-700 dark:text-violet-400";
      else if (/^[{}[\],]$/.test(token)) color = PUNCTUATION;
      else if (/^(true|false|null)$/.test(token)) color = "text-sky-700 dark:text-sky-400";
      nodes.push(
        <span key={key} className={color}>
          <Marked text={string ? plain(token) : token} />
        </span>,
      );
    }
    last = start + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Line = { text: string; depth: number; path?: string };

/** The lines of `JSON.stringify(value, null, 2)`. A line with a key knows its expression path. */
function toLines(value: unknown, root?: string, indexes?: number[]): Line[] {
  const lines: Line[] = [];
  const walk = (
    item: unknown,
    depth: number,
    key: string | undefined,
    path: string | undefined,
    comma: string,
  ) => {
    const prefix = key === undefined ? "" : `${JSON.stringify(key)}: `;
    const own = key === undefined ? undefined : path;
    if (typeof item === "object" && item !== null) {
      const list = Array.isArray(item);
      const open = list ? "[" : "{";
      const close = list ? "]" : "}";
      const entries = list
        ? item.map((child, index): [string, unknown] => [String(index), child])
        : Object.entries(item).filter(([, child]) => child !== undefined);
      if (entries.length === 0) {
        lines.push({ text: `${prefix}${open}${close}${comma}`, depth, path: own });
        return;
      }
      lines.push({ text: `${prefix}${open}`, depth, path: own });
      entries.forEach(([childKey, child], index) => {
        const childPath =
          path === undefined
            ? undefined
            : extend(
                path,
                depth === 0 && list && indexes
                  ? String(indexes[Number(childKey)] ?? childKey)
                  : childKey,
                list,
              );
        walk(
          child,
          depth + 1,
          list ? undefined : childKey,
          childPath,
          index < entries.length - 1 ? "," : "",
        );
      });
      lines.push({ text: `${close}${comma}`, depth });
      return;
    }
    lines.push({
      text: `${prefix}${JSON.stringify(item) ?? "undefined"}${comma}`,
      depth,
      path: own,
    });
  };
  walk(value, 0, undefined, root, "");
  return lines;
}

/**
 * A value as JSON text, with syntax colors and a dashed guide for each indent level.
 * With `root`, every key line can be dragged out as an expression.
 */
export function JsonView({
  value,
  className,
  root,
  indexes,
}: {
  value: unknown;
  className?: string;
  root?: string;
  /** Real item numbers when `value` is one page of a list. Drag paths use them. */
  indexes?: number[];
}) {
  const lines = useMemo(() => {
    let offset = 0;
    return toLines(value, root, indexes).map(({ text, depth, path }) => {
      const row = { depth, path, nodes: highlight(text, offset), offset };
      offset += text.length + 1;
      return row;
    });
  }, [value, root, indexes]);
  return (
    <pre
      style={{ fontFamily: JSON_FONT }}
      className={cn(
        "overflow-y-auto overflow-x-hidden rounded-md bg-muted p-2 font-mono text-xs leading-6",
        className,
      )}
    >
      {lines.map(({ depth, nodes, offset, path }) => (
        <div key={offset} className="flex">
          <span
            aria-hidden
            className="shrink-0"
            style={{
              width: `${depth * 2}ch`,
              backgroundImage:
                "repeating-linear-gradient(to right, color-mix(in oklab, currentColor 20%, transparent) 0 1px, transparent 1px 2ch)",
            }}
          />
          {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse drag has no keyboard form */}
          <span
            draggable={root !== undefined && path !== undefined}
            onDragStart={
              root === undefined || path === undefined
                ? undefined
                : (event) => startDrag(event, path)
            }
            className={cn(
              "min-w-0 whitespace-pre-wrap break-all rounded-sm",
              root !== undefined &&
                path !== undefined &&
                "cursor-grab hover:bg-primary/15 active:cursor-grabbing",
            )}
          >
            {nodes}
          </span>
        </div>
      ))}
    </pre>
  );
}
