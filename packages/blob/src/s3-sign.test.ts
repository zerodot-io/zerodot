// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
