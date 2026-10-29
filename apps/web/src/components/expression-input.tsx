// SPDX-License-Identifier: AGPL-3.0-only
import { credentialRefsUsed, resolveTemplate } from "@zerodot/engine";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from "@zerodot/ui";
import { Maximize2 } from "lucide-react";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

export type VariableHint = { key: string; preview: string };

/** The project variables. The fields use them to suggest names after "$vars.". */
export const VariablesContext = createContext<VariableHint[]>([]);

/** The node names of the workflow. The fields suggest `$node["Name"].data` for them. */
export const NodeNamesContext = createContext<string[]>([]);

/** Known output data by node name. The fields suggest its keys after ".data.". */
export const NodeOutputsContext = createContext<Record<string, unknown>>({});

/** The data of the previous node. The fields suggest its keys after "$input.". */
export const InputDataContext = createContext<unknown>(undefined);

type Suggestion = { label: string; insert: string; hint: string };

const ROOTS: Suggestion[] = [
  { label: "$input", insert: "$input", hint: "output of the previous node" },
  { label: "$vars.", insert: "$vars.", hint: "project variable" },
  { label: "$credentials[", insert: '$credentials["', hint: "credential field, value hidden" },
  { label: "$run.id", insert: "$run.id", hint: "run id" },
  { label: "$run.startedAt", insert: "$run.startedAt", hint: "run start time" },
  { label: "$resumeUrl[", insert: '$resumeUrl["', hint: "resume address of a Wait node" },
];

function previewCredentials(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const { name, field } of credentialRefsUsed(text).refs) {
    out[name] = { ...out[name], [field]: "••••••" };
  }
  return out;
}

type Props = {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  /** Show the button that opens a large editor. Off inside that editor. */
  expandable?: boolean;
};

const TRIGGER = /\$vars\.([A-Za-z0-9_]*)$/;
const PATH =
  /(\$input|\$node\[("(?:[^"\\]|\\.)*")\]\.data)((?:\.[A-Za-z0-9_]+)*)\.([A-Za-z0-9_]*)$/;
const ROOT = /\$([A-Za-z0-9_]*)$/;
/** Walk a dotted path into a value. Return the object keys found there. */
function keysAt(data: unknown, path: string[]): string[] {
  let current = data;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return [];
    current = (current as Record<string, unknown>)[part];
  }
  if (typeof current !== "object" || current === null || Array.isArray(current)) return [];
  return Object.keys(current);
}

const previewOf = (value: unknown) => {
  const text = typeof value === "string" ? JSON.stringify(value) : (JSON.stringify(value) ?? "");
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
};

/** True when the caret is inside an unclosed "{{". */
const insideExpression = (before: string) => before.lastIndexOf("{{") > before.lastIndexOf("}}");

