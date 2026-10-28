// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { toBinary } from "./binary";
import { toCsv } from "./csv";
import { DEFAULT_LIST, isRecord, toList } from "./list-common";

export default defineNode({
  type: "file.convert_to",
  label: "Convert to File",
  description: "Make a file from data: CSV, JSON, or text",
  category: "data",
  icon: "FileOutput",
  config: z.object({
    format: z
      .enum(["csv", "json", "text"])
      .default("csv")
      .meta({
        title: "Format",
        labels: { csv: "CSV", json: "JSON", text: "Text" },
        hints: {
          csv: "One row for each item. The keys make the header",
          json: "The items as a JSON array",
          text: "A text value, saved as a file",
        },
      }),
    list: z
      .unknown()
      .default(DEFAULT_LIST)
      .meta({ title: "Items", ui: "expression", hideWhen: { format: ["text"] } }),
    text: z
      .string()
      .default("")
      .meta({ title: "Text", ui: "expression", showWhen: { format: ["text"] } }),
    delimiter: z
      .string()
      .min(1)
      .max(1)
      .default(",")
      .meta({ title: "Delimiter", showWhen: { format: ["csv"] } }),
    header: z
      .boolean()
      .default(true)
      .meta({ title: "Header Row", showWhen: { format: ["csv"] } }),
    fileName: z.string().default("").meta({
      title: "File Name",
      description: "Empty: file.csv, file.json, or file.txt",
    }),
    property: z.string().min(1).default("data").meta({
      title: "Put File in Property",
      description: "The file is in binary.<property> of the output",
    }),
  }),
  defaultConfig: {
    format: "csv",
    list: DEFAULT_LIST,
    text: "",
    delimiter: ",",
    header: true,
    fileName: "",
    property: "data",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => String(config.format ?? "csv").toUpperCase(),
  run: ({ config }) => {
    const extension = { csv: "csv", json: "json", text: "txt" }[config.format];
    const fileName = config.fileName || `file.${extension}`;
    let content: string;
    if (config.format === "text") {
      content = config.text;
    } else if (config.format === "json") {
      content = JSON.stringify(toList(config.list));
    } else {
      const rows = toList(config.list).map((item) => (isRecord(item) ? item : { data: item }));
      content = toCsv(rows, config.delimiter, config.header);
    }
    const mimeType = { csv: "text/csv", json: "application/json", text: "text/plain" }[
      config.format
    ];
    const bytes = new TextEncoder().encode(content);
    return {
      port: "out",
      data: { binary: { [config.property]: toBinary(bytes, fileName, mimeType) } },
    };
  },
});
