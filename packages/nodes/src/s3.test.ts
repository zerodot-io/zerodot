// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCredentialData } from "./credentials";
import { registry } from "./index";
import { listBuckets, listObjects, putObject, type S3Context, s3Send } from "./s3";
import { buildUrl, presignUrl, s3Settings, signRequest } from "./s3-sign";

// The example of the AWS documentation for query string authentication.
const AWS_KEYS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_TARGET = {
  endpoint: new URL("https://s3.amazonaws.com"),
  region: "us-east-1",
  pathStyle: false,
};
const AWS_TIME = new Date("2013-05-24T00:00:00Z");

describe("s3Settings", () => {
  it("uses Amazon, us-east-1 and virtual-host addresses by default", () => {
    const { target, keys } = s3Settings({
      type: "s3",
      data: { accessKeyId: "a", secretAccessKey: "b" },
    });
    assert.equal(target.endpoint.href, "https://s3.us-east-1.amazonaws.com/");
    assert.equal(target.region, "us-east-1");
    assert.equal(target.pathStyle, false);
    assert.deepEqual(keys, { accessKeyId: "a", secretAccessKey: "b" });
  });

  it("uses path-style addresses for a custom endpoint", () => {
    const { target } = s3Settings({
      type: "s3",
      data: {
        accessKeyId: "a",
        secretAccessKey: "b",
        endpoint: "http://localhost:9000",
        region: "eu-1",
      },
    });
    assert.equal(target.pathStyle, true);
    assert.equal(target.region, "eu-1");
    const off = s3Settings({
      type: "s3",
      data: {
        accessKeyId: "a",
        secretAccessKey: "b",
        endpoint: "https://x.io",
        forcePathStyle: "false",
      },
    });
    assert.equal(off.target.pathStyle, false);
  });

  it("fails without a credential or keys", () => {
    assert.throws(() => s3Settings(null), /Pick an S3 credential/);
    assert.throws(() => s3Settings({ type: "s3", data: {} }), /access key id/);
  });
});

describe("addresses", () => {
  it("builds path-style and virtual-host addresses", () => {
    const path = { ...AWS_TARGET, pathStyle: true };
    assert.equal(buildUrl(path, "b", "a b/c.txt").href, "https://s3.amazonaws.com/b/a%20b/c.txt");
    assert.equal(buildUrl(AWS_TARGET, "b", "c.txt").href, "https://b.s3.amazonaws.com/c.txt");
    assert.equal(buildUrl(AWS_TARGET, undefined, undefined).href, "https://s3.amazonaws.com/");
  });

  it("uses a path-style address for a bucket name with a dot", () => {
    assert.equal(
      buildUrl(AWS_TARGET, "my.bucket", "k").href,
      "https://s3.amazonaws.com/my.bucket/k",
    );
  });

  it("sorts and encodes the query", () => {
    const url = buildUrl(AWS_TARGET, "b", undefined, { prefix: "a/b c", "list-type": "2" });
    assert.equal(url.search, "?list-type=2&prefix=a%2Fb%20c");
  });
});

describe("signing", () => {
  it("makes the presigned URL of the AWS documentation", () => {
    const url = presignUrl(
      AWS_TARGET,
      AWS_KEYS,
      { method: "GET", bucket: "examplebucket", key: "test.txt", expiresIn: 86_400 },
      AWS_TIME,
    );
    assert.equal(
      url,
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("refuses a time over 7 days", () => {
    assert.throws(
      () =>
        presignUrl(AWS_TARGET, AWS_KEYS, {
          method: "GET",
          bucket: "b",
          key: "k",
          expiresIn: 604_801,
        }),
      /7 days/,
    );
  });

  it("makes the Authorization header of the AWS documentation (GET object with Range)", () => {
    const signed = signRequest(
      AWS_TARGET,
      AWS_KEYS,
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: { range: "bytes=0-9" },
      },
      AWS_TIME,
    );
    assert.match(
      signed.headers.authorization ?? "",
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
    );
  });

  it("signs the session token", () => {
    const signed = signRequest(
      AWS_TARGET,
      { ...AWS_KEYS, sessionToken: "tok" },
      { method: "GET", url: new URL("https://b.s3.amazonaws.com/k") },
      AWS_TIME,
    );
    assert.equal(signed.headers["x-amz-security-token"], "tok");
    assert.match(signed.headers.authorization ?? "", /x-amz-security-token/);
  });
});

type Seen = { url: string; method: string; headers: Record<string, string>; body?: unknown };

function fakeContext(answers: Response[]): { ctx: S3Context; seen: Seen[] } {
  const seen: Seen[] = [];
  const ctx: S3Context = {
    target: { endpoint: new URL("http://s3.local:9000"), region: "us-east-1", pathStyle: true },
    keys: AWS_KEYS,
    now: () => AWS_TIME,
    fetch: async (input, init) => {
      seen.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: init?.headers as Record<string, string>,
        body: init?.body,
      });
      const next = answers.shift();
      if (!next) throw new Error("No answer left");
      return next;
    },
  };
  return { ctx, seen };
}

const xmlResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "application/xml" } });

describe("requests", () => {
  it("lists buckets", async () => {
    const { ctx, seen } = fakeContext([
      xmlResponse(
        "<ListAllMyBucketsResult><Buckets><Bucket><Name>a</Name><CreationDate>2020-01-01T00:00:00.000Z</CreationDate></Bucket><Bucket><Name>b</Name><CreationDate>x</CreationDate></Bucket></Buckets></ListAllMyBucketsResult>",
      ),
    ]);
    const rows = await listBuckets(ctx);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["a", "b"],
    );
    assert.equal(seen[0]?.url, "http://s3.local:9000/");
    assert.ok(seen[0]?.headers.authorization?.startsWith("AWS4-HMAC-SHA256"));
  });

  it("lists one bucket with one name", async () => {
    const { ctx } = fakeContext([
      xmlResponse(
        "<ListAllMyBucketsResult><Buckets><Bucket><Name>only</Name></Bucket></Buckets></ListAllMyBucketsResult>",
      ),
    ]);
    assert.equal((await listBuckets(ctx)).length, 1);
  });

  it("follows the continuation token and stops at the limit", async () => {
    const page = (key: string, next?: string) =>
      xmlResponse(
        `<ListBucketResult><Contents><Key>${key}</Key><Size>3</Size><ETag>"e"</ETag></Contents><IsTruncated>${next ? "true" : "false"}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""}</ListBucketResult>`,
      );
    const all = fakeContext([page("a", "t1"), page("b")]);
    const rows = await listObjects(all.ctx, "bk", { prefix: "p/" });
    assert.deepEqual(
      rows.map((r) => r.key),
      ["a", "b"],
    );
    assert.match(all.seen[0]?.url ?? "", /list-type=2&max-keys=1000&prefix=p%2F$/);
    assert.match(all.seen[1]?.url ?? "", /continuation-token=t1/);
    assert.equal(rows[0]?.etag, "e");
    assert.equal(rows[0]?.size, 3);

    const limited = fakeContext([page("a", "t1"), page("b")]);
    const one = await listObjects(limited.ctx, "bk", { limit: 1 });
    assert.equal(one.length, 1);
    assert.equal(limited.seen.length, 1);
    assert.match(limited.seen[0]?.url ?? "", /max-keys=1/);
  });

  it("sends the body and the hash of the body on upload", async () => {
    const { ctx, seen } = fakeContext([
      new Response("", { status: 200, headers: { etag: '"abc"' } }),
    ]);
    const row = await putObject(
      ctx,
      "bk",
      "dir/f.txt",
      new TextEncoder().encode("hi"),
      "text/plain",
    );
    assert.deepEqual(row, { bucket: "bk", key: "dir/f.txt", size: 2, etag: "abc" });
    assert.equal(seen[0]?.method, "PUT");
    assert.equal(seen[0]?.url, "http://s3.local:9000/bk/dir/f.txt");
    assert.equal(seen[0]?.headers["content-type"], "text/plain");
    // sha256("hi")
    assert.equal(
      seen[0]?.headers["x-amz-content-sha256"],
      "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
    );
  });

  it("shows the code and message of an S3 error", async () => {
    const { ctx } = fakeContext([
      xmlResponse(
        "<Error><Code>NoSuchBucket</Code><Message>The bucket does not exist</Message></Error>",
        404,
      ),
    ]);
    await assert.rejects(
      s3Send(ctx, { method: "GET", bucket: "x" }),
      /404 \(NoSuchBucket: The bucket does not exist\)/,
    );
  });
});

describe("s3 credential and node", () => {
  it("checks the credential data", () => {
    assert.equal(
      validateCredentialData("s3", { accessKeyId: "a", secretAccessKey: "b", region: "eu-1" }),
      null,
    );
    assert.match(
      validateCredentialData("s3", { accessKeyId: "a", secretAccessKey: "b", endpoint: "nope" }) ??
        "",
      /endpoint/,
    );
    assert.match(validateCredentialData("s3", { accessKeyId: "a" }) ?? "", /secretAccessKey/);
  });

  it("is in the registry with labels and hints for the operations", () => {
    const node = registry.get("s3.storage");
    assert.ok(node);
    assert.equal(node.credentialTypes?.[0], "s3");
    const parsed = node.config.parse({}) as { operation: string };
    assert.equal(parsed.operation, "listObjects");
    assert.equal(node.config.safeParse({ operation: "x" }).success, false);
  });
});
