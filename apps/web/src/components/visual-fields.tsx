// SPDX-License-Identifier: AGPL-3.0-only
import { Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@zerodot/ui";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ExpressionInput } from "./expression-input";

/** Text in a field is a JSON value, or a string such as {{ expression }}. */
export function parseAny(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return undefined;
  if (text.startsWith("{{")) return raw;
  try {
    return JSON.parse(text);
  } catch {
    return raw;
  }
}

export function formatAny(value: unknown): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let counter = 0;
const nextId = () => `row-${++counter}`;

/** Rows that the user edits. A row can be half done, so the rows live here and the value follows. */
function useRows<Row extends { id: string }>(
  value: unknown,
  read: (value: unknown) => Row[],
  write: (rows: Row[]) => unknown,
  onChange: (next: unknown) => void,
) {
  const [rows, setRows] = useState<Row[]>(() => read(value));
  const latest = useRef(rows);
  latest.current = rows;
  // The value changed from outside (undo, a pasted node): read it again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: read and write do not change
  useEffect(() => {
    if (!same(write(latest.current), value)) setRows(read(value));
  }, [value]);
  const update = (next: Row[]) => {
    setRows(next);
    onChange(write(next));
  };
  return { rows, update };
}

function AddZone({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-muted/40 px-3 py-4 text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <Plus className="size-4" />
      <span className="font-medium text-primary">{label}</span>
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="mt-2 text-muted-foreground transition-colors duration-150 hover:text-foreground"
    >
      <Trash2 className="size-4" />
    </button>
  );
}

const plain = "rounded-none border-0 shadow-none focus-visible:ring-0";
const plainSelect = `${plain} w-full`;

// ---- Fields: name, type, value ----

type FieldType = "string" | "number" | "boolean" | "json";
type FieldRow = { id: string; name: string; type: FieldType; text: string };

const TYPE_LABELS: Record<FieldType, string> = {
  string: "String",
  number: "Number",
  boolean: "Boolean",
  json: "Object or array",
};

function readFields(value: unknown): FieldRow[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).map(([name, item]) => {
    if (typeof item === "number") return { id: nextId(), name, type: "number", text: String(item) };
    if (typeof item === "boolean")
      return { id: nextId(), name, type: "boolean", text: String(item) };
    if (typeof item === "string") return { id: nextId(), name, type: "string", text: item };
    return { id: nextId(), name, type: "json", text: formatAny(item) };
  });
}

function decode({ type, text }: FieldRow): unknown {
  if (type === "number")
    return text.trim() !== "" && !Number.isNaN(Number(text)) ? Number(text) : text;
  if (type === "boolean") return text === "true" ? true : text === "false" ? false : text;
  if (type === "json") return parseAny(text) ?? "";
  return text;
}

function writeFields(rows: FieldRow[]): Record<string, unknown> {
  return Object.fromEntries(
    rows.filter((r) => r.name.trim() !== "").map((r) => [r.name, decode(r)]),
  );
}

/**
 * Name, type and value for each field.
 * `typed` off gives plain text values, for example for headers.
 */
