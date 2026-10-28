// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { NodeDefinition, NodeResult, ResolvedCredential } from "@zerodot/engine";
import { validateCredentialData } from "./credentials";
import { registry } from "./index";
import { COMMANDS_ENV, FILES_ENV, resolveFilePath } from "./local-access";

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
