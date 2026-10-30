// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";

const ALGORITHMS = ["md5", "sha1", "sha256", "sha384", "sha512"] as const;
const ENCODINGS = ["hex", "base64"] as const;

export default defineNode({
  type: "data.crypto",
  label: "Crypto",
  description: "Hash, sign, or make random values",
  category: "data",
  actions: [
    { label: "Hash a value", config: { action: "hash" } },
    { label: "Sign a value with HMAC", config: { action: "hmac" } },
    { label: "Make a random string", config: { action: "randomString" } },
    { label: "Make a random UUID", config: { action: "uuid" } },
  ],
  icon: "Key01Icon",
  config: z.object({
    action: z
      .enum(["hash", "hmac", "randomString", "uuid"])
      .default("hash")
      .meta({
        title: "Action",
        labels: { hash: "Hash", hmac: "HMAC", randomString: "Random String", uuid: "UUID" },
        hints: {
          hash: "Make a hash of a value",
          hmac: "Sign a value with a secret",
          randomString: "Make a random string",
          uuid: "Make a random UUID",
        },
      }),
    value: z.string().default(""),
    algorithm: z
      .enum(ALGORITHMS)
      .default("sha256")
      .meta({
        title: "Algorithm",
        labels: {
          md5: "MD5",
          sha1: "SHA-1",
          sha256: "SHA-256",
          sha384: "SHA-384",
          sha512: "SHA-512",
        },
        hints: {
          md5: "Weak. Use only for old systems",
          sha1: "Weak. Use only for old systems",
          sha256: "A good default",
          sha384: "A longer hash",
          sha512: "The longest hash",
        },
      }),
    // The secret of an HMAC. Not used by the other actions.
    secret: z.string().default(""),
    encoding: z
      .enum(ENCODINGS)
      .default("hex")
      .meta({
        title: "Encoding",
        labels: { hex: "Hex", base64: "Base64" },
        hints: { hex: "Letters 0-9 and a-f", base64: "A shorter text" },
      }),
    // Number of random bytes for randomString.
    bytes: z.number().int().min(1).max(1024).default(16),
    outputField: z.string().min(1).default("result"),
  }),
  defaultConfig: {
    action: "hash",
    value: "{{ $input.value }}",
    algorithm: "sha256",
    secret: "",
    encoding: "hex",
    bytes: 16,
    outputField: "result",
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) => (typeof config.action === "string" ? config.action : undefined),
  run: async ({ config, input }) => {
    // Loaded on run: the editor bundles this file for the browser, which has no node:crypto.
    const { createHash, createHmac, randomBytes, randomUUID } = await import("node:crypto");
    let result: string;
    switch (config.action) {
      case "hash":
        result = createHash(config.algorithm).update(config.value).digest(config.encoding);
        break;
      case "hmac":
        if (!config.secret) throw new Error("HMAC needs a secret");
        result = createHmac(config.algorithm, config.secret)
          .update(config.value)
          .digest(config.encoding);
        break;
      case "randomString":
        result = randomBytes(config.bytes).toString(config.encoding);
        break;
      case "uuid":
        result = randomUUID();
        break;
    }
    const base = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
    return { port: "out", data: { ...base, [config.outputField]: result } };
  },
});
