// SPDX-License-Identifier: AGPL-3.0-only

import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FieldSpec, isVisible } from "@zerodot/engine";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@zerodot/ui";
import { useState } from "react";
import { ExpressionInput } from "./expression-input";
import { ItemIconView } from "./node-icon";

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a condition reads its keys: the values next to the field, and the top of the config. */
type Scope = { siblings: Obj; root: Obj };

const visible = (spec: FieldSpec, scope: Scope) =>
  isVisible({ showWhen: spec.show, hideWhen: spec.hide }, (key) =>
    key === "nodeVersion" || key.startsWith("/")
      ? scope.root[key === "nodeVersion" ? key : key.slice(1)]
      : (scope.siblings[key] ?? defaultOf(key, scope)),
  );

/** A hidden rule can read a sibling that the user did not set. The default applies then. */
function defaultOf(_key: string, _scope: Scope): unknown {
  return undefined;
}

const initial = (spec: FieldSpec): unknown => {
  if (spec.default !== undefined && typeof spec.default !== "object") return spec.default;
  if (spec.kind === "boolean") return false;
  return undefined;
};

/** The value of a field, or its default, so a rule that reads it sees what the form shows. */
const withDefaults = (fields: FieldSpec[], value: Obj): Obj => {
  const result: Obj = {};
  for (const field of fields) {
    const own = value[field.name];
    const fallback = initial(field);
    if (own !== undefined) result[field.name] = own;
    else if (fallback !== undefined) result[field.name] = fallback;
  }
  return result;
};

function Leaf({
  spec,
  value,
  onChange,
  scope,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (next: unknown) => void;
  scope: Scope;
}) {
  const label = <span className="font-medium">{spec.label}</span>;
  const hint = spec.description && (
    <span className="text-muted-foreground text-xs">{spec.description}</span>
  );
  switch (spec.kind) {
    case "boolean":
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Switch
              aria-label={spec.label}
              checked={Boolean(value ?? spec.default ?? false)}
              onCheckedChange={onChange}
            />
            {label}
          </div>
          {hint}
        </div>
      );
    case "options": {
      const options = spec.options ?? [];
      const current = value ?? spec.default;
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <Select
            value={String(current ?? "")}
            items={options.map((o) => ({ value: String(o.value), label: o.label }))}
            onValueChange={(next) =>
              onChange(options.find((o) => String(o.value) === next)?.value ?? next)
            }
          >
            <SelectTrigger>
              <SelectValue>
                {(picked: string | null) => {
                  const o = options.find((x) => String(x.value) === picked);
                  return (
                    <>
                      <ItemIconView icon={o} />
                      {o?.label ?? picked}
                    </>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {options.map((o) => (
                <SelectItem key={String(o.value)} value={String(o.value)}>
                  <ItemIconView icon={o} />
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hint}
        </div>
      );
    }
    case "number":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <Input
            value={value === undefined ? "" : String(value)}
            placeholder={spec.default === undefined ? undefined : String(spec.default)}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
            }}
          />
          {hint}
        </div>
      );
    case "filter":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <ConditionsEditor value={value} onChange={onChange} />
          {hint}
        </div>
      );
    case "collection":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <FieldCollectionEditor spec={spec} value={value} onChange={onChange} root={scope.root} />
          {hint}
        </div>
      );
    case "fixed":
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <FieldCollectionEditor spec={spec} value={value} onChange={onChange} root={scope.root} />
          {hint}
        </div>
      );
    default:
      return (
        <div className="flex flex-col gap-1.5">
          {label}
          <ExpressionInput
            multiline={spec.multiline}
            placeholder={spec.placeholder}
            value={typeof value === "string" ? value : value === undefined ? "" : String(value)}
            onChange={(next) => onChange(next === "" ? undefined : next)}
          />
          {hint}
        </div>
      );
  }
}

/** The fields of one object. A field that a rule hides is not drawn. */
function Fields({
  fields,
  value,
  onChange,
  root,
}: {
  fields: FieldSpec[];
  value: Obj;
  onChange: (next: Obj) => void;
  root: Obj;
}) {
  const scope: Scope = { siblings: withDefaults(fields, value), root };
  return (
    <div className="flex flex-col gap-4">
      {fields
        .filter((spec) => visible(spec, scope))
        .map((spec) => (
          <Leaf
            key={spec.name}
            spec={spec}
            scope={scope}
            value={value[spec.name]}
            onChange={(next) => {
              const copy = { ...value };
              if (next === undefined || next === "") delete copy[spec.name];
              else copy[spec.name] = next;
              onChange(copy);
            }}
          />
        ))}
    </div>
  );
}

