// SPDX-License-Identifier: AGPL-3.0-only
// AWS Signature Version 4 for S3 and S3-compatible services. Pure code: no network.
import { createHash, createHmac } from "node:crypto";
import type { ResolvedCredential } from "@zerodot/engine";

export type S3Target = {
  /** Origin of the service, without a path. Example: `https://s3.eu-west-1.amazonaws.com`. */
  endpoint: URL;
  region: string;
  /** `https://host/bucket/key`, and not `https://bucket.host/key`. */
  pathStyle: boolean;
};

export type S3Keys = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The address, region and keys from an `s3` credential. Empty region means `us-east-1`. Empty
 * endpoint means Amazon S3. A custom endpoint uses path-style addresses, unless the credential
 * says `forcePathStyle: "false"`. Amazon S3 uses virtual-host addresses, unless it says "true".
 */
export function s3Settings(credential: ResolvedCredential | null): {
  target: S3Target;
  keys: S3Keys;
} {
  if (credential?.type !== "s3") throw new Error("Pick an S3 credential");
  const { data } = credential;
  const accessKeyId = text(data.accessKeyId);
  const secretAccessKey = text(data.secretAccessKey);
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("The credential needs an access key id and a secret access key");
  }
  const region = text(data.region) ?? "us-east-1";
  const custom = text(data.endpoint);
  let endpoint: URL;
  try {
    endpoint = new URL(custom ?? `https://s3.${region}.amazonaws.com`);
  } catch {
    throw new Error("The endpoint is not a valid address");
  }
  const forced = text(data.forcePathStyle);
  const pathStyle = forced ? forced === "true" : custom !== undefined;
  const keys: S3Keys = { accessKeyId, secretAccessKey };
  const sessionToken = text(data.sessionToken);
  if (sessionToken) keys.sessionToken = sessionToken;
  return { target: { endpoint, region, pathStyle }, keys };
}

/** Percent-encoding of AWS: only `A-Z a-z 0-9 - _ . ~` stay. */
export const awsEncode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** The path of an object. Each part of the key is encoded, the slashes stay. */
const encodeKey = (key: string): string => key.split("/").map(awsEncode).join("/");

/**
 * The address of a bucket or an object. The key is encoded once, as S3 wants. A bucket name with
 * a dot cannot use a virtual-host address over HTTPS, so it uses a path-style address.
 */
export function buildUrl(
  target: S3Target,
  bucket: string | undefined,
  key: string | undefined,
  query: Record<string, string> = {},
): URL {
  const { endpoint } = target;
  const virtual = bucket !== undefined && !target.pathStyle && !bucket.includes(".");
  const host = virtual ? `${bucket}.${endpoint.host}` : endpoint.host;
  const base = endpoint.pathname.replace(/\/+$/, "");
  let path = base;
  if (bucket !== undefined && !virtual) path += `/${awsEncode(bucket)}`;
  if (key !== undefined) path += `/${encodeKey(key)}`;
  else if (bucket !== undefined && virtual) path += "/";
  const url = new URL(`${endpoint.protocol}//${host}${path === "" ? "/" : path}`);
  url.search = canonicalQuery(query);
  return url;
}

/** Query parameters sorted by name, encoded. This is also the canonical query of the signature. */
export function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest();

/** SHA-256 of an empty body. A constant, so no hash runs when the editor loads this file. */
export const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

/** `20130524T000000Z` */
const amzDate = (now: Date): string => now.toISOString().replace(/[-:]|\.\d{3}/g, "");

function signingKey(secret: string, day: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "s3"), "aws4_request");
}

function canonicalRequest(
  method: string,
  url: URL,
  headers: Record<string, string>,
  payloadHash: string,
): { text: string; signedHeaders: string } {
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
  );
  const signedHeaders = names.join(";");
  return {
    signedHeaders,
    text: [
      method,
      url.pathname,
      url.search.replace(/^\?/, ""),
      `${names.map((name) => `${name}:${lower[name]}`).join("\n")}\n`,
      signedHeaders,
      payloadHash,
    ].join("\n"),
  };
}

function signature(
  keys: S3Keys,
  region: string,
  date: string,
  canonical: string,
): { scope: string; value: string } {
  const day = date.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  return {
    scope,
    value: createHmac("sha256", signingKey(keys.secretAccessKey, day, region))
      .update(toSign)
      .digest("hex"),
  };
}

export type SignedRequest = { url: string; headers: Record<string, string> };

/** Headers for a request with the signature in the `Authorization` header. */
export function signRequest(
  target: S3Target,
  keys: S3Keys,
  request: { method: string; url: URL; headers?: Record<string, string>; body?: Uint8Array },
  now: Date = new Date(),
): SignedRequest {
  const date = amzDate(now);
  const payloadHash = request.body ? sha256(request.body) : EMPTY_HASH;
  const headers: Record<string, string> = {
    ...request.headers,
    host: request.url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": date,
  };
  if (keys.sessionToken) headers["x-amz-security-token"] = keys.sessionToken;
  const canonical = canonicalRequest(request.method, request.url, headers, payloadHash);
  const { scope, value } = signature(keys, target.region, date, canonical.text);
  const { host: _host, ...sent } = headers;
  return {
    url: request.url.toString(),
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${keys.accessKeyId}/${scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${value}`,
    },
  };
}

/** A URL that anyone can use for `expiresIn` seconds. The signature is in the query. */
export function presignUrl(
  target: S3Target,
  keys: S3Keys,
  request: { method: string; bucket: string; key: string; expiresIn: number },
  now: Date = new Date(),
): string {
  if (
    !Number.isInteger(request.expiresIn) ||
    request.expiresIn < 1 ||
    request.expiresIn > 604_800
  ) {
    throw new Error("The time must be from 1 second to 7 days (604800 seconds)");
  }
  const date = amzDate(now);
  const scope = `${date.slice(0, 8)}/${target.region}/s3/aws4_request`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${keys.accessKeyId}/${scope}`,
    "X-Amz-Date": date,
    "X-Amz-Expires": String(request.expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  if (keys.sessionToken) query["X-Amz-Security-Token"] = keys.sessionToken;
  const url = buildUrl(target, request.bucket, request.key, query);
  const canonical = canonicalRequest(request.method, url, { host: url.host }, UNSIGNED_PAYLOAD);
  const { value } = signature(keys, target.region, date, canonical.text);
  url.search = `${url.search.replace(/^\?/, "")}&X-Amz-Signature=${value}`;
  return url.toString();
}
