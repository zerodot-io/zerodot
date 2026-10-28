// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { credentialHeader } from "./credential-header";

/** Reads `a.b.0.c` from a value. Returns undefined when a step is missing. */
function readPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current = value;
  for (const step of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, step)) return undefined;
    current = (current as Record<string, unknown>)[step];
  }
  return current;
}

export default defineNode({
  type: "trigger.http_poll",
  label: "HTTP Poll",
  description: "Check a JSON API on a timer and start a run for each new item",
  category: "trigger",
  icon: "RefreshCw",
  config: z.object({
    url: z.url(),
    intervalSeconds: z.number().int().min(15).max(86_400).default(300).meta({
      title: "Check every (seconds)",
    }),
    itemsPath: z.string().default("").meta({
      title: "Items path",
      description:
        "Where the list is in the response, for example data.items. Empty: the response is the list.",
    }),
    keyPath: z.string().min(1).meta({
      title: "Item key",
      description:
        "Where the unique id is inside an item, for example id. A key that was seen starts no run.",
    }),
    newestFirst: z.boolean().default(true).meta({
      title: "Newest item first",
      description: "Most APIs list the newest item first. Turn off when the oldest comes first.",
    }),
    maxItems: z.number().int().min(1).max(500).default(100).meta({
      title: "Most items to read",
      description: "Only the newest items of the list are read.",
    }),
  }),
  defaultConfig: {
    url: "https://",
    intervalSeconds: 300,
    itemsPath: "",
    keyPath: "id",
    newestFirst: true,
    maxItems: 100,
  },
  credentialTypes: ["http.basic", "http.bearer", "http.header", "oauth2.generic"],
  ports: { in: [], out: ["out"] },
  subtitle: (config) =>
    typeof config.url === "string" && config.url !== "https://" ? config.url : undefined,
  // The input is the item that started the run.
  run: ({ input }) => ({ port: "out", data: input }),
  async poll({ config, credential, signal }) {
    const headers = new Headers({ accept: "application/json" });
    if (credential) {
      const [name, value] = credentialHeader(credential);
      headers.set(name, value);
    }
    const response = await fetch(config.url, {
      headers,
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) throw new Error(`The API answered with status ${response.status}`);
    const list = readPath(await response.json(), config.itemsPath);
    if (!Array.isArray(list)) throw new Error("No list found at the items path");
    const newest = config.newestFirst
      ? list.slice(0, config.maxItems)
      : list.slice(-config.maxItems);
    const items = newest.map((data) => {
      const key = readPath(data, config.keyPath);
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error(`An item has no key at "${config.keyPath}"`);
      }
      return { key: String(key), data };
    });
    // Runs start in the order of the items, so the oldest goes first.
    return { items: config.newestFirst ? items.reverse() : items, cursor: null };
  },
});
