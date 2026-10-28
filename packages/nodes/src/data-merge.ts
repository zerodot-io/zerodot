// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { getPath, isRecord, toList } from "./list-common";

const MODES = [
  "append",
  "combineByPosition",
  "combineByField",
  "combineAll",
  "chooseBranch",
] as const;

export const MIN_INPUTS = 2;
export const MAX_INPUTS = 10;

/** The number of inputs of a config. A missing or bad value gives 2. */
export function inputCount(config: Record<string, unknown>): number {
  const n = Number(config.numberInputs);
  if (!Number.isFinite(n)) return MIN_INPUTS;
  return Math.min(MAX_INPUTS, Math.max(MIN_INPUTS, Math.trunc(n)));
}

/** `input1` to `inputN`. */
export function inputPorts(config: Record<string, unknown>): string[] {
  return Array.from({ length: inputCount(config) }, (_, i) => `input${i + 1}`);
}

const OUTPUT_CHOICES = [
  ...Array.from({ length: MAX_INPUTS }, (_, i) => `input${i + 1}`),
  "empty",
] as const;

/** A choice for input 3 and up shows only when the node has that many inputs. */
const outputRules = Object.fromEntries(
  Array.from({ length: MAX_INPUTS - MIN_INPUTS }, (_, i) => [
    `input${i + MIN_INPUTS + 1}`,
    { showWhen: { numberInputs: [{ _cnd: { gte: i + MIN_INPUTS + 1 } }] } },
  ]),
);

const outputLabels = {
  ...Object.fromEntries(
    Array.from({ length: MAX_INPUTS }, (_, i) => [`input${i + 1}`, `Input ${i + 1}`]),
  ),
  empty: "Empty Data",
};
const outputHints = {
  ...Object.fromEntries(
    Array.from({ length: MAX_INPUTS }, (_, i) => [
      `input${i + 1}`,
      `Pass on the items of input ${i + 1}`,
    ]),
  ),
  empty: "Pass on an empty list, whatever the inputs hold",
};

const JOINS = [
  "keepMatches",
  "keepNonMatches",
  "enrichInput1",
  "enrichInput2",
  "keepEverything",
  // The old name of "enrichInput1". Existing workflows keep it.
  "keepAll",
] as const;

type Clash = "preferInput1" | "preferInput2" | "suffix";
type MergeOptions = { clash: Clash; deep: boolean; suffix1: string; suffix2: string };

function put(target: Record<string, unknown>, key: string, value: unknown) {
  // `Object.defineProperty` keeps a key like "__proto__" a plain key.
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const has = (record: Record<string, unknown>, key: string) => Object.hasOwn(record, key);

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function deepMerge(a: unknown, b: unknown, preferFirst: boolean): unknown {
  if (isRecord(a) && isRecord(b)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(a)) put(out, key, a[key]);
    for (const key of Object.keys(b)) {
      put(out, key, has(a, key) ? deepMerge(a[key], b[key], preferFirst) : b[key]);
    }
    return out;
  }
  if (a === undefined) return b;
  if (b === undefined) return a;
  return preferFirst ? a : b;
}

/**
 * Merges two items. Two objects merge key by key, and a key in both is a clash that the options
 * settle. Anything else: the second value wins, and the first stands in when the second is
 * missing. `shared` names top level keys that are not a clash (the keys that were matched).
 */
function mergeItems(a: unknown, b: unknown, options: MergeOptions, shared: Set<string>): unknown {
  if (!isRecord(a) || !isRecord(b)) {
    return options.clash === "preferInput1" ? (a ?? b) : (b ?? a);
  }
  const out: Record<string, unknown> = {};
  if (options.clash === "suffix") {
    // A suffix is for the top level. Nested objects are not merged here.
    for (const key of Object.keys(a)) {
      const clash = has(b, key) && !shared.has(key) && !same(a[key], b[key]);
      put(out, clash ? `${key}${options.suffix1}` : key, a[key]);
    }
    for (const key of Object.keys(b)) {
      if (!has(a, key)) put(out, key, b[key]);
      else if (!shared.has(key) && !same(a[key], b[key]))
        put(out, `${key}${options.suffix2}`, b[key]);
    }
    return out;
  }
  const preferFirst = options.clash === "preferInput1";
  for (const key of Object.keys(a)) put(out, key, a[key]);
  for (const key of Object.keys(b)) {
    if (!has(a, key)) put(out, key, b[key]);
    else if (options.deep) put(out, key, deepMerge(a[key], b[key], preferFirst));
    else if (!preferFirst) put(out, key, b[key]);
  }
  return out;
}

