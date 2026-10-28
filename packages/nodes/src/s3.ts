// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, resolveTemplate, toItems } from "@zerodot/engine";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import { readBinary, toBinary } from "./binary";
import {
  buildUrl,
  presignUrl,
  type S3Keys,
  type S3Target,
  s3Settings,
  signRequest,
} from "./s3-sign";

export const S3_CREDENTIAL_TYPES = ["s3"];

const OPERATIONS = [
  "listBuckets",
  "createBucket",
  "deleteBucket",
  "listObjects",
  "getObject",
  "putObject",
  "deleteObject",
  "presignUrl",
] as const;

type Row = Record<string, unknown>;

export type S3Call = {
  method: string;
  bucket?: string;
  key?: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: Uint8Array;
};

export type S3Context = {
  target: S3Target;
  keys: S3Keys;
  fetch: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
};

const xml = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

const asList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** An error body of S3 is XML with `Code` and `Message`. */
export async function s3Error(response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  let code = "";
  let message = "";
  try {
    const parsed = xml.parse(body) as { Error?: { Code?: unknown; Message?: unknown } };
    code = str(parsed.Error?.Code);
    message = str(parsed.Error?.Message);
  } catch {
    // The body is not XML (a HEAD answer has no body). The status is enough.
  }
  const detail = [code, message].filter(Boolean).join(": ");
  return new Error(`S3 answered ${response.status}${detail ? ` (${detail})` : ""}`);
}

/** Sends one signed request. Throws when the answer is not a success. */
export async function s3Send(ctx: S3Context, call: S3Call): Promise<Response> {
  const url = buildUrl(ctx.target, call.bucket, call.key, call.query);
  const signed = signRequest(
    ctx.target,
    ctx.keys,
    { method: call.method, url, headers: call.headers, body: call.body },
    ctx.now?.(),
  );
  const response = await ctx.fetch(signed.url, {
    method: call.method,
    headers: signed.headers,
    body: call.body ? Buffer.from(call.body) : undefined,
    signal: ctx.signal,
  });
  if (!response.ok) throw await s3Error(response);
  return response;
}

export async function listBuckets(ctx: S3Context): Promise<Row[]> {
  const response = await s3Send(ctx, { method: "GET" });
  const parsed = xml.parse(await response.text()) as {
    ListAllMyBucketsResult?: { Buckets?: { Bucket?: Row | Row[] } };
  };
  return asList(parsed.ListAllMyBucketsResult?.Buckets?.Bucket).map((bucket) => ({
    name: str(bucket.Name),
    creationDate: str(bucket.CreationDate),
  }));
}

