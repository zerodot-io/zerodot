// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { readBinary, toBinary } from "./binary";

export default defineNode({
  type: "file.compress",
  label: "Compression",
  description: "Compress a file to gzip, or decompress a gzip file",
  category: "data",
  actions: [
    { label: "Compress a file", config: { operation: "compress" } },
    { label: "Decompress a file", config: { operation: "decompress" } },
  ],
  icon: "FileZipIcon",
  config: z.object({
    operation: z
      .enum(["compress", "decompress"])
      .default("compress")
      .meta({
        title: "Operation",
        labels: { compress: "Compress", decompress: "Decompress" },
        hints: {
          compress: "Make a gzip file from the file",
          decompress: "Get the file out of a gzip file",
        },
      }),
    property: z.string().min(1).default("data").meta({
      title: "Input Binary Field",
      description: "The file is in binary.<property> of the input",
    }),
    outputProperty: z.string().min(1).default("data").meta({
      title: "Output Binary Field",
      description: "The new file goes to binary.<property> of the output",
    }),
    fileName: z.string().default("").meta({
      title: "File Name",
      description: "Empty: the old name with .gz added, or without .gz",
    }),
  }),
  defaultConfig: { operation: "compress", property: "data", outputProperty: "data", fileName: "" },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (config.operation === "decompress" ? "Decompress" : "Compress"),
  // A dynamic import keeps node:zlib out of the browser bundle, which loads this file.
  run: async ({ config, input }) => {
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const file = readBinary(input, config.property);
    const bytes = Buffer.from(file.data, "base64");
    const name = file.fileName ?? "file";
    let out: Buffer;
    let fileName: string;
    let mimeType: string | undefined;
    if (config.operation === "compress") {
      out = gzipSync(bytes);
      fileName = config.fileName || `${name}.gz`;
      mimeType = "application/gzip";
    } else {
      try {
        out = gunzipSync(bytes);
      } catch {
        throw new Error("The file is not a valid gzip file");
      }
      fileName = config.fileName || name.replace(/\.gz$/i, "");
    }
    return {
      port: "out",
      data: { binary: { [config.outputProperty]: toBinary(out, fileName, mimeType) } },
    };
  },
});