type FieldPair = { field1: string; field2: string };

/** The field pairs to match on. An old config has `field1` and `field2` and no list. */
function fieldPairs(config: {
  matchFields?: { field1: string; field2?: string }[];
  differentNames: boolean;
  field1?: string;
  field2?: string;
}): FieldPair[] {
  if (config.matchFields === undefined || config.matchFields.length === 0) {
    return [{ field1: config.field1 ?? "id", field2: config.field2 ?? "id" }];
  }
  return config.matchFields.map((pair) => ({
    field1: pair.field1,
    field2: config.differentNames ? (pair.field2 ?? pair.field1) : pair.field1,
  }));
}

function readField(item: unknown, path: string, dotNotation: boolean): unknown {
  if (path === "") return undefined;
  if (dotNotation) return getPath(item, path);
  return isRecord(item) && has(item, path) ? item[path] : undefined;
}

function part(value: unknown, fuzzy: boolean): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (fuzzy && ["string", "number", "boolean", "bigint"].includes(typeof value)) {
    return `p:${String(value)}`;
  }
  return `${typeof value}:${typeof value === "object" ? JSON.stringify(value) : String(value)}`;
}

/** One text for the values of all fields. Undefined when a value is missing: it matches nothing. */
function matchKey(
  item: unknown,
  paths: string[],
  dotNotation: boolean,
  fuzzy: boolean,
): string | undefined {
  const parts: string[] = [];
  for (const path of paths) {
    const key = part(readField(item, path, dotNotation), fuzzy);
    if (key === undefined) return undefined;
    parts.push(key);
  }
  return JSON.stringify(parts);
}

type Config = {
  mode: (typeof MODES)[number];
  numberInputs: number;
  matchFields?: { field1: string; field2?: string }[];
  differentNames: boolean;
  field1?: string;
  field2?: string;
  join: (typeof JOINS)[number];
  multipleMatches: "all" | "first";
  includeUnpaired: boolean;
  clash: Clash;
  suffix1: string;
  suffix2: string;
  nested: "shallow" | "deep";
  disableDotNotation: boolean;
  fuzzyCompare: boolean;
  output: (typeof OUTPUT_CHOICES)[number];
};

function combineByField(one: unknown[], two: unknown[], config: Config): unknown[] {
  const pairs = fieldPairs(config);
  const dot = !config.disableDotNotation;
  const keys1 = pairs.map((p) => p.field1);
  const keys2 = pairs.map((p) => p.field2);
  const options: MergeOptions = {
    clash: config.clash,
    deep: config.nested === "deep",
    suffix1: config.suffix1,
    suffix2: config.suffix2,
  };
  // A key that was matched and has the same name in both inputs is not a clash.
  const shared = new Set(
    pairs.filter((p) => p.field1 === p.field2 && !p.field1.includes(".")).map((p) => p.field1),
  );
  const merge = (a: unknown, b: unknown) => mergeItems(a, b, options, shared);

  const index = (items: unknown[], paths: string[]) => {
    const map = new Map<string, number[]>();
    items.forEach((item, i) => {
      const key = matchKey(item, paths, dot, config.fuzzyCompare);
      if (key === undefined) return;
      map.set(key, [...(map.get(key) ?? []), i]);
    });
    return map;
  };
  const by2 = index(two, keys2);
  const by1 = index(one, keys1);
  const pick = (found: number[] | undefined) =>
    found === undefined ? [] : config.multipleMatches === "first" ? found.slice(0, 1) : found;
  const matchesOf1 = (item: unknown) => {
    const key = matchKey(item, keys1, dot, config.fuzzyCompare);
    return key === undefined ? [] : pick(by2.get(key));
  };

  const join = config.join === "keepAll" ? "enrichInput1" : config.join;
  if (join === "enrichInput2") {
    return two.flatMap((item2) => {
      const key = matchKey(item2, keys2, dot, config.fuzzyCompare);
      const found = key === undefined ? [] : pick(by1.get(key));
      return found.length === 0 ? [item2] : found.map((i) => merge(one[i], item2));
    });
  }

  const used2 = new Set<number>();
  const out: unknown[] = [];
  const unpaired1: unknown[] = [];
  for (const item1 of one) {
    const found = matchesOf1(item1);
    if (found.length === 0) {
      unpaired1.push(item1);
      if (join === "enrichInput1" || join === "keepEverything") out.push(item1);
      continue;
    }
    for (const j of found) {
      used2.add(j);
      if (join !== "keepNonMatches") out.push(merge(item1, two[j]));
    }
  }
  const unpaired2 = two.filter((_, j) => !used2.has(j));
  if (join === "keepNonMatches") return [...unpaired1, ...unpaired2];
  if (join === "keepEverything") return [...out, ...unpaired2];
  return out;
}

