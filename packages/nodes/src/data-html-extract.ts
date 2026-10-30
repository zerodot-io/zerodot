// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { parse } from "node-html-parser";
import { z } from "zod";

function htmlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "data" in value) {
    const data = (value as { data: unknown }).data;
    if (typeof data === "string") return data;
  }
  throw new Error("The HTML input must be text");
}

type Element = ReturnType<typeof parse>;

function read(
  element: Element,
  returnValue: "text" | "html" | "attribute" | "value",
  attribute: string,
): string | undefined {
  if (returnValue === "html") return element.innerHTML.trim();
  if (returnValue === "attribute") return element.getAttribute(attribute);
  if (returnValue === "value") return element.getAttribute("value");
  return element.text.trim();
}

export default defineNode({
  type: "data.html_extract",
  label: "HTML Extract",
  description: "Get data from HTML with CSS selectors",
  category: "data",
  icon: "FileSearchIcon",
  config: z.object({
    html: z.unknown().default("{{ $input.data }}").meta({ title: "HTML", ui: "expression" }),
    selectors: z.record(z.string(), z.string()).default({}).meta({
      title: "Selectors",
      description: "Output key and CSS selector, for example title and h1",
    }),
    returnValue: z
      .enum(["text", "html", "attribute", "value"])
      .default("text")
      .meta({
        title: "Return Value",
        labels: { text: "Text", html: "HTML", attribute: "Attribute", value: "Value" },
        hints: {
          text: "The text inside the element",
          html: "The HTML inside the element",
          attribute: "The value of one attribute, for example href",
          value: "The value attribute of an input",
        },
      }),
    attribute: z
      .string()
      .default("href")
      .meta({ title: "Attribute", showWhen: { returnValue: ["attribute"] } }),
    returnArray: z.boolean().default(false).meta({
      title: "Return Array",
      description: "Return every match as an array. Off: return the first match",
    }),
  }),
  defaultConfig: {
    html: "{{ $input.data }}",
    selectors: {},
    returnValue: "text",
    attribute: "href",
    returnArray: false,
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => {
    const keys = Object.keys((config.selectors as Record<string, string> | undefined) ?? {});
    return keys.length > 0 ? keys.join(", ") : undefined;
  },
  run: ({ config }) => {
    const root = parse(htmlText(config.html));
    const data: Record<string, unknown> = {};
    for (const [key, selector] of Object.entries(config.selectors)) {
      if (selector.trim() === "") throw new Error(`The selector for "${key}" is empty`);
      const found = root.querySelectorAll(selector);
      if (config.returnArray) {
        data[key] = found
          .map((element) => read(element, config.returnValue, config.attribute))
          .filter((value): value is string => value !== undefined);
      } else {
        const first = found[0];
        data[key] = first ? (read(first, config.returnValue, config.attribute) ?? null) : null;
      }
    }
    return { port: "out", data };
  },
});
