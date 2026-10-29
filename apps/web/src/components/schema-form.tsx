// SPDX-License-Identifier: AGPL-3.0-only

import { type FieldSpec, type ItemIcon, isVisible, type ShowRules } from "@zerodot/engine";
import {
  Button,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@zerodot/ui";
import { ChevronDown, Plus, X } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { columnOptions, prefillRow } from "../lib/table-prefill";
import { CodeEditor } from "./code-editor";
import { CronField } from "./cron-field";
import { ExpressionInput } from "./expression-input";
import { ConditionsEditor, FieldCollectionEditor } from "./field-collection";
import { ItemIconView } from "./node-icon";
import { TimezoneSelect } from "./timezone-select";
import {
  ConditionEditor,
  FieldPairsEditor,
  FieldsEditor,
  FilterEditor,
  formatAny,
  isComparison,
  isFieldPairs,
  isFlatFilter,
  isRecord,
  isSortList,
  ListEditor,
  parseAny,
  SortEditor,
} from "./visual-fields";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  enum?: unknown[];
  items?: JsonSchema;
  additionalProperties?: JsonSchema | boolean;
  default?: unknown;
  /** Set with .meta({ ui: "code" }) in the Zod schema. */
  ui?: string;
  /** The form of a nested field. Set with `ui: "field-collection"`. */
  fieldSpec?: FieldSpec;
  /** The label of the field. The default is the key. */
  title?: string;
  description?: string;
  /** Hint text of an empty text field. */
  placeholder?: string;
  /** The text of each enum value. The default is the value. */
  labels?: Record<string, string>;
  /** A line under each enum value in a select or multi select. */
  hints?: Record<string, string>;
  /** An icon for each enum value, by value. Shows before the text in a select or multi select. */
  icons?: Record<string, ItemIcon>;
  /** Shows under "Options", after the user adds it, like the options of a node. */
  option?: boolean;
  /** `table-column`: which columns of the picked table to offer. */
  columns?: "unique" | "all";
  /** `table-column`: offer `id` too. */
  idOption?: boolean;
  /** Enum values that show only under a rule, by value. For example the inputs a node has. */
  optionRules?: Record<string, ShowRules>;
  /** `fields`: fill the keys with the columns of the picked table. */
  prefill?: "columns";
} & ShowRules;
// `showWhen` and `hideWhen` are set with .meta({ showWhen: { operation: ["get"] } }).
// The field shows when a value matches (see `isVisible` in @zerodot/engine).

