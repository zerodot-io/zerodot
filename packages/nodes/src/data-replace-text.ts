// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { getPath, isRecord } from "./list-common";

const FLAGS = /^[imsu]*$/;

function setPath(
  item: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return item;
  if (rest.length === 0) return { ...item, [head]: value };
  const child = item[head];
  return { ...item, [head]: setPath(isRecord(child) ? child : {}, rest.join("."), value) };
}

/** Builds the matcher. A text search is escaped, so it never acts as a pattern. */
function matcher(config: { search: string; regex: boolean; flags: string; replaceAll: boolean }) {
  const source = config.regex
    ? config.search
    : config.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const flags = [...new Set(config.flags)].join("") + (config.replaceAll ? "g" : "");
  return new RegExp(source, flags);
}

export default defineNode({
  type: "data.replaceText",
  label: "Replace Text",
  description: "Find and replace text in a field",
  category: "data",
  icon: "ArrowDataTransferHorizontalIcon",
  config: z
    .object({
      // Path of the text field, for example "user.name". Empty means the input is the text.
      field: z.string().default("").meta({ title: "Field", hint: "Empty: the input is the text" }),
      search: z.string().min(1, "Search text is required").default(""),
      regex: z.boolean().default(false).meta({ title: "Search is a regular expression" }),
      flags: z
        .string()
        .regex(FLAGS, "Flags can be i, m, s, and u")
        .default("")
        .meta({ title: "Regex flags", hint: "i, m, s, u. Used only with a regular expression" }),
      // With a regular expression, $1 and $& work in the replacement.
      replacement: z.string().default(""),
      replaceAll: z.boolean().default(true).meta({ title: "Replace all matches" }),
      // Where the result goes. Empty writes it back to `field`.
      outputField: z
        .string()
        .default("")
        .meta({ title: "Output field", hint: "Empty: replace the value in Field" }),
    })
    .superRefine((config, ctx) => {
      if (!config.regex) return;
      try {
        new RegExp(config.search, config.flags);
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          path: ["search"],
          message: error instanceof Error ? error.message : "Invalid regular expression",
        });
      }
    }),
  defaultConfig: {
    field: "",
    search: "",
    regex: false,
    flags: "",
    replacement: "",
    replaceAll: true,
    outputField: "",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (typeof config.search === "string" ? config.search : ""),
  run: ({ config, input }) => {
    const pattern = matcher(config);
    const target = config.outputField || config.field;
    const apply = (item: unknown): unknown => {
      const value = config.field === "" ? item : getPath(item, config.field);
      if (typeof value !== "string") {
        if (value === undefined || value === null) return item;
        throw new Error(`"${config.field || "input"}" is not text`);
      }
      // A function replacement keeps "$" in a text replacement from acting as a pattern.
      const text = config.regex
        ? value.replace(pattern, config.replacement)
        : value.replace(pattern, () => config.replacement);
      if (target === "") return text;
      return isRecord(item) ? setPath(item, target, text) : item;
    };
    return { port: "out", data: Array.isArray(input) ? input.map(apply) : apply(input) };
  },
});
