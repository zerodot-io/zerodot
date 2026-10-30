// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readBinary } from "./binary";
import { parseCsv } from "./csv";

export default defineNode({
  type: "file.extract_from",
  label: "Extract from File",
  description: "Read data from a file: CSV, JSON, or text",
  category: "data",
  icon: "FileImportIcon",
  config: z.object({
    format: z
      .enum(["csv", "json", "text"])
      .default("csv")
      .meta({
        title: "Format",
        labels: { csv: "CSV", json: "JSON", text: "Text" },
        hints: {
          csv: "Make one item for each row",
          json: "Parse the file as JSON",
          text: "Read the file as text",
        },
      }),
    property: z.string().min(1).default("data").meta({
      title: "Input Binary Field",
      description: "The file is in binary.<property> of the input",
    }),
    delimiter: z
      .string()
      .min(1)
      .max(1)
      .default(",")
      .meta({ title: "Delimiter", showWhen: { format: ["csv"] } }),
    header: z
      .boolean()
      .default(true)
      .meta({
        title: "Header Row",
        description: "The first row holds the keys",
        showWhen: { format: ["csv"] },
      }),
  }),
  defaultConfig: { format: "csv", property: "data", delimiter: ",", header: true },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => String(config.format ?? "csv").toUpperCase(),
  run: ({ config, input }) => {
    const file = readBinary(input, config.property);
    const content = Buffer.from(file.data, "base64").toString("utf8");
    if (config.format === "text") return { port: "out", data: { data: content } };
    if (config.format === "json") return { port: "out", data: JSON.parse(content) as unknown };
    return { port: "out", data: parseCsv(content, config.delimiter, config.header) };
  },
});