export default defineNode({
  type: "data.merge",
  label: "Merge",
  description: "Merge data of multiple streams once data from all inputs is available",
  category: "data",
  actions: [
    { label: "Append the items of the inputs", config: { mode: "append" } },
    { label: "Combine items by position", config: { mode: "combineByPosition" } },
    { label: "Combine items by field", config: { mode: "combineByField" } },
    { label: "Combine every item with every item", config: { mode: "combineAll" } },
    { label: "Choose a branch", config: { mode: "chooseBranch" } },
  ],
  icon: "Merge",
  config: z.object({
    mode: z
      .enum(MODES)
      .default("append")
      .meta({
        title: "Mode",
        labels: {
          append: "Append",
          combineByPosition: "Combine by Position",
          combineByField: "Combine by Field",
          combineAll: "Combine All",
          chooseBranch: "Choose Branch",
        },
        hints: {
          append: "Put the items of all inputs, in order, in one list",
          combineByPosition: "Join the items that have the same position in each input",
          combineByField: "Join the items that have the same value in a field (inputs 1 and 2)",
          combineAll: "Join every item of input 1 with every item of input 2 (and of the others)",
          chooseBranch: "Pass on the items of one input only, or nothing",
        },
      }),
    numberInputs: z.number().int().min(MIN_INPUTS).max(MAX_INPUTS).default(MIN_INPUTS).meta({
      title: "Number of Inputs",
      description:
        "From 2 to 10. Lowering it removes the edges that go into the inputs that are gone.",
    }),
    // combineByField: the field of each input to match on. All pairs must match.
    matchFields: z
      .array(z.object({ field1: z.string(), field2: z.string().optional() }))
      .optional()
      .meta({
        title: "Fields to Match",
        description: "All pairs must match. With no pair, the field id is used",
        ui: "field-pairs",
        showWhen: { mode: ["combineByField"] },
      }),
    differentNames: z
      .boolean()
      .default(false)
      .meta({
        title: "Fields Have Different Names",
        description: "Off: the name of input 1 is used for input 2 too",
        showWhen: { mode: ["combineByField"] },
      }),
    // The old config of combineByField: one pair, always with two names. Used when matchFields is not set.
    field1: z.string().optional().meta({ ui: "hidden" }),
    field2: z.string().optional().meta({ ui: "hidden" }),
    join: z
      .enum(JOINS)
      .default("keepMatches")
      .meta({
        title: "Include Unpaired Items",
        showWhen: { mode: ["combineByField"] },
        labels: {
          keepMatches: "Keep Matches Only",
          keepNonMatches: "Keep Non-Matches Only",
          enrichInput1: "Enrich Input 1",
          enrichInput2: "Enrich Input 2",
          keepEverything: "Keep Everything",
          keepAll: "Enrich Input 1 (old name)",
        },
        hints: {
          keepMatches: "Only the items that have a match in both inputs",
          keepNonMatches: "Only the items that have no match, from both inputs",
          enrichInput1: "All items of input 1, with the data of their match from input 2",
          enrichInput2: "All items of input 2, with the data of their match from input 1",
          keepEverything: "The matches, and the items without a match from both inputs",
          keepAll: "The same as Enrich Input 1. Kept so older workflows work",
        },
      }),
    multipleMatches: z
      .enum(["all", "first"])
      .default("all")
      .meta({
        title: "Multiple Matches",
        option: true,
        showWhen: { mode: ["combineByField"] },
        labels: { all: "Include All Matches", first: "Include First Match Only" },
        hints: {
          all: "An item with several matches makes one output item for each match",
          first: "An item with several matches makes one output item, with the first match",
        },
      }),
    disableDotNotation: z
      .boolean()
      .default(false)
      .meta({
        title: "Disable Dot Notation",
        option: true,
        description: 'Off: "a.b" reads the key b inside the key a. On: it is the key "a.b"',
        showWhen: { mode: ["combineByField"] },
      }),
    fuzzyCompare: z
      .boolean()
      .default(false)
      .meta({
        title: "Fuzzy Compare",
        option: true,
        description: 'On: the number 1 and the text "1" are the same value',
        showWhen: { mode: ["combineByField"] },
      }),
    // combineByPosition: "off" drops the items that have no item at their position in every input.
    includeUnpaired: z
      .boolean()
      .default(true)
      .meta({
        title: "Include Unpaired Items",
        option: true,
        description: "Off: only the positions that every input has",
        showWhen: { mode: ["combineByPosition"] },
      }),
    clash: z
      .enum(["preferInput2", "preferInput1", "suffix"])
      .default("preferInput2")
      .meta({
        title: "When Field Values Clash",
        option: true,
        showWhen: { mode: ["combineByPosition", "combineByField", "combineAll"] },
        labels: {
          preferInput2: "Use Input 2 Version",
          preferInput1: "Use Input 1 Version",
          suffix: "Add Input Number to Field Name",
        },
        hints: {
          preferInput2: "A later input wins when two items have the same key",
          preferInput1: "An earlier input wins when two items have the same key",
          suffix: "Keep both values, under the key plus a suffix",
        },
      }),
    suffix1: z
      .string()
      .default("_1")
      .meta({
        title: "Suffix for Input 1",
        option: true,
        showWhen: {
          mode: ["combineByPosition", "combineByField", "combineAll"],
          clash: ["suffix"],
        },
      }),
    suffix2: z
      .string()
      .default("_2")
      .meta({
        title: "Suffix for Input 2",
        option: true,
        showWhen: {
          mode: ["combineByPosition", "combineByField", "combineAll"],
          clash: ["suffix"],
        },
      }),
    nested: z
      .enum(["shallow", "deep"])
      .default("shallow")
      .meta({
        title: "Merge Nested Objects",
        option: true,
        showWhen: {
          mode: ["combineByPosition", "combineByField", "combineAll"],
          clash: ["preferInput1", "preferInput2"],
        },
        labels: { shallow: "Shallow", deep: "Deep" },
        hints: {
          shallow: "A nested object of one item replaces the one of the other",
          deep: "Nested objects merge key by key. Lists are not merged",
        },
      }),
    // chooseBranch: the input to pass on.
    output: z
      .enum(OUTPUT_CHOICES)
      .default("input1")
      .meta({
        title: "Output",
        showWhen: { mode: ["chooseBranch"] },
        labels: outputLabels,
        hints: outputHints,
        optionRules: outputRules,
      }),
  }),
  defaultConfig: {
    mode: "append",
    numberInputs: 2,
    matchFields: [{ field1: "id", field2: "id" }],
    join: "keepMatches",
    output: "input1",
  },
  join: true,
  ports: { in: ["input1", "input2"], out: ["out"] },
  inPorts: inputPorts,
  subtitle: (config) => (typeof config.mode === "string" ? config.mode : undefined),
  run: ({ config, input }) => {
    const inputs = isRecord(input) ? input : {};
    const ports = inputPorts(config);
    // An input with no data (no edge, or a skipped branch) is left out.
    const lists = ports.filter((port) => inputs[port] !== undefined).map((p) => toList(inputs[p]));
    const options: MergeOptions = {
      clash: config.clash,
      deep: config.nested === "deep",
      suffix1: config.suffix1,
      suffix2: config.suffix2,
    };
    const merge = (a: unknown, b: unknown) => mergeItems(a, b, options, new Set());
    let data: unknown;
    switch (config.mode) {
      case "append":
        data = lists.flat();
        break;
      case "combineByPosition": {
        if (lists.length === 0) {
          data = [];
          break;
        }
        const sizes = lists.map((list) => list.length);
        const length = config.includeUnpaired ? Math.max(...sizes) : Math.min(...sizes);
        data = Array.from({ length }, (_, i) =>
          lists
            .filter((list) => i < list.length)
            .map((list) => list[i])
            .reduce((acc, item) => merge(acc, item)),
        );
        break;
      }
      case "combineByField":
        data = combineByField(
          toList(inputs.input1),
          toList(inputs.input2),
          config as unknown as Config,
        );
        break;
      case "combineAll":
        data = lists.reduce<unknown[]>(
          (acc, list, i) => (i === 0 ? list : acc.flatMap((a) => list.map((b) => merge(a, b)))),
          [],
        );
        break;
      case "chooseBranch":
        data = config.output === "empty" ? [] : (inputs[config.output] ?? null);
        break;
    }
    return { port: "out", data };
  },
});
