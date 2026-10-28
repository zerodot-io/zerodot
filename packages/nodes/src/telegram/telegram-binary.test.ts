// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { registry } from "../index";
import { telegramConfig } from "./config";
import { attachmentOf } from "./trigger";
import { buildSendAndWait, waitFormOf } from "./wait";

const signal = new AbortController().signal;
const credential = { type: "telegram.bot", data: { accessToken: "T0K" } };

afterEach(() => mock.restoreAll());

function node(type: string) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  return definition;
}

const run = async (
  type: string,
  config: Record<string, unknown>,
  input: unknown = null,
  resumeUrl: string | null = null,
) =>
  await node(type).run({
    config: node(type).config.parse(config),
    input,
    credential,
    signal,
    scope: {},
    sandbox: null,
    tables: null,
    resumeUrl,
  });

const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));

describe("telegram binary data", () => {
  const input = {
    binary: {
      data: {
        data: Buffer.from("hello").toString("base64"),
        mimeType: "text/plain",
        fileName: "a.txt",
      },
    },
  };

  it("uploads the binary data as a form", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ok({ message_id: 1 }));
    await run(
      "telegram.bot",
      {
        operation: "sendDocument",
        chatId: "1",
        binaryData: true,
        additionalFields: { caption: "c" },
      },
      input,
    );
    const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
    const form = init.body as FormData;
    assert.equal(form.get("chat_id"), "1");
    assert.equal(form.get("caption"), "c");
    const file = form.get("document") as File;
    assert.equal(file.name, "a.txt");
    assert.equal(await file.text(), "hello");
    assert.equal(init.headers, undefined);
  });

  it("needs a file name", async () => {
    const noName = { binary: { data: { data: "aA==", mimeType: "text/plain" } } };
    await assert.rejects(
      run("telegram.bot", { operation: "sendPhoto", chatId: 1, binaryData: true }, noName),
      /file name/,
    );
  });

  it("needs the property in the input", async () => {
    await assert.rejects(
      run("telegram.bot", { operation: "sendPhoto", chatId: 1, binaryData: true }, {}),
      /binary data/,
    );
  });

  it("downloads a file into binary data", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
      String(url).includes("/file/")
        ? new Response("PNGDATA")
        : ok({ file_id: "f", file_path: "photos/p.png" }),
    );
    const result = await run("telegram.bot", {
      resource: "file",
      operation: "get",
      fileId: "f",
      download: true,
    });
    assert.equal(
      fetchMock.mock.calls[1]?.arguments[0],
      "https://api.telegram.org/file/botT0K/photos/p.png",
    );
    const data = result.data as {
      result: unknown;
      binary: { data: { data: string; mimeType: string; fileName: string } };
    };
    assert.equal(Buffer.from(data.binary.data.data, "base64").toString(), "PNGDATA");
    assert.equal(data.binary.data.mimeType, "image/png");
    assert.equal(data.binary.data.fileName, "p.png");
  });

  it("does not put the token in a download error", async () => {
    mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
      String(url).includes("/file/")
        ? new Response("no", { status: 404 })
        : ok({ file_path: "x/y.png" }),
    );
    await assert.rejects(
      run("telegram.bot", { resource: "file", operation: "get", fileId: "f", download: true }),
      (error: Error) => /404/.test(error.message) && !error.message.includes("T0K"),
    );
  });
});

describe("telegram sendAndWait", () => {
  const base = { operation: "sendAndWait", chatId: 1, message: "Ship it?" };

  it("sends link buttons and waits", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => ok({}));
    const before = Date.now();
    const result = await run(
      "telegram.bot",
      { ...base, approvalOptions: { approvalType: "double" } },
      null,
      "https://p.io/resume/r/n?sig=s",
    );
    const init = fetchMock.mock.calls[0]?.arguments[1] as RequestInit;
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.reply_markup.inline_keyboard, [
      [
        { text: "Approve", url: "https://p.io/resume/r/n?sig=s&approved=true" },
        { text: "Decline", url: "https://p.io/resume/r/n?sig=s&approved=false" },
      ],
    ]);
    assert.equal(result.port, "out");
    assert.deepEqual(result.data, { data: { timedOut: true } });
    assert.ok((result.waitUntil ?? 0) >= before + 167 * 3_600_000);
  });

  it("limits the wait", async () => {
    mock.method(globalThis, "fetch", async () => ok({}));
    const result = await run(
      "telegram.bot",
      { ...base, options: { limitWaitTimeHours: 1 } },
      null,
      "https://p.io/r?sig=s",
    );
    assert.ok((result.waitUntil ?? 0) <= Date.now() + 3_600_000);
  });

  it("needs a resume address", async () => {
    await assert.rejects(run("telegram.bot", base), /ZERODOT_BASE_URL/);
  });

  it("has one button for a form", () => {
    const config = telegramConfig.parse({
      ...base,
      responseType: "freeText",
      options: { messageButtonLabel: "Reply" },
    });
    const { body } = buildSendAndWait(config, "https://p.io/r?sig=s");
    assert.deepEqual((body.reply_markup as { inline_keyboard: unknown }).inline_keyboard, [
      [{ text: "Reply", url: "https://p.io/r?sig=s" }],
    ]);
  });

  it("describes the form of the resume page", () => {
    assert.equal(waitFormOf({ responseType: "approval" }), null);
    assert.equal(waitFormOf({ responseType: "freeText" })?.fields[0]?.key, "text");
    const custom = waitFormOf({ responseType: "customForm", formFields: [{ fieldLabel: "Name" }] });
    assert.equal(custom?.fields[0]?.fieldLabel, "Name");
  });
});

describe("trigger.telegram download", () => {
  it("finds the photo size, or another file", () => {
    const photo = { message: { photo: [{ file_id: "s" }, { file_id: "m" }] } };
    assert.equal(attachmentOf(photo, "small")?.fileId, "s");
    assert.equal(attachmentOf(photo, "extraLarge")?.fileId, "m");
    const doc = {
      message: { document: { file_id: "d", file_name: "a.pdf", mime_type: "application/pdf" } },
    };
    assert.deepEqual(attachmentOf(doc, "large"), {
      fileId: "d",
      fileName: "a.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(attachmentOf({ message: { text: "hi" } }, "large"), null);
  });

  it("adds the file to the output", async () => {
    mock.method(globalThis, "fetch", async (url: string | URL | Request) =>
      String(url).includes("/file/") ? new Response("IMG") : ok({ file_path: "photos/a.jpg" }),
    );
    const update = { message: { photo: [{ file_id: "x" }] } };
    const result = await run(
      "trigger.telegram",
      { updates: ["message"], additionalFields: { download: true } },
      { body: update },
    );
    const data = result.data as { binary: { data: { data: string; mimeType: string } } };
    assert.equal(Buffer.from(data.binary.data.data, "base64").toString(), "IMG");
    assert.equal(data.binary.data.mimeType, "image/jpeg");
  });
});