/** A collection (add the fields you need) or a fixed collection (cards, add more of them). */
export function FieldCollectionEditor({
  spec,
  value,
  onChange,
  root,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (next: Obj | undefined) => void;
  root: Obj;
}) {
  const current: Obj = isObj(value) ? value : {};
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const commit = (next: Obj) => onChange(Object.keys(next).length > 0 ? next : undefined);

  if (spec.kind === "collection") {
    const fields = spec.fields ?? [];
    const scope: Scope = { siblings: current, root };
    const shown = fields.filter((f) => visible(f, scope));
    const active = shown.filter((f) => current[f.name] !== undefined);
    const available = shown.filter((f) => current[f.name] === undefined);
    return (
      <div className="flex flex-col gap-3">
        {active.map((f) => (
          <div key={f.name} className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <Leaf
                spec={f}
                scope={scope}
                value={current[f.name]}
                onChange={(next) => {
                  const copy = { ...current };
                  if (next === undefined || next === "") copy[f.name] = initial(f) ?? "";
                  else copy[f.name] = next;
                  commit(copy);
                }}
              />
            </div>
            <button
              type="button"
              aria-label={`Remove ${f.label}`}
              onClick={() => {
                const copy = { ...current };
                delete copy[f.name];
                commit(copy);
              }}
              className="mt-0.5 text-muted-foreground transition-colors hover:text-foreground"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
            </button>
          </div>
        ))}
        {available.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="outline" className="w-fit" />}>
              <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
              Add option
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {available.map((f) => (
                <DropdownMenuItem
                  key={f.name}
                  onClick={() =>
                    commit({
                      ...current,
                      [f.name]: initial(f) ?? (f.kind === "string" ? "" : false),
                    })
                  }
                >
                  {f.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  const groups = spec.groups ?? [];
  const listOf = (name: string): Obj[] => {
    const own = current[name];
    return Array.isArray(own) ? own.filter(isObj) : isObj(own) ? [own] : [];
  };
  const write = (name: string, items: Obj[]) => {
    const copy = { ...current };
    if (items.length === 0) delete copy[name];
    else copy[name] = spec.multiple ? items : items[0];
    commit(copy);
  };
  const addable = groups.filter((g) => spec.multiple || listOf(g.name).length === 0);
  const blank = (fields: FieldSpec[]): Obj => {
    const item: Obj = {};
    for (const f of fields) {
      const start = initial(f);
      if (start !== undefined) item[f.name] = start;
    }
    return item;
  };
  const add = (name: string, fields: FieldSpec[]) => write(name, [...listOf(name), blank(fields)]);

  return (
    <div className="flex flex-col gap-3">
      {groups.flatMap((g) =>
        listOf(g.name).map((item, index) => {
          const id = `${g.name}.${index}`;
          const collapsed = open[id] === false;
          return (
            <div key={id} className="rounded-lg border">
              <div className="flex items-center gap-1 px-3 py-2">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => setOpen((o) => ({ ...o, [id]: collapsed }))}
                  className="flex flex-1 items-center gap-1.5 text-left font-medium"
                >
                  {collapsed ? (
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      className="size-4 text-muted-foreground"
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={ArrowDown01Icon}
                      className="size-4 text-muted-foreground"
                    />
                  )}
                  {spec.multiple ? `${g.label} ${index + 1}` : g.label}
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${g.label}`}
                  onClick={() =>
                    write(
                      g.name,
                      listOf(g.name).filter((_, i) => i !== index),
                    )
                  }
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
                </button>
              </div>
              {!collapsed && (
                <div className="px-3 pb-3">
                  <Fields
                    fields={g.fields}
                    root={root}
                    value={item}
                    onChange={(next) =>
                      write(
                        g.name,
                        listOf(g.name).map((old, i) => (i === index ? next : old)),
                      )
                    }
                  />
                </div>
              )}
            </div>
          );
        }),
      )}
      {addable.length === 1 && addable[0] && (
        <Button
          variant="outline"
          className="w-fit"
          onClick={() => add(addable[0]?.name ?? "", addable[0]?.fields ?? [])}
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          Add {addable[0].label}
        </Button>
      )}
      {addable.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" className="w-fit" />}>
            <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
            Add {spec.label}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map((g) => (
              <DropdownMenuItem key={g.name} onClick={() => add(g.name, g.fields)}>
                {g.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

// ---- Filter (the conditions of If, Switch, Filter) ----

type Operator = { type: string; operation: string; singleValue?: boolean };
type Condition = { id?: string; leftValue?: unknown; rightValue?: unknown; operator: Operator };
type FilterValue = { options?: Obj; conditions?: Condition[]; combinator?: "and" | "or" };

const SINGLE = new Set(["exists", "notExists", "empty", "notEmpty", "true", "false"]);

const OPERATIONS: Record<string, [string, string][]> = {
  string: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["empty", "is empty"],
    ["notEmpty", "is not empty"],
    ["equals", "is equal to"],
    ["notEquals", "is not equal to"],
    ["contains", "contains"],
    ["notContains", "does not contain"],
    ["startsWith", "starts with"],
    ["notStartsWith", "does not start with"],
    ["endsWith", "ends with"],
    ["notEndsWith", "does not end with"],
    ["regex", "matches regex"],
    ["notRegex", "does not match regex"],
  ],
  number: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["equals", "is equal to"],
    ["notEquals", "is not equal to"],
    ["gt", "is greater than"],
    ["lt", "is less than"],
    ["gte", "is greater than or equal to"],
    ["lte", "is less than or equal to"],
  ],
  dateTime: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["equals", "is equal to"],
    ["notEquals", "is not equal to"],
    ["after", "is after"],
    ["before", "is before"],
    ["afterOrEquals", "is after or equal to"],
    ["beforeOrEquals", "is before or equal to"],
  ],
  boolean: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["true", "is true"],
    ["false", "is false"],
    ["equals", "is equal to"],
    ["notEquals", "is not equal to"],
  ],
  array: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["contains", "contains"],
    ["notContains", "does not contain"],
    ["lengthEquals", "length equal to"],
    ["lengthNotEquals", "length not equal to"],
    ["lengthGt", "length greater than"],
    ["lengthLt", "length less than"],
    ["lengthGte", "length greater than or equal to"],
    ["lengthLte", "length less than or equal to"],
    ["empty", "is empty"],
    ["notEmpty", "is not empty"],
  ],
  object: [
    ["exists", "exists"],
    ["notExists", "does not exist"],
    ["empty", "is empty"],
    ["notEmpty", "is not empty"],
  ],
};

const TYPE_LABEL: Record<string, string> = {
  string: "String",
  number: "Number",
  dateTime: "Date & Time",
  boolean: "Boolean",
  array: "Array",
  object: "Object",
};

const operatorLabel = (op: Operator) =>
  `${TYPE_LABEL[op.type] ?? op.type}: ${OPERATIONS[op.type]?.find(([k]) => k === op.operation)?.[1] ?? op.operation}`;

const blankCondition = (): Condition => ({
  id: crypto.randomUUID(),
  leftValue: "",
  rightValue: "",
  operator: { type: "string", operation: "equals" },
});

/** The conditions of a filter: a value, an operator, a second value, joined by AND or OR. */
export function ConditionsEditor({
  value,
  onChange,
}: {
  value: unknown;
  onChange: (next: FilterValue) => void;
}) {
  const filter: FilterValue = isObj(value) ? (value as FilterValue) : {};
  const conditions = Array.isArray(filter.conditions) ? filter.conditions : [];
  const commit = (next: Partial<FilterValue>) => onChange({ ...filter, ...next });
  const setAt = (index: number, change: Partial<Condition>) =>
    commit({ conditions: conditions.map((c, i) => (i === index ? { ...c, ...change } : c)) });
  const text = (v: unknown) => (typeof v === "string" ? v : v === undefined ? "" : String(v));

  return (
    <div className="flex flex-col gap-2">
      {conditions.map((condition, index) => (
        <div key={condition.id ?? index} className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col divide-y rounded-lg border">
            <ExpressionInput
              placeholder="value1"
              className="rounded-none border-0 shadow-none"
              value={text(condition.leftValue)}
              onChange={(next) => setAt(index, { leftValue: next })}
            />
            <Select
              value={`${condition.operator.type}:${condition.operator.operation}`}
              items={Object.entries(OPERATIONS).flatMap(([type, ops]) =>
                ops.map(([operation]) => ({
                  value: `${type}:${operation}`,
                  label: operatorLabel({ type, operation }),
                })),
              )}
              onValueChange={(next) => {
                const [type = "string", operation = "equals"] = (next ?? "").split(":");
                setAt(index, {
                  operator: {
                    type,
                    operation,
                    ...(SINGLE.has(operation) ? { singleValue: true } : {}),
                  },
                });
              }}
            >
              <SelectTrigger className="rounded-none border-0 bg-muted/40 shadow-none">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(OPERATIONS).map(([type, ops]) => (
                  <SelectGroup key={type}>
                    <SelectLabel>{TYPE_LABEL[type]}</SelectLabel>
                    {ops.map(([operation, label]) => (
                      <SelectItem key={operation} value={`${type}:${operation}`}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
            {!SINGLE.has(condition.operator.operation) && (
              <ExpressionInput
                placeholder="value2"
                className="rounded-none border-0 shadow-none"
                value={text(condition.rightValue)}
                onChange={(next) => setAt(index, { rightValue: next })}
              />
            )}
          </div>
          <button
            type="button"
            aria-label="Remove condition"
            onClick={() => commit({ conditions: conditions.filter((_, i) => i !== index) })}
            className="mt-2 text-muted-foreground transition-colors hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} className="size-4" />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          className="w-fit"
          onClick={() =>
            commit({
              conditions: [...conditions, blankCondition()],
              combinator: filter.combinator ?? "and",
            })
          }
        >
          <HugeiconsIcon icon={PlusSignIcon} className="size-4" />
          Add condition
        </Button>
        {conditions.length > 1 && (
          <Select
            value={filter.combinator ?? "and"}
            items={[
              { value: "and", label: "AND" },
              { value: "or", label: "OR" },
            ]}
            onValueChange={(next) => commit({ combinator: next === "or" ? "or" : "and" })}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">AND</SelectItem>
              <SelectItem value="or">OR</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