/** Picks a data table. The value is the id. A value that is an expression stays as it is. */
function TablePicker({
  id,
  value,
  tables,
  onChange,
}: {
  id: string;
  value: string;
  tables: TableHint[];
  onChange: (value: string) => void;
}) {
  const current = tables.find((t) => t.id === value || t.name === value);
  return (
    <div className="flex flex-col gap-1">
      {tables.length === 0 || (value !== "" && !current) ? (
        <ExpressionInput id={id} value={value} onChange={onChange} />
      ) : (
        <Select
          value={current?.id ?? ""}
          items={tables.map((t) => ({ value: t.id, label: t.name }))}
          onValueChange={(next) => next && onChange(next)}
        >
          <SelectTrigger id={id}>
            <SelectValue placeholder="Pick a table" />
          </SelectTrigger>
          <SelectContent>
            {tables.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {tables.length === 0 && (
        <span className="text-muted-foreground">
          No data tables yet. Create one in Data tables.
        </span>
      )}
      {current && (
        <span className="font-mono text-muted-foreground text-xs">
          {current.columns
            .map((c) => `${c.key}: ${c.type}${c.unique ? " (unique)" : ""}`)
            .join(", ")}
        </span>
      )}
    </div>
  );
}

/** Picks a column of the table that the node uses. Without a known table it is a text field. */
function ColumnPicker({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: string;
  /** The keys to pick from. Empty when the table is not known. */
  options: string[];
  onChange: (value: string) => void;
}) {
  if (options.length === 0 || (value !== "" && !options.includes(value))) {
    return <ExpressionInput id={id} value={value} onChange={onChange} />;
  }
  return (
    <Select
      value={value}
      items={options.map((key) => ({ value: key, label: key }))}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="Pick a column" />
      </SelectTrigger>
      <SelectContent>
        {options.map((key) => (
          <SelectItem key={key} value={key}>
            {key}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Picks another workflow. The value is the id. A value that is an expression stays as it is. */
function WorkflowPicker({
  id,
  value,
  workflows,
  onChange,
}: {
  id: string;
  value: string;
  workflows: WorkflowHint[];
  onChange: (value: string) => void;
}) {
  const current = workflows.find((w) => w.id === value);
  if (workflows.length === 0 || (value !== "" && !current)) {
    return <ExpressionInput id={id} value={value} onChange={onChange} />;
  }
  return (
    <Select
      value={current?.id ?? ""}
      items={workflows.map((w) => ({ value: w.id, label: w.name }))}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="Pick a workflow" />
      </SelectTrigger>
      <SelectContent>
        {workflows.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** A workflow the node form can pick. */
export type WorkflowHint = { id: string; name: string };

/** A data table the node form can pick. */
export type TableHint = {
  id: string;
  name: string;
  columns: { key: string; type: string; unique: boolean }[];
};

type Props = {
  /** Shown right after a field, by key. For example a credential picker after its auth type. */
  after?: Record<string, React.ReactNode>;
  tables?: TableHint[];
  workflows?: WorkflowHint[];
  /** The time zone a cron trigger uses when it sets none. */
  defaultTimezone?: string;
  schema: unknown;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
};

function AnyField({ value, onChange }: { value: unknown; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(() => formatAny(value));
  useEffect(() => {
    if (JSON.stringify(parseAny(text)) !== JSON.stringify(value)) setText(formatAny(value));
  }, [value, text]);
  return (
    <ExpressionInput
      multiline
      value={text}
      onChange={(next) => {
        setText(next);
        onChange(parseAny(next));
      }}
    />
  );
}

function typeOf(schema: JsonSchema): string | undefined {
  return Array.isArray(schema.type) ? schema.type[0] : schema.type;
}

/** Builds a form from the JSON Schema of a node config. The Zod schema is the only source. */
export function SchemaForm({
  schema,
  value,
  onChange,
  after,
  tables = [],
  workflows = [],
  defaultTimezone = "UTC",
}: Props) {
  const properties = (schema as JsonSchema).properties ?? {};
  // An option that the user added and left empty is not in the value yet.
  const [added, setAdded] = useState<string[]>([]);
  const set = (key: string, next: unknown) => {
    const copy = { ...value };
    if (next === undefined || next === "") delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };
  const findTable = (ref: unknown) =>
    typeof ref === "string" ? tables.find((t) => t.id === ref || t.name === ref) : undefined;
  const visible = (prop: JsonSchema) =>
    isVisible(prop, (other) => value[other] ?? properties[other]?.default);

  const field = (key: string, prop: JsonSchema, onRemove?: () => void) => {
    const current = value[key];
    const type = typeOf(prop);
    const id = `field-${key}`;
    let control: React.ReactNode;
    if (
      prop.ui === "field-collection" &&
      prop.fieldSpec &&
      (current === undefined || isRecord(current))
    ) {
      control = (
        <FieldCollectionEditor
          spec={prop.fieldSpec}
          value={current}
          root={value}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (prop.ui === "conditions" && (current === undefined || isRecord(current))) {
      control = <ConditionsEditor value={current} onChange={(next) => set(key, next)} />;
    } else if (prop.ui === "filter" && isFlatFilter(current)) {
      control = <FilterEditor value={current} onChange={(next) => set(key, next)} />;
    } else if (prop.ui === "sort" && isSortList(current)) {
      control = <SortEditor value={current} onChange={(next) => set(key, next)} />;
    } else if (prop.ui === "condition" && isComparison(current)) {
      control = <ConditionEditor value={current} onChange={(next) => set(key, next)} />;
    } else if (prop.ui === "timezone" && (current === undefined || typeof current === "string")) {
      control = (
        <TimezoneSelect
          id={id}
          value={typeof current === "string" ? current : ""}
          inheritLabel={`Workflow default (${defaultTimezone})`}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (prop.ui === "cron" && (current === undefined || typeof current === "string")) {
      const tz = value.timezone;
      control = (
        <CronField
          id={id}
          value={typeof current === "string" ? current : ""}
          timezone={(typeof tz === "string" && tz) || defaultTimezone}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (prop.ui === "textarea" && (current === undefined || typeof current === "string")) {
      control = (
        <ExpressionInput
          multiline
          id={id}
          value={typeof current === "string" ? current : ""}
          placeholder={prop.placeholder}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (prop.ui === "expression" && (current === undefined || typeof current === "string")) {
      control = (
        <ExpressionInput
          id={id}
          value={typeof current === "string" ? current : ""}
          placeholder={prop.placeholder}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "array" && prop.items?.enum && Array.isArray(current ?? [])) {
      const picked = Array.isArray(current) ? current.map(String) : [];
      const options = prop.items.enum.map(String);
      const toggle = (name: string) => {
        const next = picked.includes(name) ? picked.filter((p) => p !== name) : [...picked, name];
        set(key, next.length > 0 ? next : undefined);
      };
      control = (
        <DropdownMenu>
          <DropdownMenuTrigger
            id={id}
            className="flex min-h-9 w-full cursor-default flex-wrap items-center gap-1.5 rounded-lg border p-1.5 text-left"
          >
            {picked.map((name) => (
              <span
                key={name}
                className="flex items-center gap-1.5 rounded-md bg-secondary px-2 py-0.5"
              >
                <ItemIconView icon={prop.icons?.[name]} />
                {prop.labels?.[name] ?? name}
                <X
                  className="size-3"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggle(name);
                  }}
                />
              </span>
            ))}
            <ChevronDown className="ml-auto size-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-(--anchor-width) min-w-72">
            {options.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={picked.includes(name)}
                closeOnClick={false}
                onCheckedChange={() => toggle(name)}
              >
                <ItemIconView icon={prop.icons?.[name]} />
                <span className="flex flex-col gap-0.5 py-0.5">
                  <span className={prop.hints?.[name] ? "font-medium" : undefined}>
                    {prop.labels?.[name] ?? name}
                  </span>
                  {prop.hints?.[name] && (
                    <span className="font-normal text-muted-foreground">{prop.hints[name]}</span>
                  )}
                </span>
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      );
    } else if (prop.ui === "field-pairs" && (current === undefined || isFieldPairs(current))) {
      control = (
        <FieldPairsEditor
          value={current}
          differentNames={Boolean(value.differentNames)}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "array" && prop.items?.type === "string") {
      control = (
        <ListEditor
          value={current}
          placeholder={prop.title ?? key}
          addLabel={`Add ${prop.title ?? key}`}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (
      (prop.ui === "fields" || type === "object") &&
      (current === undefined || isRecord(current))
    ) {
      // Text values only (headers) get plain rows. Other objects get a type for each value.
      const textOnly =
        typeof prop.additionalProperties === "object" &&
        prop.additionalProperties.type === "string";
      control = (
        <FieldsEditor value={current} typed={!textOnly} onChange={(next) => set(key, next)} />
      );
    } else if (prop.enum) {
      const label = (option: unknown) => prop.labels?.[String(option)] ?? String(option);
      const read = (other: string) => value[other] ?? properties[other]?.default;
      // An option with a rule shows when the rule holds. The chosen value always shows.
      const options = prop.enum.filter((option) => {
        const rule = prop.optionRules?.[String(option)];
        return !rule || option === current || isVisible(rule, read);
      });
      control = (
        <Select
          value={String(current ?? prop.default ?? "")}
          items={options.map((option) => ({ value: String(option), label: label(option) }))}
          onValueChange={(v) => set(key, v)}
        >
          <SelectTrigger id={id}>
            <SelectValue>
              {(picked: string | null) =>
                options.some((option) => String(option) === picked) && (
                  <>
                    <ItemIconView icon={prop.icons?.[String(picked)]} />
                    {label(picked)}
                  </>
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                <ItemIconView icon={prop.icons?.[String(option)]} />
                <span className="flex flex-col gap-0.5 py-0.5">
                  <span className={prop.hints?.[String(option)] ? "font-medium" : undefined}>
                    {label(option)}
                  </span>
                  {prop.hints?.[String(option)] && (
                    <span className="font-normal text-muted-foreground">
                      {prop.hints[String(option)]}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    } else if (type === "boolean" && typeof current !== "string") {
      control = (
        // Field makes each child full width. The wrapper takes that, and the switch keeps its size.
        <div>
          <Switch
            id={id}
            checked={Boolean(current ?? prop.default ?? false)}
            onCheckedChange={(checked) => set(key, checked)}
          />
        </div>
      );
    } else if (type === "string" && prop.ui === "table") {
      control = (
        <TablePicker
          id={id}
          value={typeof current === "string" ? current : ""}
          tables={tables}
          onChange={(next) => {
            // Fill the row fields with the columns of the new table.
            const copy = { ...value, [key]: next };
            const before = findTable(value[key]);
            const after = findTable(next);
            if (after) {
              for (const [name, other] of Object.entries(properties)) {
                if (other.prefill !== "columns") continue;
                const row = prefillRow(copy[name], before?.columns ?? [], after.columns);
                if (row) copy[name] = row;
              }
            }
            onChange(copy);
          }}
        />
      );
    } else if (type === "string" && prop.ui === "table-column") {
      control = (
        <ColumnPicker
          id={id}
          value={
            typeof current === "string"
              ? current
              : typeof prop.default === "string"
                ? prop.default
                : ""
          }
          options={columnOptions(
            findTable(value.table)?.columns ?? [],
            prop.columns ?? "all",
            prop.idOption ?? false,
          )}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "string" && prop.ui === "workflow") {
      control = (
        <WorkflowPicker
          id={id}
          value={typeof current === "string" ? current : ""}
          workflows={workflows}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "string" && prop.ui === "code") {
      control = (
        <CodeEditor
          id={id}
          value={typeof current === "string" ? current : ""}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "string") {
      control = (
        <ExpressionInput
          id={id}
          placeholder={prop.placeholder}
          value={typeof current === "string" ? current : ""}
          onChange={(next) => set(key, next)}
        />
      );
    } else if (type === "number" || type === "integer") {
      control = (
        <Input
          id={id}
          value={current === undefined ? "" : String(current)}
          placeholder={prop.default === undefined ? undefined : String(prop.default)}
          onChange={(event) => {
            const raw = event.target.value;
            set(key, raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
          }}
        />
      );
    } else {
      control = <AnyField value={current} onChange={(next) => set(key, next)} />;
    }
    return (
      <Field key={key}>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor={id}>{prop.title ?? key}</FieldLabel>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove ${prop.title ?? key}`}
              onClick={onRemove}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        {control}
        {prop.description && (
          <span className="text-muted-foreground text-xs">{prop.description}</span>
        )}
      </Field>
    );
  };

  const entries = Object.entries(properties).filter(
    ([, prop]) => prop.ui !== "hidden" && visible(prop),
  );
  const main = entries.filter(([, prop]) => !prop.option);
  const optionEntries = entries.filter(([, prop]) => prop.option);
  const isActive = ([key]: [string, JsonSchema]) => value[key] !== undefined || added.includes(key);
  const active = optionEntries.filter(isActive);
  const available = optionEntries.filter((entry) => !isActive(entry));

  return (
    <div className="flex flex-col gap-5">
      {main.map(([key, prop]) => (
        <Fragment key={key}>
          {field(key, prop)}
          {after?.[key]}
        </Fragment>
      ))}
      {optionEntries.length > 0 && (
        <div className="flex flex-col gap-5 border-t pt-5">
          <span className="font-medium">Options</span>
          {active.map(([key, prop]) =>
            field(key, prop, () => {
              setAdded((keys) => keys.filter((k) => k !== key));
              set(key, undefined);
            }),
          )}
          {available.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" className="w-fit" />}>
                <Plus className="size-4" />
                Add option
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {available.map(([key, prop]) => (
                  <DropdownMenuItem
                    key={key}
                    onClick={() => {
                      setAdded((keys) => [...keys, key]);
                      // A switch or a number starts with a value. A text starts empty.
                      const type = typeOf(prop);
                      if (type === "boolean") set(key, true);
                    }}
                  >
                    {prop.title ?? key}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}
