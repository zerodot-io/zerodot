// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";

/** The text of the XML. A string input, or the field `data` of an object. */
function xmlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "data" in value) {
    const data = (value as { data: unknown }).data;
    if (typeof data === "string") return data;
  }
  throw new Error("The XML input must be text");
}

export default defineNode({
  type: "data.xml",
  label: "XML",
  description: "Convert between XML and JSON",
  category: "data",
  actions: [
    { label: "Convert XML to JSON", config: { mode: "xmlToJson" } },
    { label: "Convert JSON to XML", config: { mode: "jsonToXml" } },
  ],
  icon: "FileScriptIcon",
  config: z.object({
    mode: z
      .enum(["xmlToJson", "jsonToXml"])
      .default("xmlToJson")
      .meta({
        title: "Mode",
        labels: { xmlToJson: "XML to JSON", jsonToXml: "JSON to XML" },
        hints: {
          xmlToJson: "Read XML text and make a JSON object",
          jsonToXml: "Write a JSON object as XML text",
        },
      }),
    value: z.unknown().default("{{ $input }}").meta({ title: "Value", ui: "expression" }),
    attributePrefix: z.string().default("@_").meta({
      title: "Attribute Prefix",
      description: "Keys that start with this text are XML attributes",
    }),
    textKey: z.string().default("#text").meta({
      title: "Text Key",
      description: "The key for the text of an element that also has attributes or children",
    }),
    explicitArray: z
      .boolean()
      .default(false)
      .meta({
        title: "Always Use Arrays",
        description: "Make an array of every child, also when there is one",
        showWhen: { mode: ["xmlToJson"] },
      }),
    rootName: z
      .string()
      .default("root")
      .meta({
        title: "Root Name",
        description: "The name of the top element",
        showWhen: { mode: ["jsonToXml"] },
      }),
  }),
  defaultConfig: {
    mode: "xmlToJson",
    value: "{{ $input }}",
    attributePrefix: "@_",
    textKey: "#text",
    explicitArray: false,
    rootName: "root",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (config.mode === "jsonToXml" ? "JSON to XML" : "XML to JSON"),
  run: ({ config }) => {
    if (config.mode === "xmlToJson") {
      const text = xmlText(config.value);
      const valid = XMLValidator.validate(text);
      if (valid !== true) throw new Error(`The XML is not valid: ${valid.err.msg}`);
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: config.attributePrefix,
        textNodeName: config.textKey,
        isArray: () => config.explicitArray,
      });
      return { port: "out", data: parser.parse(text) as unknown };
    }
    const builder = new XMLBuilder({
      ignoreAttributes: false,
      attributeNamePrefix: config.attributePrefix,
      textNodeName: config.textKey,
      format: true,
    });
    const tree = { [config.rootName]: config.value };
    return { port: "out", data: { data: String(builder.build(tree)) } };
  },
});
