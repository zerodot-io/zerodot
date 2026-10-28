// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { registry, validateCredentialData } from "../index";
import type { TelegramConfig } from "./config";
import { telegramConfig } from "./config";
import { buildRequest } from "./request";
import { checkTelegramUpdate, telegramSecret } from "./trigger";

const signal = new AbortController().signal;
type Cred = { type: string; data: Record<string, unknown> };
const credential: Cred = { type: "telegram.bot", data: { accessToken: "T0K" } };

afterEach(() => mock.restoreAll());

const parse = (config: Record<string, unknown>): TelegramConfig => telegramConfig.parse(config);
const build = (config: Record<string, unknown>) => buildRequest(parse(config));

function node(type: string) {
  const definition = registry.get(type);
  if (!definition) throw new Error(`missing ${type}`);
  return definition;
}

describe("telegram request builder", () => {
  it("sends a message: Markdown, no preview without a URL", () => {
    const { method, body } = build({ operation: "sendMessage", chatId: "42", text: "hi" });
    assert.equal(method, "sendMessage");
    assert.deepEqual(body, {
      chat_id: "42",
      text: "hi",
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    });
  });

  it("lets additional fields win", () => {
    const { body } = build({
      operation: "sendMessage",
      chatId: 1,
      text: "see https://a.io",
      additionalFields: {
        parse_mode: "HTML",
        disable_web_page_preview: false,
        message_thread_id: 3,
      },
    });
    assert.equal(body.parse_mode, "HTML");
    assert.equal(body.disable_web_page_preview, false);
    assert.equal(body.message_thread_id, 3);
  });

  it("builds an inline keyboard from rows.row.buttons", () => {
    const { body } = build({
      operation: "sendMessage",
      chatId: 1,
      text: "x",
      replyMarkup: "inlineKeyboard",
      inlineKeyboard: {
        rows: [
          {
            row: {
              buttons: [{ text: "A", additionalFields: { callback_data: "a" } }, { text: "B" }],
            },
          },
        ],
      },
    });
    assert.deepEqual(body.reply_markup, {
      inline_keyboard: [[{ text: "A", callback_data: "a" }, { text: "B" }]],
    });
  });

  it("adds options to a reply keyboard", () => {
    const { body } = build({
      operation: "sendPhoto",
      chatId: 1,
      file: "https://a.io/p.png",
      replyMarkup: "replyKeyboard",
      replyKeyboard: { rows: [{ row: { buttons: [{ text: "Yes" }] } }] },
      replyKeyboardOptions: { resize_keyboard: true },
    });
    assert.equal(body.photo, "https://a.io/p.png");
    assert.deepEqual(body.reply_markup, { keyboard: [[{ text: "Yes" }]], resize_keyboard: true });
  });

  it("maps every operation to its Bot API method", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ operation: "editMessageText", chatId: 1, messageId: 2, text: "t" }, "editMessageText"],
      [{ operation: "deleteMessage", chatId: 1, messageId: 2 }, "deleteMessage"],
      [{ operation: "pinChatMessage", chatId: 1, messageId: 2 }, "pinChatMessage"],
      [{ operation: "unpinChatMessage", chatId: 1, messageId: 2 }, "unpinChatMessage"],
      [{ operation: "sendChatAction", chatId: 1, action: "typing" }, "sendChatAction"],
      [{ operation: "sendLocation", chatId: 1, latitude: 1, longitude: 2 }, "sendLocation"],
      [{ operation: "sendVideo", chatId: 1, file: "f" }, "sendVideo"],
      [{ operation: "sendAudio", chatId: 1, file: "f" }, "sendAudio"],
      [{ operation: "sendDocument", chatId: 1, file: "f" }, "sendDocument"],
      [{ operation: "sendAnimation", chatId: 1, file: "f" }, "sendAnimation"],
      [{ operation: "sendSticker", chatId: 1, file: "f" }, "sendSticker"],
      [{ resource: "chat", operation: "get", chatId: 1 }, "getChat"],
      [{ resource: "chat", operation: "administrators", chatId: 1 }, "getChatAdministrators"],
      [{ resource: "chat", operation: "member", chatId: 1, userId: 9 }, "getChatMember"],
      [{ resource: "chat", operation: "leave", chatId: 1 }, "leaveChat"],
      [{ resource: "chat", operation: "setTitle", chatId: 1, title: "t" }, "setChatTitle"],
      [
        { resource: "chat", operation: "setDescription", chatId: 1, description: "d" },
        "setChatDescription",
      ],
      [{ resource: "callback", operation: "answerQuery", queryId: "q" }, "answerCallbackQuery"],
      [
        { resource: "callback", operation: "answerInlineQuery", queryId: "q", results: "[]" },
        "answerInlineQuery",
      ],
      [{ resource: "file", operation: "get", fileId: "f" }, "getFile"],
    ];
    for (const [config, method] of cases) assert.equal(build(config).method, method, method);
  });

  it("merges media group items", () => {
    const { body } = build({
      operation: "sendMediaGroup",
      chatId: 1,
      media: { media: [{ type: "photo", media: "u", additionalFields: { caption: "c" } }] },
    });
    assert.deepEqual(body.media, [{ type: "photo", media: "u", caption: "c" }]);
  });

  it("pins with a silent flag only when set", () => {
    const quiet = build({
      operation: "pinChatMessage",
      chatId: 1,
      messageId: 2,
      additionalFields: { disable_notification: true },
    });
    assert.equal(quiet.body.disable_notification, true);
    assert.equal(
      "disable_notification" in
        build({ operation: "pinChatMessage", chatId: 1, messageId: 2 }).body,
      false,
    );
  });

  it("needs the fields of the operation", () => {
    assert.throws(() => build({ operation: "deleteMessage", chatId: 1 }), /messageId/);
    assert.throws(() => build({ operation: "sendMessage", text: "x" }), /chatId/);
  });

  it("rejects an operation that the resource does not have", () => {
    assert.equal(
      telegramConfig.safeParse({ resource: "chat", operation: "sendMessage" }).success,
      false,
    );
  });
});

