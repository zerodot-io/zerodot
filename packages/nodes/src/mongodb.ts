// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, type ResolvedCredential } from "@zerodot/engine";
import { z } from "zod";

export const MONGODB_CREDENTIAL_TYPES = ["mongodb"];

const OPERATIONS = [
  "find",
  "insert",
  "update",
  "delete",
  "aggregate",
  "findOneAndUpdate",
  "findOneAndReplace",
] as const;

const config = z.object({
  operation: z
    .enum(OPERATIONS)
    .default("find")
    .meta({
      title: "Operation",
      labels: {
        find: "Find Documents",
        insert: "Insert Documents",
        update: "Update Documents",
        delete: "Delete Documents",
        aggregate: "Aggregate",
        findOneAndUpdate: "Find and Update",
        findOneAndReplace: "Find and Replace",
      },
      hints: {
        find: "Get documents that match a query",
        insert: "Add one or more documents",
        update: "Change all documents that match a query",
        delete: "Delete all documents that match a query",
        aggregate: "Run an aggregation pipeline",
        findOneAndUpdate: "Change one document and get it back",
        findOneAndReplace: "Replace one document and get it back",
      },
    }),
  collection: z.string().min(1).meta({ title: "Collection" }),
  query: z
    .string()
    .default("{}")
    .meta({
      title: "Query",
      description:
        'A JSON query, for example {"status": "open"}. Extended JSON works: {"_id": {"$oid": "..."}}',
      showWhen: {
        operation: ["find", "update", "delete", "findOneAndUpdate", "findOneAndReplace"],
      },
    }),
  sort: z
    .string()
    .default("")
    .meta({
      title: "Sort",
      description: 'JSON, for example {"createdAt": -1}',
      showWhen: { operation: ["find"] },
    }),
  projection: z
    .string()
    .default("")
    .meta({
      title: "Projection",
      description: 'JSON, for example {"name": 1, "_id": 0}',
      showWhen: { operation: ["find"] },
    }),
  limit: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({
      title: "Limit",
      description: "The most documents to get. 0 means all.",
      showWhen: { operation: ["find"] },
    }),
  skip: z
    .number()
    .int()
    .min(0)
    .default(0)
    .meta({
      title: "Skip",
      showWhen: { operation: ["find"] },
    }),
  documents: z
    .string()
    .default("[]")
    .meta({
      title: "Documents",
      description: "A JSON array of documents, or one document",
      showWhen: { operation: ["insert"] },
    }),
  update: z
    .string()
    .default("")
    .meta({
      title: "Update",
      description: 'A JSON update, for example {"$set": {"status": "done"}}',
      showWhen: { operation: ["update", "findOneAndUpdate"] },
    }),
  replacement: z
    .string()
    .default("")
    .meta({
      title: "Replacement",
      description: "The new document, as JSON",
      showWhen: { operation: ["findOneAndReplace"] },
    }),
  upsert: z
    .boolean()
    .default(false)
    .meta({
      title: "Upsert",
      description: "Whether to insert a document when none matches",
      showWhen: { operation: ["update", "findOneAndUpdate", "findOneAndReplace"] },
    }),
  pipeline: z
    .string()
    .default("[]")
    .meta({
      title: "Pipeline",
      description: 'A JSON array of stages, for example [{"$match": {"a": 1}}]',
      showWhen: { operation: ["aggregate"] },
    }),
});

export type MongoConfig = z.output<typeof config>;

/** The methods of a collection that the node uses. The driver has them. A test can fake them. */
export type MongoCollection = {
  find(
    query: object,
    options: { sort?: object; projection?: object; limit?: number; skip?: number },
  ): { toArray(): Promise<object[]> };
  insertMany(documents: object[]): Promise<{ insertedIds: Record<string, unknown> }>;
  updateMany(
    query: object,
    update: object,
    options: { upsert: boolean },
  ): Promise<{ matchedCount: number; modifiedCount: number; upsertedId?: unknown }>;
  deleteMany(query: object): Promise<{ deletedCount: number }>;
  aggregate(pipeline: object[]): { toArray(): Promise<object[]> };
  findOneAndUpdate(
    query: object,
    update: object,
    options: { upsert: boolean; returnDocument: "after" },
  ): Promise<object | null>;
  findOneAndReplace(
    query: object,
    replacement: object,
    options: { upsert: boolean; returnDocument: "after" },
  ): Promise<object | null>;
};

type Bson = {
  EJSON: {
    parse(text: string, options?: { relaxed?: boolean }): unknown;
    stringify(value: unknown, options?: { relaxed?: boolean }): string;
  };
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reads a JSON field. Extended JSON (`{"$oid": ...}`) becomes the BSON types. */
export function parseField(bson: Bson, name: string, text: string, fallback: string): unknown {
  const source = text.trim() === "" ? fallback : text;
  try {
    return bson.EJSON.parse(source, { relaxed: true });
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
}

function parseObject(bson: Bson, name: string, text: string, fallback = "{}"): object {
  const value = parseField(bson, name, text, fallback);
  if (!isObject(value)) throw new Error(`${name} must be a JSON object`);
  return value;
}

function parseArray(bson: Bson, name: string, text: string): object[] {
  const value = parseField(bson, name, text, "[]");
  const list = Array.isArray(value) ? value : [value];
  if (!list.every(isObject)) throw new Error(`${name} must hold JSON objects`);
  return list as object[];
}

/** Makes a document plain JSON: an id becomes text and a date becomes an ISO string. */
export function toPlain(bson: Bson, value: unknown): unknown {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!isObject(node)) return node;
    const keys = Object.keys(node);
    if (keys.length === 1) {
      const key = keys[0] as string;
      if (key === "$oid" || key === "$date" || key === "$numberLong" || key === "$numberDecimal") {
        const inner = node[key];
        return typeof inner === "object" ? walk(inner) : inner;
      }
    }
    return Object.fromEntries(keys.map((k) => [k, walk(node[k])]));
  };
  return walk(JSON.parse(bson.EJSON.stringify(value, { relaxed: true })));
}

