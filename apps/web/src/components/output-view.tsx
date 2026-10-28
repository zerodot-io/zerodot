// SPDX-License-Identifier: AGPL-3.0-only
import {
  Button,
  cn,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@zerodot/ui";
import {
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Hash,
  List,
  Search,
  ToggleLeft,
  Type,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { extend, startDrag } from "./drag-path";
import { JsonView } from "./json-view";
import { Marked, SearchContext } from "./search-highlight";

type Mode = "schema" | "table" | "json";
const MODES: Mode[] = ["schema", "table", "json"];

type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainer(value: unknown): value is Obj | unknown[] {
  return typeof value === "object" && value !== null;
}

function entriesOf(value: Obj | unknown[]): [string, unknown][] {
  return Array.isArray(value)
    ? value.map((item, index) => [String(index), item])
    : Object.entries(value);
}

/** A leaf value as text. Null and empty text show in red italics. */
function Leaf({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <em className="text-destructive">{value === "" ? "empty" : "null"}</em>;
  }
  return <Marked text={String(value)} />;
}

function TypeIcon({ value }: { value: unknown }) {
  const className = "size-3.5";
  if (Array.isArray(value)) return <List className={className} />;
  if (isObject(value)) return <Box className={className} />;
  if (typeof value === "number") return <Hash className={className} />;
  if (typeof value === "boolean") return <ToggleLeft className={className} />;
  return <Type className={className} />;
}

function Chip({ value, label, path }: { value: unknown; label: string; path?: string }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mouse drag has no keyboard form
    <span
      draggable={path !== undefined}
      onDragStart={path === undefined ? undefined : (event) => startDrag(event, path)}
      className={cn(
        "inline-flex shrink-0 items-center overflow-hidden rounded-md border bg-card",
        path !== undefined && "cursor-grab active:cursor-grabbing",
      )}
    >
      <span className="border-r px-1.5 py-1 text-muted-foreground">
        <TypeIcon value={value} />
      </span>
      <span className="px-2 py-0.5">
        <Marked text={label} />
      </span>
    </span>
  );
}

function SchemaNode({ label, value, path }: { label: string; value: unknown; path?: string }) {
  const [open, setOpen] = useState(true);
  if (!isContainer(value)) {
    return (
      <div className="flex items-center gap-2 py-0.5 pl-6">
        <Chip value={value} label={label} path={path} />
        <span className="min-w-0 break-all text-muted-foreground">
          <Leaf value={value} />
        </span>
      </div>
    );
  }
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <div className="flex items-center gap-2 py-0.5">
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="grid size-4 place-items-center text-muted-foreground"
        >
          <Chevron className="size-3.5" />
        </button>
        <Chip value={value} label={label} path={path} />
      </div>
      {open && (
        <div className="pl-6">
          {entriesOf(value).map(([key, item]) => (
            <SchemaNode
              key={key}
              label={Array.isArray(value) ? `${label}[${key}]` : key}
              value={item}
              path={path === undefined ? undefined : extend(path, key, Array.isArray(value))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The path of item `index`. A list is `$input[0]`. A single object is `$input`. */
function itemPath(root: string | undefined, listed: boolean, index: number) {
  if (root === undefined) return undefined;
  return listed ? `${root}[${index}]` : root;
}

type ViewProps = { items: unknown[]; indexes: number[]; root?: string; listed: boolean };

function SchemaView({ items, indexes, root, listed }: ViewProps) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {items.map((item, index) => {
        const path = itemPath(root, listed, indexes[index] ?? index);
        return isObject(item) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no id
          <div key={index}>
            {Object.entries(item).map(([key, value]) => (
              <SchemaNode
                key={key}
                label={key}
                value={value}
                path={path === undefined ? undefined : extend(path, key, false)}
              />
            ))}
          </div>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: items have no id
          <SchemaNode key={index} label={`[${index}]`} value={item} path={path} />
        );
      })}
    </div>
  );
}

/** A table cell. Objects and arrays show as indented key and value lines. */
function Cell({ value }: { value: unknown }) {
  if (!isContainer(value)) return <Leaf value={value} />;
  return (
    <div className="flex flex-col gap-2">
      {entriesOf(value).map(([key, item]) => (
        <div key={key} className={isContainer(item) ? undefined : "break-all"}>
          <span className="font-semibold">
            <Marked text={key} />
          </span>
          {isContainer(item) ? (
            <div className="mt-2 pl-3">
              <Cell value={item} />
            </div>
          ) : (
            <>
              <span className="px-1 text-muted-foreground">:</span>
              <Leaf value={item} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function TableView({ items, indexes, root, listed }: ViewProps) {
  const columns = [...new Set(items.flatMap((item) => (isObject(item) ? Object.keys(item) : [])))];
  const scalar = columns.length === 0;
  const head = "border-r border-b bg-card px-3 py-2 text-left font-semibold last:border-r-0";
  const cell = "border-r px-3 py-2 align-top last:border-r-0";
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card">
      <table className="w-full border-collapse">
        <thead className="sticky top-0">
          <tr>
            {scalar ? (
              <th className={head}>value</th>
            ) : (
              columns.map((column) => (
                <th
                  key={column}
                  className={cn(head, root !== undefined && "cursor-grab active:cursor-grabbing")}
                  draggable={root !== undefined}
                  onDragStart={
                    root === undefined
                      ? undefined
                      : (event) =>
                          startDrag(
                            event,
                            extend(itemPath(root, listed, indexes[0] ?? 0) ?? root, column, false),
                          )
                  }
                >
                  <Marked text={column} />
                </th>
              ))
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id
            <tr key={index} className="border-b last:border-b-0">
              {scalar ? (
                <td className={cell}>
                  <Cell value={item} />
                </td>
              ) : (
                columns.map((column) => (
                  <td key={column} className={cell}>
                    {isObject(item) && column in item ? <Cell value={item[column]} /> : null}
                  </td>
                ))
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Node data: item count, Schema, Table and JSON views. */
export function OutputView({
  value,
  actions,
  dragRoot,
}: {
  value: unknown;
  actions?: ReactNode;
  /** When set, keys can be dragged out as expressions that start with this root, e.g. "$input". */
  dragRoot?: string;
}) {
  const [mode, setMode] = useState<Mode>("json");
  const [copied, setCopied] = useState(false);
  const all = Array.isArray(value) ? value : [value];
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);

  // Keep the first index of each item. Drag paths must point at the real item, not its page slot.
  const needle = query.trim().toLowerCase();
  const matched = all
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !needle || (JSON.stringify(item) ?? "").toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(matched.length / size));
  const current = Math.min(page, pages - 1);
  const shown = matched.slice(current * size, (current + 1) * size);
  const items = shown.map((entry) => entry.item);
  const indexes = shown.map((entry) => entry.index);
  const listed = Array.isArray(value);

  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(value, null, 2) ?? "").then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <SearchContext.Provider value={needle}>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {needle ? `${matched.length} of ${all.length}` : all.length}{" "}
            {all.length === 1 ? "item" : "items"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              aria-label="Search"
              aria-pressed={searching}
              onClick={() => {
                setSearching(!searching);
                setQuery("");
                setPage(0);
              }}
            >
              <Search className="size-3.5" />
            </Button>
            <Tabs value={mode} onValueChange={(next) => setMode(next as Mode)}>
              <TabsList>
                <TabsIndicator />
                {MODES.map((name) => (
                  <TabsTrigger key={name} value={name} className="capitalize">
                    {name === "json" ? "JSON" : name}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <Button variant="outline" size="xs" aria-label="Copy" onClick={copy}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </Button>
            {actions}
          </div>
        </div>
        {searching && (
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              autoFocus
              value={query}
              placeholder="Search"
              aria-label="Search items"
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
            />
          </InputGroup>
        )}
        {mode === "json" && (
          <JsonView
            value={listed ? items : value}
            indexes={listed ? indexes : undefined}
            root={dragRoot}
            className="min-h-0 flex-1 bg-transparent p-0"
          />
        )}
        {mode === "table" && (
          <TableView items={items} indexes={indexes} root={dragRoot} listed={listed} />
        )}
        {mode === "schema" && (
          <SchemaView
            items={items.slice(0, 1)}
            indexes={indexes.slice(0, 1)}
            root={dragRoot}
            listed={listed}
          />
        )}
        {mode !== "schema" && all.length > 10 && (
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              aria-label="Previous page"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              <ChevronLeft className="size-3.5" />
            </Button>
            <span className="px-2 text-muted-foreground tabular-nums">
              {current + 1} / {pages}
            </span>
            <Button
              variant="outline"
              size="xs"
              aria-label="Next page"
              disabled={current >= pages - 1}
              onClick={() => setPage(current + 1)}
            >
              <ChevronRight className="size-3.5" />
            </Button>
            <div className="ml-auto flex items-center gap-2 text-muted-foreground">
              Page size
              <Select
                value={String(size)}
                onValueChange={(next) => {
                  if (!next) return;
                  setSize(Number(next));
                  setPage(0);
                }}
              >
                <SelectTrigger aria-label="Page size" className="w-20">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 25, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>
    </SearchContext.Provider>
  );
}