export async function listObjects(
  ctx: S3Context,
  bucket: string,
  options: { prefix?: string; delimiter?: string; limit?: number },
): Promise<Row[]> {
  const rows: Row[] = [];
  let token: string | undefined;
  for (;;) {
    const remaining = options.limit === undefined ? 1000 : options.limit - rows.length;
    if (remaining <= 0) break;
    const query: Record<string, string> = {
      "list-type": "2",
      "max-keys": String(Math.min(remaining, 1000)),
    };
    if (options.prefix) query.prefix = options.prefix;
    if (options.delimiter) query.delimiter = options.delimiter;
    if (token) query["continuation-token"] = token;
    const response = await s3Send(ctx, { method: "GET", bucket, query });
    const parsed = xml.parse(await response.text()) as {
      ListBucketResult?: {
        Contents?: Row | Row[];
        CommonPrefixes?: Row | Row[];
        IsTruncated?: string;
        NextContinuationToken?: string;
      };
    };
    const result = parsed.ListBucketResult;
    for (const object of asList(result?.Contents)) {
      rows.push({
        key: str(object.Key),
        size: Number(str(object.Size)),
        lastModified: str(object.LastModified),
        etag: str(object.ETag).replace(/"/g, ""),
        storageClass: str(object.StorageClass),
      });
    }
    // With a delimiter, S3 groups keys into "folders".
    for (const folder of asList(result?.CommonPrefixes)) rows.push({ prefix: str(folder.Prefix) });
    if (result?.IsTruncated !== "true" || !result.NextContinuationToken) break;
    token = result.NextContinuationToken;
  }
  return options.limit === undefined ? rows : rows.slice(0, options.limit);
}

const headerOf = (response: Response, name: string): string | undefined =>
  response.headers.get(name) ?? undefined;

export async function getObject(
  ctx: S3Context,
  bucket: string,
  key: string,
  options: { download: boolean; property: string },
): Promise<Row> {
  const response = await s3Send(ctx, { method: options.download ? "GET" : "HEAD", bucket, key });
  const row: Row = {
    bucket,
    key,
    contentType: headerOf(response, "content-type"),
    size: Number(headerOf(response, "content-length") ?? 0),
    etag: headerOf(response, "etag")?.replace(/"/g, ""),
    lastModified: headerOf(response, "last-modified"),
  };
  if (options.download) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    row.size = bytes.byteLength;
    row.binary = {
      [options.property]: toBinary(
        bytes,
        key.split("/").pop() || key,
        headerOf(response, "content-type")?.split(";")[0],
      ),
    };
  }
  return row;
}

export async function putObject(
  ctx: S3Context,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string | undefined,
): Promise<Row> {
  const response = await s3Send(ctx, {
    method: "PUT",
    bucket,
    key,
    body,
    headers: contentType ? { "content-type": contentType } : undefined,
  });
  return {
    bucket,
    key,
    size: body.byteLength,
    etag: headerOf(response, "etag")?.replace(/"/g, ""),
  };
}

export async function createBucket(ctx: S3Context, bucket: string): Promise<Row> {
  // Amazon S3 outside us-east-1 wants the region in the body. A custom service does not.
  const needsRegion =
    ctx.target.region !== "us-east-1" && ctx.target.endpoint.hostname.endsWith("amazonaws.com");
  const body = needsRegion
    ? new TextEncoder().encode(
        `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${ctx.target.region}</LocationConstraint></CreateBucketConfiguration>`,
      )
    : undefined;
  await s3Send(ctx, { method: "PUT", bucket, body });
  return { bucket, created: true };
}

const option = (title: string) => ({ option: true, title });

const config = z.object({
  operation: z
    .enum(OPERATIONS)
    .default("listObjects")
    .meta({
      title: "Operation",
      labels: {
        listBuckets: "List Buckets",
        createBucket: "Create Bucket",
        deleteBucket: "Delete Bucket",
        listObjects: "List Objects",
        getObject: "Get Object",
        putObject: "Put Object",
        deleteObject: "Delete Object",
        presignUrl: "Create Presigned URL",
      },
      hints: {
        listBuckets: "List all buckets of the account",
        createBucket: "Create a bucket",
        deleteBucket: "Delete an empty bucket",
        listObjects: "List the objects in a bucket",
        getObject: "Download an object, or read only its details",
        putObject: "Upload an object from binary data or text",
        deleteObject: "Delete an object",
        presignUrl: "Make a link that works without keys for a limited time",
      },
    }),
  bucket: z
    .string()
    .default("")
    .meta({
      title: "Bucket Name",
      description: "The bucket to work on",
      hideWhen: { operation: ["listBuckets"] },
    }),
  key: z
    .string()
    .default("")
    .meta({
      title: "Object Key",
      placeholder: "e.g. folder/file.txt",
      description: "The name of the object, with its folders",
      showWhen: { operation: ["getObject", "putObject", "deleteObject", "presignUrl"] },
    }),
  returnAll: z
    .boolean()
    .default(false)
    .meta({
      title: "Return All",
      description: "Whether to return all results or only up to a given limit",
      showWhen: { operation: ["listObjects"] },
    }),
  limit: z
    .number()
    .int()
    .min(1)
    .default(100)
    .meta({
      title: "Limit",
      description: "Max number of results to return",
      showWhen: { operation: ["listObjects"], returnAll: [false] },
    }),
  download: z
    .boolean()
    .default(true)
    .meta({
      title: "Download",
      description: "Whether to download the content, or read only the details of the object",
      showWhen: { operation: ["getObject"] },
    }),
  source: z
    .enum(["binary", "text"])
    .default("binary")
    .meta({
      title: "Content From",
      labels: { binary: "Binary Data", text: "Text" },
      hints: {
        binary: "Upload binary data that an earlier node made",
        text: "Upload the text below",
      },
      showWhen: { operation: ["putObject"] },
    }),
  binaryPropertyName: z
    .string()
    .default("data")
    .meta({
      title: "Binary Property",
      description:
        "Name of the binary property to read from the input, or to write the download to",
      showWhen: [
        { operation: ["getObject"], download: [true] },
        { operation: ["putObject"], source: ["binary"] },
      ],
    }),
  text: z
    .string()
    .default("")
    .meta({
      title: "Text",
      ui: "code",
      description: "The text to upload",
      showWhen: { operation: ["putObject"], source: ["text"] },
    }),
  expiresIn: z
    .number()
    .int()
    .min(1)
    .max(604_800)
    .default(3600)
    .meta({
      title: "Expires In (seconds)",
      description: "How long the link works. The maximum is 7 days (604800 seconds).",
      showWhen: { operation: ["presignUrl"] },
    }),
  presignMethod: z
    .enum(["GET", "PUT", "DELETE"])
    .default("GET")
    .meta({
      title: "Link For",
      labels: { GET: "Download", PUT: "Upload", DELETE: "Delete" },
      hints: {
        GET: "Anyone with the link can download the object",
        PUT: "Anyone with the link can upload the object",
        DELETE: "Anyone with the link can delete the object",
      },
      showWhen: { operation: ["presignUrl"] },
    }),
  prefix: z
    .string()
    .default("")
    .meta({
      ...option("Prefix"),
      description: "Only list objects whose key starts with this text",
      showWhen: { operation: ["listObjects"] },
    }),
  delimiter: z
    .string()
    .default("")
    .meta({
      ...option("Delimiter"),
      placeholder: "e.g. /",
      description: "Group keys by this character, to list the folders of one level",
      showWhen: { operation: ["listObjects"] },
    }),
  contentType: z
    .string()
    .default("")
    .meta({
      ...option("Content Type"),
      placeholder: "e.g. image/png",
      description: "Empty means the type of the binary data, or text/plain for text",
      showWhen: { operation: ["putObject"] },
    }),
});

type Config = z.output<typeof config>;

const need = (value: string, what: string): string => {
  if (value === "") throw new Error(`Set the ${what}`);
  return value;
};

/** Runs the operation for one item. Returns the output items. */
export async function runOperation(ctx: S3Context, cfg: Config, input: unknown): Promise<Row[]> {
  switch (cfg.operation) {
    case "listBuckets":
      return await listBuckets(ctx);
    case "createBucket":
      return [await createBucket(ctx, need(cfg.bucket, "bucket name"))];
    case "deleteBucket": {
      const bucket = need(cfg.bucket, "bucket name");
      await s3Send(ctx, { method: "DELETE", bucket });
      return [{ bucket, deleted: true }];
    }
    case "listObjects":
      return await listObjects(ctx, need(cfg.bucket, "bucket name"), {
        prefix: cfg.prefix || undefined,
        delimiter: cfg.delimiter || undefined,
        limit: cfg.returnAll ? undefined : cfg.limit,
      });
    case "getObject":
      return [
        await getObject(ctx, need(cfg.bucket, "bucket name"), need(cfg.key, "object key"), {
          download: cfg.download,
          property: cfg.binaryPropertyName || "data",
        }),
      ];
    case "putObject": {
      const bucket = need(cfg.bucket, "bucket name");
      const key = need(cfg.key, "object key");
      if (cfg.source === "text") {
        return [
          await putObject(
            ctx,
            bucket,
            key,
            new TextEncoder().encode(cfg.text),
            cfg.contentType || "text/plain; charset=utf-8",
          ),
        ];
      }
      const binary = readBinary(input, cfg.binaryPropertyName || "data");
      return [
        await putObject(
          ctx,
          bucket,
          key,
          new Uint8Array(Buffer.from(binary.data, "base64")),
          cfg.contentType || binary.mimeType,
        ),
      ];
    }
    case "deleteObject": {
      const bucket = need(cfg.bucket, "bucket name");
      const key = need(cfg.key, "object key");
      await s3Send(ctx, { method: "DELETE", bucket, key });
      return [{ bucket, key, deleted: true }];
    }
    case "presignUrl": {
      const bucket = need(cfg.bucket, "bucket name");
      const key = need(cfg.key, "object key");
      const now = ctx.now?.() ?? new Date();
      const url = presignUrl(
        ctx.target,
        ctx.keys,
        { method: cfg.presignMethod, bucket, key, expiresIn: cfg.expiresIn },
        now,
      );
      return [
        {
          bucket,
          key,
          url,
          expiresAt: new Date(now.getTime() + cfg.expiresIn * 1000).toISOString(),
        },
      ];
    }
  }
}

const RAW_KEYS = ["bucket", "key", "text", "prefix"] as const;

/** Resolves the expressions of the raw keys for one item. */
function forItem(cfg: Config, scope: Record<string, unknown>): Config {
  const resolved: Config = { ...cfg };
  for (const name of RAW_KEYS) {
    const value = resolveTemplate(cfg[name], scope);
    resolved[name] = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  }
  return resolved;
}

export default defineNode({
  type: "s3.storage",
  label: "S3",
  description: "Work with buckets and objects in Amazon S3 and S3-compatible storage",
  category: "integration",
  app: "S3",
  actions: [
    { label: "List buckets", config: { operation: "listBuckets" } },
    { label: "Create a bucket", config: { operation: "createBucket" } },
    { label: "Delete a bucket", config: { operation: "deleteBucket" } },
    { label: "List objects in a bucket", config: { operation: "listObjects" } },
    { label: "Download an object", config: { operation: "getObject" } },
    { label: "Upload an object", config: { operation: "putObject" } },
    { label: "Delete an object", config: { operation: "deleteObject" } },
    { label: "Create a presigned URL", config: { operation: "presignUrl" } },
  ],
  icon: "HardDrive",
  iconUrl: "/icons/amazon-s3.svg",
  config,
  defaultConfig: { operation: "listObjects", bucket: "" },
  // These keys can read one item, so they are resolved once for each item.
  rawConfigKeys: [...RAW_KEYS],
  credentialTypes: S3_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.operation === "string" ? cfg.operation : undefined),
  // Each input item runs the operation once. The output is all the results.
  async run({ config: cfg, input, credential, scope, signal }) {
    const items = toItems(input);
    if (items.length === 0) return { port: "out", data: [] };
    const { target, keys } = s3Settings(credential);
    const ctx: S3Context = { target, keys, fetch, signal };
    const out: Row[] = [];
    for (const [index, item] of items.entries()) {
      const itemScope = { ...scope, $item: item, $json: item, $index: index };
      out.push(...(await runOperation(ctx, forItem(cfg, itemScope), item)));
    }
    return { port: "out", data: out };
  },
});