/** Runs one operation. Gives the items for the next node. */
export async function runMongoOperation(
  bson: Bson,
  collection: MongoCollection,
  cfg: MongoConfig,
): Promise<unknown> {
  const plain = (value: unknown) => toPlain(bson, value);
  switch (cfg.operation) {
    case "find": {
      const sort = cfg.sort.trim() ? parseObject(bson, "Sort", cfg.sort) : undefined;
      const projection = cfg.projection.trim()
        ? parseObject(bson, "Projection", cfg.projection)
        : undefined;
      const documents = await collection
        .find(parseObject(bson, "Query", cfg.query), {
          sort,
          projection,
          limit: cfg.limit || undefined,
          skip: cfg.skip || undefined,
        })
        .toArray();
      return { items: plain(documents) };
    }
    case "insert": {
      const result = await collection.insertMany(parseArray(bson, "Documents", cfg.documents));
      return plain({
        insertedCount: Object.keys(result.insertedIds).length,
        insertedIds: result.insertedIds,
      });
    }
    case "update": {
      const result = await collection.updateMany(
        parseObject(bson, "Query", cfg.query),
        parseObject(bson, "Update", cfg.update),
        { upsert: cfg.upsert },
      );
      return plain({
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
        upsertedId: result.upsertedId ?? null,
      });
    }
    case "delete": {
      const result = await collection.deleteMany(parseObject(bson, "Query", cfg.query));
      return { deletedCount: result.deletedCount };
    }
    case "aggregate": {
      const documents = await collection
        .aggregate(parseArray(bson, "Pipeline", cfg.pipeline))
        .toArray();
      return { items: plain(documents) };
    }
    case "findOneAndUpdate": {
      const document = await collection.findOneAndUpdate(
        parseObject(bson, "Query", cfg.query),
        parseObject(bson, "Update", cfg.update),
        { upsert: cfg.upsert, returnDocument: "after" },
      );
      return { document: plain(document) };
    }
    case "findOneAndReplace": {
      const document = await collection.findOneAndReplace(
        parseObject(bson, "Query", cfg.query),
        parseObject(bson, "Replacement", cfg.replacement),
        { upsert: cfg.upsert, returnDocument: "after" },
      );
      return { document: plain(document) };
    }
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export function mongoSettings(credential: ResolvedCredential | null): {
  connectionString: string;
  database: string;
} {
  if (credential?.type !== "mongodb") throw new Error("Pick a MongoDB credential");
  const connectionString = text(credential.data.connectionString);
  const database = text(credential.data.database);
  if (!connectionString) throw new Error('The credential has no "connectionString"');
  if (!database) throw new Error('The credential has no "database"');
  return { connectionString, database };
}

export default defineNode({
  type: "mongodb.documents",
  label: "MongoDB",
  description: "Find, insert, update, delete, and aggregate documents in MongoDB",
  category: "integration",
  app: "MongoDB",
  actions: [
    { label: "Find documents", config: { operation: "find" } },
    { label: "Insert documents", config: { operation: "insert" } },
    { label: "Update documents", config: { operation: "update" } },
    { label: "Delete documents", config: { operation: "delete" } },
    { label: "Aggregate documents", config: { operation: "aggregate" } },
    { label: "Find and update a document", config: { operation: "findOneAndUpdate" } },
    { label: "Find and replace a document", config: { operation: "findOneAndReplace" } },
  ],
  icon: "Database",
  config,
  defaultConfig: {
    operation: "find",
    collection: "",
    query: "{}",
    sort: "",
    projection: "",
    limit: 0,
    skip: 0,
    documents: "[]",
    update: "",
    replacement: "",
    upsert: false,
    pipeline: "[]",
  },
  credentialTypes: MONGODB_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) =>
    typeof cfg.collection === "string" && cfg.collection !== "" ? cfg.collection : undefined,
  async run({ config: cfg, credential }) {
    const { connectionString, database } = mongoSettings(credential);
    const mongo = await import("mongodb");
    const client = new mongo.MongoClient(connectionString, {
      serverSelectionTimeoutMS: 10_000,
      appName: "zerodot",
    });
    try {
      await client.connect();
      const collection = client.db(database).collection(cfg.collection);
      const data = await runMongoOperation(
        mongo.BSON as unknown as Bson,
        collection as unknown as MongoCollection,
        cfg,
      );
      return { port: "out", data };
    } finally {
      await client.close().catch(() => {});
    }
  },
});
