// SPDX-License-Identifier: AGPL-3.0-only
// The small S3 client that the blob store needs: signed requests and a list of objects.
import { XMLParser } from "fast-xml-parser";
import { buildUrl, type S3Keys, type S3Target, signRequest } from "./s3-sign";

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
