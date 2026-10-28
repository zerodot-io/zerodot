// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { mimeTypeOf, readBinary, toBinary } from "../binary";
import { callTelegram, downloadTelegramFile, TELEGRAM_CREDENTIAL, telegramAccess } from "./api";
import { telegramConfig } from "./config";
import { buildRequest } from "./request";
import { buildSendAndWait, waitDeadline, waitFormOf } from "./wait";

/** The name of the file field in the Bot API: `sendPhoto` has `photo`. */
const fileProperty = (operation: string) => operation.replace("send", "").toLowerCase();

/** The upload form of a call with binary data. Objects go in as JSON text. */
function uploadForm(
  body: Record<string, unknown>,
  property: string,
  file: { data: string; mimeType: string; fileName: string },
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  const bytes = Buffer.from(file.data, "base64");
  form.set(property, new Blob([bytes], { type: file.mimeType }), file.fileName);
  return form;
}

export default defineNode({
  type: "telegram.bot",
  label: "Telegram",
  description: "Send messages and manage chats with a Telegram bot",
  category: "integration",
  app: "Telegram",
  // The names of the actions of the Telegram node.
  actions: [
    { label: "Send a text message", config: { resource: "message", operation: "sendMessage" } },
    { label: "Edit a text message", config: { resource: "message", operation: "editMessageText" } },
    { label: "Delete a chat message", config: { resource: "message", operation: "deleteMessage" } },
    { label: "Pin a chat message", config: { resource: "message", operation: "pinChatMessage" } },
    {
      label: "Unpin a chat message",
      config: { resource: "message", operation: "unpinChatMessage" },
    },
    { label: "Send a photo", config: { resource: "message", operation: "sendPhoto" } },
    { label: "Send a video", config: { resource: "message", operation: "sendVideo" } },
    { label: "Send an audio file", config: { resource: "message", operation: "sendAudio" } },
    { label: "Send a document", config: { resource: "message", operation: "sendDocument" } },
    { label: "Send an animated file", config: { resource: "message", operation: "sendAnimation" } },
    { label: "Send a sticker", config: { resource: "message", operation: "sendSticker" } },
    { label: "Send a location", config: { resource: "message", operation: "sendLocation" } },
    { label: "Send a media group", config: { resource: "message", operation: "sendMediaGroup" } },
    { label: "Send a chat action", config: { resource: "message", operation: "sendChatAction" } },
    {
      label: "Send a message and wait for response",
      config: { resource: "message", operation: "sendAndWait" },
    },
    { label: "Get information about a chat", config: { resource: "chat", operation: "get" } },
    {
      label: "Get the administrators of a chat",
      config: { resource: "chat", operation: "administrators" },
    },
    { label: "Get a member of a chat", config: { resource: "chat", operation: "member" } },
    { label: "Leave a chat", config: { resource: "chat", operation: "leave" } },
    { label: "Set the title of a chat", config: { resource: "chat", operation: "setTitle" } },
    {
      label: "Set the description of a chat",
      config: { resource: "chat", operation: "setDescription" },
    },
    {
      label: "Answer a callback query",
      config: { resource: "callback", operation: "answerQuery" },
    },
    {
      label: "Answer an inline query",
      config: { resource: "callback", operation: "answerInlineQuery" },
    },
    { label: "Get a file", config: { resource: "file", operation: "get" } },
  ],
  icon: "Send",
  iconUrl: "/icons/telegram.svg",
  config: telegramConfig,
  defaultConfig: {
    resource: "message",
    operation: "sendMessage",
    chatId: "",
    text: "",
    replyMarkup: "none",
    additionalFields: {},
    timeoutMs: 30_000,
  },
  credentialTypes: [TELEGRAM_CREDENTIAL],
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.operation === "string"
      ? `${String(config.resource ?? "message")}: ${config.operation}`
      : undefined,
  waitForm: waitFormOf,
  async run({ config, input, credential, signal, resumeUrl }) {
    const access = telegramAccess(credential);
    const options = { signal, timeoutMs: config.timeoutMs };

    if (config.operation === "sendAndWait") {
      if (!resumeUrl) {
        throw new Error("This worker cannot ask for an answer. Set ZERODOT_BASE_URL on the worker");
      }
      const { method, body } = buildSendAndWait(config, resumeUrl);
      await callTelegram(access, method, body, options);
      // The run stops here. A person answers, or the time is over. Then this is the output.
      return { port: "out", data: { data: { timedOut: true } }, waitUntil: waitDeadline(config) };
    }

    const { method, body } = buildRequest(config);

    if (config.binaryData && config.resource === "message" && method !== "sendMessage") {
      const file = readBinary(input, config.binaryPropertyName);
      const fileName = config.additionalFields.fileName || file.fileName;
      if (!fileName) {
        throw new Error(
          `A file name is needed to ${config.operation}. Set "fileName" in additionalFields, or set it in the binary data`,
        );
      }
      const property = fileProperty(config.operation);
      // The file is in the form, so it replaces a URL or a file_id.
      delete body[property];
      const answer = await callTelegram(
        access,
        method,
        uploadForm(body, property, { ...file, fileName }),
        options,
      );
      return { port: "out", data: answer };
    }

    const answer = await callTelegram(access, method, body, options);

    if (config.resource === "file" && config.download) {
      const filePath = (answer.result as { file_path?: string } | undefined)?.file_path;
      if (!filePath) throw new Error("Telegram did not give a file path");
      const bytes = await downloadTelegramFile(access, filePath, options);
      const fileName = filePath.split("/").pop() ?? "file";
      const mimeType = config.additionalFields.mimeType || mimeTypeOf(fileName);
      return {
        port: "out",
        data: { ...answer, binary: { data: toBinary(bytes, fileName, mimeType) } },
      };
    }

    // The whole answer, except for the list of administrators.
    return { port: "out", data: config.operation === "administrators" ? answer.result : answer };
  },
});
