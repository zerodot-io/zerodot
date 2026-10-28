// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { diskBlobStore } from "./disk";
import { blobSetupFromEnv } from "./env";
import { s3BlobStore } from "./s3";

const RUN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("diskBlobStore", () => {
  let dir = "";
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("puts, gets, lists and deletes", async () => {
    dir = await mkdtemp(join(tmpdir(), "zerodot-blob-"));
    const store = diskBlobStore(dir);
    const ref = await store.put(RUN, Buffer.from("hello"), "text/plain");
    assert.equal(ref.size, 5);
    assert.equal(ref.mimeType, "text/plain");
    assert.equal(Buffer.from(await store.get(ref)).toString(), "hello");
    // The same bytes in the same run: the same blob, one file.
    assert.equal((await store.put(RUN, Buffer.from("hello"), "text/plain")).$blob, ref.$blob);
    assert.equal((await readdir(join(dir, RUN))).length, 1);
    await store.put(OTHER, Buffer.from("x"), "text/plain");
    assert.deepEqual((await store.listRunIds()).sort(), [RUN, OTHER]);
    await store.deleteRun(RUN);
    assert.deepEqual(await store.listRunIds(), [OTHER]);
    await assert.rejects(store.get(ref));
    await store.deleteRun(RUN);
  });

  it("refuses an id that leaves the directory", async () => {
    dir = await mkdtemp(join(tmpdir(), "zerodot-blob-"));
    const store = diskBlobStore(dir);
    await assert.rejects(store.get({ $blob: "../../etc/passwd", mimeType: "x", size: 1 }));
    await assert.rejects(store.deleteRun("../x"));
  });

  it("lists nothing when the directory does not exist", async () => {
    assert.deepEqual(await diskBlobStore(join(tmpdir(), "zerodot-no-such-dir")).listRunIds(), []);
  });
});

describe("s3BlobStore", () => {
  type Call = { method: string; url: URL; headers: Record<string, string>; body?: Uint8Array };
  const objects = new Map<string, Uint8Array>();
  const calls: Call[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? new Uint8Array(init.body as Buffer) : undefined;
    calls.push({ method, url, headers: init?.headers as Record<string, string>, body });
    // Path style: /bucket/key
    const key = decodeURIComponent(url.pathname.replace(/^\/bkt\/?/, ""));
    if (method === "PUT" && body) {
      objects.set(key, body);
      return new Response(null, { status: 200, headers: { etag: '"e"' } });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      const names = [...objects.keys()].filter((k) => k.startsWith(prefix));
      if (delimiter) {
        const folders = new Set(names.map((k) => k.slice(0, k.indexOf("/", prefix.length) + 1)));
        const xml = [...folders].map(
          (f) => `<CommonPrefixes><Prefix>${f}</Prefix></CommonPrefixes>`,
        );
        return new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${xml.join("")}</ListBucketResult>`,
        );
      }
      const xml = names.map((k) => `<Contents><Key>${k}</Key><Size>1</Size></Contents>`);
      return new Response(
        `<ListBucketResult><IsTruncated>false</IsTruncated>${xml.join("")}</ListBucketResult>`,
      );
    }
    const found = objects.get(key);
    return found
      ? new Response(Buffer.from(found))
      : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  };
  const store = s3BlobStore({
    target: { endpoint: new URL("http://s3.test"), region: "us-east-1", pathStyle: true },
    keys: { accessKeyId: "k", secretAccessKey: "s" },
    bucket: "bkt",
    prefix: "zerodot/",
    fetch: fakeFetch,
  });

  it("puts, gets, lists and deletes signed requests", async () => {
    const ref = await store.put(RUN, Buffer.from("data"), "image/png");
    assert.deepEqual(
      [...objects.keys()],
      [ref.$blob].map((id) => `zerodot/${id}`),
    );
    const put = calls.find((c) => c.method === "PUT");
    assert.match(put?.headers.authorization ?? "", /^AWS4-HMAC-SHA256 Credential=k\//);
    assert.equal(put?.headers["content-type"], "image/png");
    assert.equal(Buffer.from(await store.get(ref)).toString(), "data");
    await store.put(OTHER, Buffer.from("x"), "text/plain");
    assert.deepEqual((await store.listRunIds()).sort(), [RUN, OTHER]);
    await store.deleteRun(RUN);
    assert.deepEqual(await store.listRunIds(), [OTHER]);
  });

  it("refuses a forged id that leaves the prefix", async () => {
    const before = calls.length;
    for (const id of ["../../other/secret.txt", `${RUN}/../../x`, "secret.txt"]) {
      await assert.rejects(store.get({ $blob: id, mimeType: "text/plain", size: 1 }), /Invalid/);
    }
    assert.equal(calls.length, before);
  });
});

describe("blobSetupFromEnv", () => {
  it("is off without a directory or a bucket", () => {
    assert.equal(blobSetupFromEnv({}), null);
    assert.equal(blobSetupFromEnv({ ZERODOT_BLOB_DIR: "  " }), null);
  });

  it("uses a directory and the default inline size", () => {
    const setup = blobSetupFromEnv({ ZERODOT_BLOB_DIR: "/tmp/x" });
    assert.equal(setup?.inlineBytes, 256 * 1024);
  });

  it("reads the inline size and rejects a bad one", () => {
    assert.equal(
      blobSetupFromEnv({ ZERODOT_BLOB_DIR: "/tmp/x", ZERODOT_INLINE_OUTPUT_BYTES: "1000" })
        ?.inlineBytes,
      1000,
    );
    assert.throws(() =>
      blobSetupFromEnv({ ZERODOT_BLOB_DIR: "/tmp/x", ZERODOT_INLINE_OUTPUT_BYTES: "abc" }),
    );
  });

  it("S3 needs keys and wins over the directory", () => {
    assert.throws(() => blobSetupFromEnv({ ZERODOT_BLOB_S3_BUCKET: "b" }), /ACCESS_KEY_ID/);
    const setup = blobSetupFromEnv({
      ZERODOT_BLOB_DIR: "/tmp/x",
      ZERODOT_BLOB_S3_BUCKET: "b",
      ZERODOT_BLOB_S3_ACCESS_KEY_ID: "k",
      ZERODOT_BLOB_S3_SECRET_ACCESS_KEY: "s",
      ZERODOT_BLOB_S3_ENDPOINT: "http://localhost:9000",
    });
    assert.ok(setup);
  });
});