describe("telegram.bot", () => {
  const run = async (config: Record<string, unknown>, cred: Cred | null = credential) =>
    await node("telegram.bot").run({
      config: parse(config),
      input: null,
      credential: cred,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });

  it("returns the whole answer", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } })),
    );
    const result = await run({ operation: "sendMessage", chatId: "42", text: "hi" });
    assert.equal(
      fetchMock.mock.calls[0]?.arguments[0],
      "https://api.telegram.org/botT0K/sendMessage",
    );
    assert.deepEqual(result, { port: "out", data: { ok: true, result: { message_id: 7 } } });
  });

  it("returns the list of administrators", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ ok: true, result: [{ status: "creator" }] })),
    );
    const result = await run({ resource: "chat", operation: "administrators", chatId: 1 });
    assert.deepEqual(result.data, [{ status: "creator" }]);
  });

  it("uses the base URL of the credential", async () => {
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async () => new Response(JSON.stringify({ ok: true, result: true })),
    );
    await run(
      { operation: "deleteMessage", chatId: 1, messageId: 2 },
      { type: "telegram.bot", data: { accessToken: "T0K", baseUrl: "https://bot.example.com/" } },
    );
    assert.equal(
      fetchMock.mock.calls[0]?.arguments[0],
      "https://bot.example.com/botT0K/deleteMessage",
    );
  });

  it("hides the token when the API fails", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }),
    );
    await assert.rejects(
      run({ operation: "sendMessage", chatId: "1", text: "x" }),
      (error: Error) => error.message.includes("chat not found") && !error.message.includes("T0K"),
    );
  });

  it("needs a credential", async () => {
    await assert.rejects(
      run({ operation: "sendMessage", chatId: "1", text: "x" }, null),
      /credential/,
    );
  });

  it("checks the credential fields", () => {
    assert.equal(validateCredentialData("telegram.bot", { accessToken: "x" }), null);
    assert.match(String(validateCredentialData("telegram.bot", {})), /accessToken/);
    assert.match(
      String(validateCredentialData("telegram.bot", { accessToken: "x", baseUrl: "no" })),
      /baseUrl/,
    );
  });
});

describe("trigger.telegram", () => {
  const secret = telegramSecret("tok");
  const headers = { "x-telegram-bot-api-secret-token": secret };
  const update = { message: { chat: { id: 5 }, from: { id: 9 }, text: "hi" } };

  it("is a trigger of the webhook kind", () => {
    const definition = node("trigger.telegram");
    assert.equal(definition.category, "trigger");
    assert.deepEqual(definition.ports.in, []);
  });

  it("passes the update through", async () => {
    const result = await node("trigger.telegram").run({
      config: { updates: ["message"], additionalFields: {} },
      input: { method: "POST", headers, query: {}, body: update },
      credential: null,
      signal,
      scope: {},
      sandbox: null,
      tables: null,
    });
    assert.deepEqual(result, { port: "out", data: update });
  });

  it("makes a secret that Telegram accepts", () => {
    assert.match(secret, /^[A-Za-z0-9_-]{1,256}$/);
    assert.notEqual(secret, telegramSecret("other"));
  });

  it("refuses a wrong or missing secret", () => {
    const check = (h: Record<string, string>) =>
      checkTelegramUpdate({}, { token: "tok", headers: h, body: update });
    assert.equal(check({}), "forbidden");
    assert.equal(check({ "x-telegram-bot-api-secret-token": "nope" }), "forbidden");
    assert.equal(check(headers), "accept");
  });

  it("filters by chat and by user", () => {
    const check = (additionalFields: Record<string, string>) =>
      checkTelegramUpdate({ additionalFields }, { token: "tok", headers, body: update });
    assert.equal(check({ chatIds: "1, 5" }), "accept");
    assert.equal(check({ chatIds: "1,2" }), "ignore");
    assert.equal(check({ userIds: "9" }), "accept");
    assert.equal(check({ userIds: "8" }), "ignore");
  });
});