export function FieldsEditor({
  value,
  onChange,
  typed = true,
  addLabel = "Add Field",
}: {
  value: unknown;
  onChange: (next: Record<string, unknown>) => void;
  typed?: boolean;
  addLabel?: string;
}) {
  const { rows, update } = useRows<FieldRow>(value, readFields, writeFields, (next) =>
    onChange(next as Record<string, unknown>),
  );
  const patch = (id: string, change: Partial<FieldRow>) =>
    update(rows.map((r) => (r.id === id ? { ...r, ...change } : r)));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.id} className="flex gap-2">
          <RemoveButton
            label={`Remove ${row.name || "field"}`}
            onClick={() => update(rows.filter((r) => r.id !== row.id))}
          />
          <div className="flex min-w-0 flex-1 flex-col divide-y overflow-hidden rounded-md border bg-card">
            <Input
              aria-label="Key"
              placeholder="key"
              value={row.name}
              className={plain}
              onChange={(event) => patch(row.id, { name: event.target.value })}
            />
            {typed && (
              <Select
                value={row.type}
                items={Object.entries(TYPE_LABELS).map(([v, label]) => ({ value: v, label }))}
                onValueChange={(next) =>
                  patch(row.id, {
                    type: next as FieldType,
                    text:
                      next === "boolean" && !/^(true|false)$/.test(row.text) ? "true" : row.text,
                  })
                }
              >
                <SelectTrigger aria-label="Type" className={plainSelect}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([v, label]) => (
                    <SelectItem key={v} value={v}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {typed && row.type === "boolean" && /^(true|false)$/.test(row.text) ? (
              <Select
                value={row.text}
                items={[
                  { value: "true", label: "true" },
                  { value: "false", label: "false" },
                ]}
                onValueChange={(next) => next && patch(row.id, { text: next })}
              >
                <SelectTrigger aria-label="Value" className={plainSelect}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            ) : (
              <ExpressionInput
                multiline={typed && row.type === "json"}
                value={row.text}
                placeholder="value"
                className={plain}
                onChange={(text) => patch(row.id, { text })}
              />
            )}
          </div>
        </div>
      ))}
      <AddZone
        label={addLabel}
        onClick={() => update([...rows, { id: nextId(), name: "", type: "string", text: "" }])}
      />
    </div>
  );
}

// ---- Filter: field, operator, value ----

const OPS = [
  { value: "eq", label: "is equal to" },
  { value: "neq", label: "is not equal to" },
  { value: "gt", label: "is greater than" },
  { value: "gte", label: "is greater or equal" },
  { value: "lt", label: "is less than" },
  { value: "lte", label: "is less or equal" },
  { value: "contains", label: "contains" },
  { value: "in", label: "is one of (comma list)" },
  { value: "isNull", label: "is empty" },
];

type FilterRow = { id: string; field: string; op: string; text: string };

function toCondition(row: FilterRow): Record<string, unknown> {
  if (row.op === "isNull") return { field: row.field, op: row.op };
  if (row.op === "in") {
    return {
      field: row.field,
      op: row.op,
      value: row.text.split(",").map((part) => parseAny(part.trim()) ?? ""),
    };
  }
  return { field: row.field, op: row.op, value: parseAny(row.text) ?? "" };
}

function fromCondition(item: Record<string, unknown>): FilterRow | null {
  if (typeof item.field !== "string" || typeof item.op !== "string") return null;
  const text = Array.isArray(item.value)
    ? item.value.map((v) => formatAny(v)).join(", ")
    : formatAny(item.value);
  return { id: nextId(), field: item.field, op: item.op, text };
}

/** A flat filter fits the editor. A nested one does not. */
export function isFlatFilter(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (!isRecord(value)) return false;
  const list = Array.isArray(value.and) ? value.and : Array.isArray(value.or) ? value.or : null;
  if (!list) return fromCondition(value) !== null;
  return list.every((item) => isRecord(item) && fromCondition(item) !== null);
}

function readFilter(value: unknown): FilterRow[] {
  if (!isRecord(value)) return [];
  const list = Array.isArray(value.and) ? value.and : Array.isArray(value.or) ? value.or : [value];
  return list.flatMap((item) => (isRecord(item) ? (fromCondition(item) ?? []) : []));
}

