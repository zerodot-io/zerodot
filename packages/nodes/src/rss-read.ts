// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asList = (value: unknown): unknown[] =>
  value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

/** The text of an XML value. A node with attributes keeps its text under `#text`. */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value) && "#text" in value) return text(value["#text"]);
  return undefined;
}

/** The link of an Atom entry: the alternate link, or the first one. */
function atomLink(value: unknown): string | undefined {
  const links = asList(value).filter(isRecord);
  const pick = links.find((link) => link["@_rel"] === undefined || link["@_rel"] === "alternate");
  const href = (pick ?? links[0])?.["@_href"];
  return typeof href === "string" ? href : undefined;
}

/** Items of an RSS 2.0, RSS 1.0 (RDF), or Atom feed. Each item keeps its own fields. */
export function parseFeed(xml: string): Json[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const doc = parser.parse(xml) as Json;
  const rss = doc.rss;
  const rdf = doc["rdf:RDF"];
  const atom = doc.feed;
  if (isRecord(rss) && isRecord(rss.channel)) return asList(rss.channel.item).filter(isRecord);
  if (isRecord(rdf)) return asList(rdf.item).filter(isRecord);
  if (isRecord(atom)) {
    return asList(atom.entry)
      .filter(isRecord)
      .map((entry) => ({
        ...entry,
        title: text(entry.title),
        link: atomLink(entry.link),
        id: text(entry.id),
        updated: text(entry.updated),
        summary: text(entry.summary),
        content: text(entry.content),
      }));
  }
  throw new Error("The response is not an RSS or Atom feed");
}

export default defineNode({
  type: "rss.read",
  label: "RSS Read",
  description: "Read the items of an RSS or Atom feed",
  category: "core",
  icon: "RssIcon",
  config: z.object({
    url: z.url().meta({ title: "URL" }),
    limit: z
      .number()
      .int()
      .min(0)
      .default(0)
      .meta({ title: "Limit", description: "The most items to return. 0 returns all" }),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  }),
  defaultConfig: { url: "https://", limit: 0, timeoutMs: 30_000 },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.url === "string" && config.url !== "https://" ? config.url : undefined,
  async run({ config, signal }) {
    const response = await fetch(config.url, {
      headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}: ${body.slice(0, 200)}`);
    }
    const items = parseFeed(body);
    return { port: "out", data: config.limit > 0 ? items.slice(0, config.limit) : items };
  },
});