/** A text field. After you type $vars. it lists the variable names, with their values. */
export function ExpressionInput({
  id,
  value,
  onChange,
  multiline,
  className,
  placeholder,
  expandable = true,
}: Props) {
  const variables = useContext(VariablesContext);
  const nodeNames = useContext(NodeNamesContext);
  const outputs = useContext(NodeOutputsContext);
  const inputData = useContext(InputDataContext);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Show where a dragged key can land. Only a drag that carries text counts.
  const [dragging, setDragging] = useState(false);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const start = (event: DragEvent) =>
      setDragging(event.dataTransfer?.types.includes("text/plain") ?? false);
    const end = () => {
      setDragging(false);
      setOver(false);
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);

  const before = value.slice(0, caret);
  const varPrefix = TRIGGER.exec(before)?.[1];
  const rootPrefix = ROOT.exec(before)?.[0];
  const path = PATH.exec(before);
  let matches: Suggestion[] = [];
  let typed = "";
  if (!dismissed && insideExpression(before)) {
    if (path) {
      const [, , quoted, steps = "", partial = ""] = path;
      let data: unknown = inputData;
      if (quoted !== undefined) {
        try {
          data = outputs[JSON.parse(quoted) as string];
        } catch {
          data = undefined;
        }
      }
      const parts = steps.split(".").filter(Boolean);
      let target = data;
      for (const part of parts) {
        target =
          typeof target === "object" && target !== null
            ? (target as Record<string, unknown>)[part]
            : undefined;
      }
      typed = partial;
      matches = keysAt(data, parts)
        .filter((key) => key.startsWith(partial) && key !== partial)
        .map((key) => ({
          label: key,
          insert: key,
          hint: previewOf((target as Record<string, unknown>)[key]),
        }));
    } else if (varPrefix !== undefined) {
      typed = varPrefix;
      matches = variables
        .filter((v) => v.key.startsWith(varPrefix) && v.key !== varPrefix)
        .map((v) => ({ label: v.key, insert: v.key, hint: v.preview }));
    } else if (rootPrefix !== undefined) {
      typed = rootPrefix;
      matches = [
        ...ROOTS,
        ...nodeNames.map((name) => ({
          label: `$node[${JSON.stringify(name)}].data`,
          insert: `$node[${JSON.stringify(name)}].data`,
          hint: "output of that node",
        })),
      ].filter((s) => s.label.startsWith(rootPrefix) && s.label !== rootPrefix);
    }
  }

  function insert(text: string) {
    const start = before.length - typed.length;
    const next = `${value.slice(0, start)}${text}${value.slice(caret)}`;
    const position = start + text.length;
    onChange(next);
    setCaret(position);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(position, position);
    });
  }

  const shared = {
    id,
    value,
    placeholder,
    ref,
    className,
    onChange: (event: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setDismissed(false);
      setActive(0);
      const text = event.target.value;
      const position = event.target.selectionStart ?? text.length;
      // Typing "{{" opens an expression. Close it and put the caret inside.
      if (text.length > value.length && text.slice(0, position).endsWith("{{")) {
        const after = text.slice(position);
        if (!after.startsWith("}}")) {
          const inside = position + 1;
          onChange(`${text.slice(0, position)}  }}${after}`);
          setCaret(inside);
          requestAnimationFrame(() => ref.current?.setSelectionRange(inside, inside));
          return;
        }
      }
      setCaret(position);
      onChange(text);
    },
    onSelect: (event: React.SyntheticEvent<HTMLInputElement & HTMLTextAreaElement>) =>
      setCaret(event.currentTarget.selectionStart ?? 0),
    // Put a dragged key at the drop caret. Inside {{ }} it goes in as a bare path.
    onDrop: (event: React.DragEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      const dropped = event.dataTransfer.getData("text/plain");
      if (!dropped) return;
      event.preventDefault();
      setOver(false);
      const position = Math.min(event.currentTarget.selectionStart ?? caret, value.length);
      const bare = /^\{\{\s*([\s\S]*?)\s*\}\}$/.exec(dropped)?.[1];
      const text =
        bare !== undefined && insideExpression(value.slice(0, position)) ? bare : dropped;
      const next = `${value.slice(0, position)}${text}${value.slice(position)}`;
      const end = position + text.length;
      onChange(next);
      setCaret(end);
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(end, end);
      });
    },
    onFocus: () => setFocused(true),
    onBlur: () => {
      setFocused(false);
      setTimeout(() => setDismissed(true), 120);
    },
    onKeyDown: (event: React.KeyboardEvent) => {
      if (matches.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((i) => (i + 1) % matches.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((i) => (i - 1 + matches.length) % matches.length);
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insert(matches[active]?.insert ?? "");
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setDismissed(true);
      }
    },
  };

  // A value with {{ is an expression. Show the fx cell and the green {{ }} parts.
  // The field text is clear. A copy of the text with colors sits behind it.
  const expression = value.includes("{{");
  const field = {
    ...shared,
    className: cn(
      expandable && "pr-8",
      expression && "relative bg-transparent pl-12 font-mono text-transparent caret-foreground",
      expression && multiline && "pl-12",
      shared.className,
    ),
  };
  const parts = value.split(/(\{\{[\s\S]*?\}\})/);

  const open =
    matches.length > 0 ||
    (!dismissed && insideExpression(before) && varPrefix !== undefined && variables.length === 0);

  // A transformed parent, such as a dialog, is the origin of "fixed". Measure that origin.
  useLayoutEffect(() => {
    const el = list.current;
    const anchor = wrapper.current?.getBoundingClientRect();
    if (!open || !el || !anchor) return;
    el.style.top = "0px";
    el.style.left = "0px";
    const origin = el.getBoundingClientRect();
    el.style.top = `${anchor.bottom - origin.top + 4}px`;
    el.style.left = `${anchor.left - origin.left}px`;
    el.style.width = `${anchor.width}px`;
  });

  let result: { ok: true; text: string } | { ok: false; text: string } | undefined;
  if (expression && focused) {
    try {
      const resolved = resolveTemplate(value, {
        $input: inputData,
        $vars: Object.fromEntries(variables.map((v) => [v.key, v.preview])),
        $node: Object.fromEntries(Object.entries(outputs).map(([name, data]) => [name, { data }])),
        $run: { id: "run_preview", startedAt: new Date().toISOString() },
        $resumeUrl: {},
        // The browser never gets a real credential value.
        $credentials: previewCredentials(value),
      });
      const text =
        typeof resolved === "string" ? resolved : (JSON.stringify(resolved) ?? "undefined");
      result = { ok: true, text: text.length > 300 ? `${text.slice(0, 300)}…` : text };
    } catch (error) {
      result = { ok: false, text: error instanceof Error ? error.message : "Invalid expression" };
    }
  }

  return (
    <div ref={wrapper}>
      {expandable && (
        <Dialog open={expanded} onOpenChange={setExpanded}>
          <DialogContent size="lg" className="sm:max-w-4xl">
            <DialogHeader>
              <DialogTitle>Edit text</DialogTitle>
            </DialogHeader>
            <ExpressionInput
              multiline
              expandable={false}
              value={value}
              onChange={onChange}
              placeholder={placeholder}
              className="max-h-[70vh] min-h-[50vh] overflow-auto"
            />
          </DialogContent>
        </Dialog>
      )}
      {/* The fx cell and the colored copy cover this box only, not the result card below. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse drag has no keyboard form */}
      <div
        className="group/expr relative"
        onDragEnter={() => setOver(true)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        }}
      >
        {dragging && (
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border border-dashed text-xs transition-colors duration-150",
              over
                ? "border-green-600 bg-green-100/80 text-green-700"
                : "border-green-500/60 bg-green-50/60 text-transparent",
            )}
          >
            Drop here
          </div>
        )}
        {expression && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-9 items-center justify-center rounded-l-md border-r bg-secondary font-mono text-muted-foreground text-xs italic"
            >
              fx
            </span>
            <div
              aria-hidden
              className={cn(
                "pointer-events-none absolute inset-0 overflow-hidden font-mono font-normal text-base tracking-normal text-secondary-foreground",
                multiline
                  ? "whitespace-pre-wrap break-words py-2.5 pl-12 leading-lg"
                  : "flex items-center whitespace-pre py-2 pl-12 leading-base",
                expandable ? "pr-8" : multiline ? "pr-3" : "pr-2.5",
              )}
            >
              <span>
                {parts.map((part, index) =>
                  part.startsWith("{{") ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
                    <span key={index} className="rounded-sm bg-green-100 text-green-700">
                      {part}
                    </span>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts have no id
                    <span key={index}>{part}</span>
                  ),
                )}
              </span>
            </div>
          </>
        )}
        {multiline ? (
          <Textarea
            {...field}
            rows={3}
            spellCheck={false}
            className={cn("font-mono", field.className)}
          />
        ) : (
          <Input {...field} />
        )}
        {expandable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Open large editor"
            onClick={() => setExpanded(true)}
            className={cn(
              "absolute right-1.5 z-20 size-4 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-focus-within/expr:opacity-100 group-hover/expr:opacity-100",
              multiline ? "bottom-1.5" : "top-1/2 -translate-y-1/2",
            )}
          >
            <Maximize2 className="size-2.5" />
          </Button>
        )}
      </div>
      {result && !open && (
        <div className="mt-1 rounded-lg border bg-popover shadow-md">
          <div className="flex flex-col gap-1.5 p-3">
            <span className="font-medium">Result</span>
            <span
              className={cn(
                "w-fit max-w-full break-all rounded-sm px-1 font-mono text-xs",
                result.ok ? "bg-green-100 text-green-700" : "bg-error text-destructive",
              )}
            >
              {result.text}
            </span>
          </div>
          <p className="border-t px-3 py-2 text-muted-foreground">
            <span className="font-medium text-foreground">Tip:</span> Anything inside{" "}
            <code className="rounded-sm bg-secondary px-1 font-mono text-xs">{"{{ }}"}</code> is an
            expression.
          </p>
        </div>
      )}
      {open && (
        <ul
          aria-label="Suggestions"
          // Fixed, so the overflow of a parent row does not clip the list.
          ref={list}
          className="fixed z-50 max-h-48 overflow-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {matches.length === 0 && (
            <li className="px-2 py-1 text-muted-foreground">
              No variables yet. Add one in Variables.
            </li>
          )}
          {matches.map((variable, index) => (
            <li key={variable.label}>
              <button
                type="button"
                aria-current={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insert(variable.insert);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-sm px-2 py-1 text-left",
                  index === active && "bg-accent",
                )}
              >
                <span className="font-mono">{variable.label}</span>
                <span className="truncate font-mono text-muted-foreground text-xs">
                  {variable.hint}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