export function FilterEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const [mode, setMode] = useState<"and" | "or">(
    isRecord(value) && Array.isArray(value.or) ? "or" : "and",
  );
  const write = (rows: FilterRow[], m: "and" | "or" = mode) => {
    const conditions = rows.filter((r) => r.field.trim() !== "").map(toCondition);
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : { [m]: conditions };
  };
  const { rows, update } = useRows<FilterRow>(value, readFilter, (r) => write(r), onChange);
  const patch = (id: string, change: Partial<FilterRow>) =>
    update(rows.map((r) => (r.id === id ? { ...r, ...change } : r)));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row, index) => (
        <div key={row.id} className="flex gap-2">
          <RemoveButton
            label="Remove condition"
            onClick={() => update(rows.filter((r) => r.id !== row.id))}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            {index > 0 && (
              <Select
                value={mode}
                items={[
                  { value: "and", label: "And" },
                  { value: "or", label: "Or" },
                ]}
                onValueChange={(next) => {
                  const m = next === "or" ? "or" : "and";
                  setMode(m);
                  onChange(write(rows, m));
                }}
              >
                <SelectTrigger aria-label="Combine with" className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="and">And</SelectItem>
                  <SelectItem value="or">Or</SelectItem>
                </SelectContent>
              </Select>
            )}
            <div className="flex flex-col divide-y overflow-hidden rounded-md border bg-card">
              <Input
                aria-label="Column"
                placeholder="column"
                value={row.field}
                className={plain}
                onChange={(event) => patch(row.id, { field: event.target.value })}
              />
              <Select
                value={row.op}
                items={OPS}
                onValueChange={(op) => op && patch(row.id, { op })}
              >
                <SelectTrigger aria-label="Operator" className={plainSelect}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPS.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {row.op !== "isNull" && (
                <ExpressionInput
                  value={row.text}
                  placeholder="value"
                  className={plain}
                  onChange={(text) => patch(row.id, { text })}
                />
              )}
            </div>
          </div>
        </div>
      ))}
      <AddZone
        label="Add Condition"
        onClick={() => update([...rows, { id: nextId(), field: "", op: "eq", text: "" }])}
      />
    </div>
  );
}

// ---- Sort ----

type SortRow = { id: string; field: string; direction: string };

export function isSortList(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  return (
    Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.field === "string")
  );
}

export function SortEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
}) {
  const { rows, update } = useRows<SortRow>(
    value,
    (v) =>
      Array.isArray(v)
        ? v.filter(isRecord).map((item) => ({
            id: nextId(),
            field: String(item.field ?? ""),
            direction: item.direction === "desc" ? "desc" : "asc",
          }))
        : [],
    (r) => {
      const list = r
        .filter((x) => x.field.trim() !== "")
        .map((x) => ({ field: x.field, direction: x.direction }));
      return list.length === 0 ? undefined : list;
    },
    onChange,
  );
  const patch = (id: string, change: Partial<SortRow>) =>
    update(rows.map((r) => (r.id === id ? { ...r, ...change } : r)));
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div key={row.id} className="flex gap-2">
          <RemoveButton
            label="Remove sort"
            onClick={() => update(rows.filter((r) => r.id !== row.id))}
          />
          <div className="flex min-w-0 flex-1 divide-x overflow-hidden rounded-md border bg-card">
            <Input
              aria-label="Column"
              placeholder="column"
              value={row.field}
              className={plain}
              onChange={(event) => patch(row.id, { field: event.target.value })}
            />
            <Select
              value={row.direction}
              items={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ]}
              onValueChange={(direction) => direction && patch(row.id, { direction })}
            >
              <SelectTrigger aria-label="Direction" className={`${plain} w-40`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ))}
      <AddZone
        label="Add Sort"
        onClick={() => update([...rows, { id: nextId(), field: "", direction: "asc" }])}
      />
    </div>
  );
}

// ---- List of text (the cases of a switch) ----

export function ListEditor({
  value,
  onChange,
  placeholder,
  addLabel,
}: {
  value: unknown;
  onChange: (next: string[]) => void;
  placeholder?: string;
  addLabel: string;
}) {
  const list = Array.isArray(value) ? value.map(String) : [];
  return (
    <div className="flex flex-col gap-3">
      {list.map((item, index) => (
        // The list has no ids. The index is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={index} className="flex items-start gap-2">
          <RemoveButton
            label={`Remove ${item || "item"}`}
            onClick={() => onChange(list.filter((_, i) => i !== index))}
          />
          <Input
            aria-label={placeholder}
            placeholder={placeholder}
            value={item}
            onChange={(event) =>
              onChange(list.map((x, i) => (i === index ? event.target.value : x)))
            }
          />
        </div>
      ))}
      <AddZone label={addLabel} onClick={() => onChange([...list, ""])} />
    </div>
  );
}

