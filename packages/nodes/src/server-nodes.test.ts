// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { NodeDefinition, NodeResult, ResolvedCredential } from "@zerodot/engine";
import { BSON } from "mongodb";
import { validateCredentialData } from "./credentials";
import { registry } from "./index";
import { COMMANDS_ENV, FILES_ENV, resolveFilePath } from "./local-access";
import { type MongoCollection, runMongoOperation } from "./mongodb";
import { type RemoteFs, runRemoteOperation } from "./remote-files";
import { sshOptions } from "./ssh";

async function run(
  type: string,
  config: Record<string, unknown>,
  input: unknown = {},
  credential: ResolvedCredential | null = null,
): Promise<NodeResult> {
  const definition = registry.get(type) as NodeDefinition;
  assert.ok(definition, type);
  return await definition.run({
    config: definition.config.parse(config),
    input,
    credential,
    signal: new AbortController().signal,
    scope: {},
    sandbox: null,
    tables: null,
  });
}

const saved = { commands: process.env[COMMANDS_ENV], files: process.env[FILES_ENV] };
afterEach(() => {
  for (const [name, value] of [
    [COMMANDS_ENV, saved.commands],
    [FILES_ENV, saved.files],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("Execute Command", () => {
  it("is off until the operator turns it on", async () => {
    delete process.env[COMMANDS_ENV];
    await assert.rejects(run("core.execute_command", { command: "echo hi" }), /is off/);
  });

  it("gives the exit code, stdout, and stderr", async () => {
    process.env[COMMANDS_ENV] = "true";
    const ok = await run("core.execute_command", { command: "echo hi" });
    assert.deepEqual(ok.data, { exitCode: 0, stdout: "hi\n", stderr: "" });
    const bad = await run("core.execute_command", { command: "echo oops >&2; exit 3" });
    assert.deepEqual(bad.data, { exitCode: 3, stdout: "", stderr: "oops\n" });
    await assert.rejects(
      run("core.execute_command", { command: "exit 2", failOnError: true }),
      /exited with code 2/,
    );
  });

  it("stops a command that takes too long", async () => {
    process.env[COMMANDS_ENV] = "true";
    await assert.rejects(
      run("core.execute_command", { command: "sleep 5", timeoutMs: 100 }),
      /took longer than 100 ms/,
    );
  });
});

describe("Read/Write Files from Disk", () => {
  const folder = async () => {
    const dir = await mkdtemp(join(tmpdir(), "zerodot-files-"));
    process.env[FILES_ENV] = dir;
    return dir;
  };

  it("is off without ZERODOT_FILES_DIR", async () => {
    delete process.env[FILES_ENV];
    await assert.rejects(run("file.disk", { path: "a.txt" }), /File access is off/);
  });

  it("writes, appends, and reads a file", async () => {
    const dir = await folder();
    const binary = {
      data: { data: Buffer.from("one").toString("base64"), mimeType: "text/plain" },
    };
    const written = await run("file.disk", { operation: "write", path: "out/a.txt" }, { binary });
    assert.deepEqual(written.data, { path: "out/a.txt", size: 3 });
    await run(
      "file.disk",
      { operation: "write", path: "out/a.txt", append: true },
      { binary: { data: { data: Buffer.from("two").toString("base64") } } },
    );
    assert.equal(await readFile(join(dir, "out/a.txt"), "utf8"), "onetwo");
    const read = await run("file.disk", { path: "out/a.txt" });
    const file = (read.data as { binary: { data: { data: string; fileName: string } } }).binary
      .data;
    assert.equal(Buffer.from(file.data, "base64").toString(), "onetwo");
    assert.equal(file.fileName, "a.txt");
    await assert.rejects(run("file.disk", { path: "missing.txt" }), /does not exist/);
  });

  it("refuses a path outside the folder", async () => {
    const dir = await folder();
    await assert.rejects(resolveFilePath("../x"), /outside/);
    await assert.rejects(resolveFilePath("/etc/passwd"), /outside/);
    const outside = await mkdtemp(join(tmpdir(), "zerodot-outside-"));
    await writeFile(join(outside, "secret.txt"), "s");
    await mkdir(join(dir, "sub"));
    await symlink(outside, join(dir, "sub/link"));
    await assert.rejects(resolveFilePath("sub/link/secret.txt"), /outside/);
    assert.equal(
      await resolveFilePath("sub/new/file.txt"),
      join(await realDir(dir), "sub/new/file.txt"),
    );
  });
});

async function realDir(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}

describe("FTP and SFTP operations", () => {
  const calls: string[] = [];
  const fs: RemoteFs = {
    async list(path, recursive) {
      calls.push(`list ${path} ${recursive}`);
      return [{ name: "a", path: `${path}/a`, type: "file", size: 1, modifiedAt: null }];
    },
    async download(path) {
      calls.push(`download ${path}`);
      return Buffer.from("body");
    },
    async upload(path, bytes) {
      calls.push(`upload ${path} ${bytes.length}`);
    },
    async remove(path, folder, recursive) {
      calls.push(`remove ${path} ${folder} ${recursive}`);
    },
    async rename(from, to) {
      calls.push(`rename ${from} ${to}`);
    },
    async close() {},
  };
  const base = {
    operation: "list",
    path: "/",
    property: "data",
    recursive: false,
    folder: false,
  } as const;
  const input = {
    binary: { data: { data: Buffer.from("xyz").toString("base64"), fileName: "f.txt" } },
  };

  it("lists, downloads, uploads, renames, and deletes", async () => {
    const listed = (await runRemoteOperation(fs, { ...base, path: "/d", recursive: true }, {})) as {
      items: unknown[];
    };
    assert.equal(listed.items.length, 1);
    const down = (await runRemoteOperation(
      fs,
      { ...base, operation: "download", path: "/d/a.txt" },
      {},
    )) as {
      binary: { data: { data: string; fileName: string } };
    };
    assert.equal(Buffer.from(down.binary.data.data, "base64").toString(), "body");
    assert.equal(down.binary.data.fileName, "a.txt");
    // A path with / at the end is a folder. The file keeps its name.
    assert.deepEqual(
      await runRemoteOperation(fs, { ...base, operation: "upload", path: "/in/" }, input),
      {
        path: "/in/f.txt",
        size: 3,
      },
    );
    await runRemoteOperation(fs, { ...base, operation: "rename", path: "/a", newPath: "/b" }, {});
    await runRemoteOperation(
      fs,
      { ...base, operation: "delete", path: "/b", folder: true, recursive: true },
      {},
    );
    assert.deepEqual(calls, [
      "list /d true",
      "download /d/a.txt",
      "upload /in/f.txt 3",
      "rename /a /b",
      "remove /b true true",
    ]);
    await assert.rejects(
      runRemoteOperation(fs, { ...base, operation: "rename", path: "/a" }, {}),
      /new path/,
    );
  });
});

describe("SSH credential", () => {
  it("builds the connection settings", () => {
    const password = sshOptions({ type: "ssh", data: { host: "h", username: "u", password: "p" } });
    assert.equal(password.port, 22);
    assert.equal(password.password, "p");
    const key = sshOptions({
      type: "ssh",
      data: {
        host: "h",
        port: "2222",
        username: "u",
        authType: "privateKey",
        privateKey: "K",
        passphrase: "x",
      },
    });
    assert.equal(key.port, 2222);
    assert.equal(key.privateKey, "K");
    assert.equal(key.passphrase, "x");
    assert.throws(
      () => sshOptions({ type: "ssh", data: { host: "h", username: "u", authType: "privateKey" } }),
      /privateKey/,
    );
    assert.equal(validateCredentialData("ssh", { host: "h", username: "u" }), null);
    assert.equal(validateCredentialData("ftp", { host: "h" }), null);
    assert.match(
      validateCredentialData("mongodb", { connectionString: "http://x", database: "d" }) ?? "",
      /mongodb/,
    );
  });
});

describe("MongoDB operations", () => {
  const bson = BSON as unknown as Parameters<typeof runMongoOperation>[0];
  const id = new BSON.ObjectId("65f0c0c0c0c0c0c0c0c0c0c0");
  const seen: unknown[] = [];
  const collection = {
    find: (query: object, options: object) => {
      seen.push(["find", query, options]);
      return { toArray: async () => [{ _id: id, at: new Date("2026-10-26T00:00:00Z"), n: 1 }] };
    },
    insertMany: async (documents: object[]) => {
      seen.push(["insert", documents]);
      return { insertedIds: { 0: id } };
    },
    updateMany: async (query: object, update: object, options: object) => {
      seen.push(["update", query, update, options]);
      return { matchedCount: 2, modifiedCount: 1 };
    },
    deleteMany: async (query: object) => {
      seen.push(["delete", query]);
      return { deletedCount: 4 };
    },
    aggregate: (pipeline: object[]) => {
      seen.push(["aggregate", pipeline]);
      return { toArray: async () => [{ total: 3 }] };
    },
    findOneAndUpdate: async () => ({ _id: id }),
    findOneAndReplace: async () => null,
  } as unknown as MongoCollection;
  const base = {
    operation: "find",
    collection: "c",
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
  } as const;

  it("finds documents and gives plain JSON", async () => {
    const out = await runMongoOperation(bson, collection, {
      ...base,
      query: '{"_id": {"$oid": "65f0c0c0c0c0c0c0c0c0c0c0"}}',
      sort: '{"n": -1}',
      limit: 5,
    });
    assert.deepEqual(out, {
      items: [{ _id: "65f0c0c0c0c0c0c0c0c0c0c0", at: "2026-10-26T00:00:00Z", n: 1 }],
    });
    const [, query, options] = seen[0] as [string, { _id: unknown }, object];
    assert.ok(query._id instanceof BSON.ObjectId);
    assert.deepEqual(options, {
      sort: { n: -1 },
      projection: undefined,
      limit: 5,
      skip: undefined,
    });
  });

  it("inserts, updates, deletes, and aggregates", async () => {
    assert.deepEqual(
      await runMongoOperation(bson, collection, {
        ...base,
        operation: "insert",
        documents: '{"a": 1}',
      }),
      { insertedCount: 1, insertedIds: { 0: "65f0c0c0c0c0c0c0c0c0c0c0" } },
    );
    assert.deepEqual(
      await runMongoOperation(bson, collection, {
        ...base,
        operation: "update",
        query: '{"a": 1}',
        update: '{"$set": {"a": 2}}',
        upsert: true,
      }),
      { matchedCount: 2, modifiedCount: 1, upsertedId: null },
    );
    assert.deepEqual(
      await runMongoOperation(bson, collection, {
        ...base,
        operation: "delete",
        query: '{"a": 1}',
      }),
      { deletedCount: 4 },
    );
    assert.deepEqual(
      await runMongoOperation(bson, collection, {
        ...base,
        operation: "aggregate",
        pipeline: '[{"$count": "total"}]',
      }),
      { items: [{ total: 3 }] },
    );
    assert.deepEqual(
      await runMongoOperation(bson, collection, {
        ...base,
        operation: "findOneAndUpdate",
        update: "{}",
      }),
      { document: { _id: "65f0c0c0c0c0c0c0c0c0c0c0" } },
    );
  });

  it("names the field that is not valid", async () => {
    await assert.rejects(
      runMongoOperation(bson, collection, { ...base, query: "{oops" }),
      /Query is not valid JSON/,
    );
    await assert.rejects(
      runMongoOperation(bson, collection, { ...base, query: "[1]" }),
      /Query must be a JSON object/,
    );
    await assert.rejects(
      runMongoOperation(bson, collection, { ...base, operation: "insert", documents: "[1]" }),
      /Documents must hold JSON objects/,
    );
  });
});

describe("Edit Image", () => {
  const png = async (width: number, height: number) => {
    const { default: sharp } = await import("sharp");
    const bytes = await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    return {
      binary: {
        data: { data: bytes.toString("base64"), mimeType: "image/png", fileName: "a.png" },
      },
    };
  };
  const info = async (data: unknown) => {
    const out = (await run("file.edit_image", { operation: "info" }, data)).data as {
      width: number;
      height: number;
      format: string;
    };
    return { width: out.width, height: out.height, format: out.format };
  };

  it("gives the size and format", async () => {
    assert.deepEqual(await info(await png(40, 20)), {
      width: 40,
      height: 20,
      format: "png",
    });
  });

  it("resizes, crops, rotates, and converts", async () => {
    const input = await png(40, 20);
    const resized = await run("file.edit_image", { operation: "resize", width: 20 }, input);
    assert.deepEqual(await info(resized.data), { width: 20, height: 10, format: "png" });
    const cropped = await run(
      "file.edit_image",
      { operation: "crop", left: 5, top: 5, width: 10, height: 10 },
      input,
    );
    assert.deepEqual(await info(cropped.data), { width: 10, height: 10, format: "png" });
    const rotated = await run("file.edit_image", { operation: "rotate", degrees: 90 }, input);
    assert.deepEqual(await info(rotated.data), { width: 20, height: 40, format: "png" });
    const converted = await run("file.edit_image", { operation: "convert", format: "jpeg" }, input);
    assert.deepEqual(await info(converted.data), { width: 40, height: 20, format: "jpeg" });
    const file = (converted.data as { binary: { data: { fileName: string; mimeType: string } } })
      .binary.data;
    assert.equal(file.fileName, "a.jpg");
    assert.equal(file.mimeType, "image/jpeg");
  });

  it("refuses bad input", async () => {
    const input = await png(40, 20);
    await assert.rejects(
      run("file.edit_image", { operation: "crop", left: 30, width: 20, height: 10 }, input),
      /outside the image/,
    );
    await assert.rejects(
      run("file.edit_image", { operation: "resize" }, input),
      /width or a height/,
    );
    await assert.rejects(
      run(
        "file.edit_image",
        { operation: "info" },
        {
          binary: { data: { data: Buffer.from("not an image").toString("base64") } },
        },
      ),
      /not an image/,
    );
  });
});