// ---- Field pairs: the field of input 1 and the field of input 2 (the Merge node) ----

export type FieldPair = { field1: string; field2?: string };

export function isFieldPairs(value: unknown): value is FieldPair[] {
  return (
    Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.field1 === "string")
  );
}

export function FieldPairsEditor({
  value,
  onChange,
  differentNames,
}: {
  value: FieldPair[] | undefined;
  onChange: (next: FieldPair[]) => void;
  /** True: each pair has a field for input 2 too. */
  differentNames: boolean;
}) {
  const list = value ?? [];
  const update = (index: number, patch: Partial<FieldPair>) =>
    onChange(list.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  return (
    <div className="flex flex-col gap-3">
      {list.map((pair, index) => (
        // The list has no ids. The index is the identity.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <div key={index} className="flex items-start gap-2">
          <RemoveButton
            label="Remove field pair"
            onClick={() => onChange(list.filter((_, i) => i !== index))}
          />
          <Input
            aria-label={differentNames ? "Input 1 field" : "Field"}
            placeholder={differentNames ? "Input 1 field" : "Field"}
            value={pair.field1}
            onChange={(event) => update(index, { field1: event.target.value })}
          />
          {differentNames && (
            <Input
              aria-label="Input 2 field"
              placeholder="Input 2 field"
              value={pair.field2 ?? ""}
              onChange={(event) => update(index, { field2: event.target.value })}
            />
          )}
        </div>
      ))}
      <AddZone label="Add field to match" onClick={() => onChange([...list, { field1: "" }])} />
    </div>
  );
}

// ---- Condition: left, operator, right (the If node) ----

const COMPARE = [
  { value: "==", label: "is equal to" },
  { value: "!=", label: "is not equal to" },
  { value: ">", label: "is greater than" },
  { value: ">=", label: "is greater or equal" },
  { value: "<", label: "is less than" },
  { value: "<=", label: "is less or equal" },
];

const COMPARISON = /^\{\{\s*(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+?)\s*\}\}$/;

type Comparison = { left: string; op: string; right: string };

function readComparison(value: unknown): Comparison | null {
  if (typeof value !== "string") return null;
  const match = COMPARISON.exec(value);
  if (!match) return null;
  const [, left = "", op = "==", right = ""] = match;
  // A quoted string shows without quotes.
  try {
    const parsed: unknown = JSON.parse(right);
    if (typeof parsed === "string") return { left, op, right: parsed };
  } catch {
    // Not JSON: a number, a $input path or an expression part. Show it as it is.
  }
  return { left, op, right };
}

/** A number, a keyword or a path stays bare. Other text gets quotes. */
function quote(right: string): string {
  const text = right.trim();
  if (text === "" || /^(-?\d+(\.\d+)?|true|false|null|\$[\w.[\]]+|".*")$/.test(text)) return text;
  return JSON.stringify(text);
}

export function isComparison(value: unknown): boolean {
  return value === undefined || value === "" || readComparison(value) !== null;
}

export function ConditionEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: string | undefined) => void;
}) {
  const [state, setState] = useState<Comparison>(
    () => readComparison(value) ?? { left: "", op: "==", right: "" },
  );
  const emit = (next: Comparison) => {
    setState(next);
    onChange(
      next.left.trim() === ""
        ? undefined
        : `{{ ${next.left.trim()} ${next.op} ${quote(next.right) || '""'} }}`,
    );
  };
  return (
    <div className="flex flex-col divide-y overflow-hidden rounded-md border bg-card">
      <ExpressionInput
        value={state.left}
        placeholder="value"
        className={plain}
        onChange={(left) => emit({ ...state, left })}
      />
      <Select value={state.op} items={COMPARE} onValueChange={(op) => op && emit({ ...state, op })}>
        <SelectTrigger aria-label="Operator" className={plainSelect}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {COMPARE.map((op) => (
            <SelectItem key={op.value} value={op.value}>
              {op.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ExpressionInput
        value={state.right}
        placeholder="value"
        className={plain}
        onChange={(right) => emit({ ...state, right })}
      />
    </div>
  );
}
