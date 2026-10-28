// SPDX-License-Identifier: AGPL-3.0-only
import type { TelegramConfig } from "./config";

export type TelegramRequest = { method: string; body: Record<string, unknown> };

const FILE_FIELD: Record<string, string> = {
  sendPhoto: "photo",
  sendVideo: "video",
  sendAudio: "audio",
  sendDocument: "document",
  sendAnimation: "animation",
  sendSticker: "sticker",
};

const URL_IN_TEXT = /(https?|ftp|file):\/\/\S+|www\.\S+|\S+\.\S+/;

type Button = { text: string; additionalFields?: Record<string, unknown> };
type Keyboard = { rows: { row: { buttons: Button[] } }[] };

function keyboardRows(keyboard: Keyboard | undefined): Record<string, unknown>[][] {
  return (keyboard?.rows ?? []).map(({ row }) =>
    row.buttons.map(({ text, additionalFields }) => ({ text, ...additionalFields })),
  );
}

/** Adds the optional fields of a request, without an attribution footer. */
function addAdditionalFields(body: Record<string, unknown>, config: TelegramConfig) {
  const { operation } = config;
  const fields: Record<string, unknown> = { ...config.additionalFields };

  if (operation === "sendMessage") {
    fields.parse_mode ??= "Markdown";
    if (!URL_IN_TEXT.test(String(body.text ?? ""))) body.disable_web_page_preview = true;
    fields.disable_web_page_preview ??= true;
  }
  Object.assign(body, fields);

  if (operation === "sendMediaGroup") return;
  const { replyMarkup } = config;
  if (replyMarkup === "none") return;

  if (replyMarkup === "inlineKeyboard") {
    body.reply_markup = { inline_keyboard: keyboardRows(config.inlineKeyboard) };
  } else if (replyMarkup === "replyKeyboard") {
    body.reply_markup = {
      keyboard: keyboardRows(config.replyKeyboard),
      ...config.replyKeyboardOptions,
    };
  } else if (replyMarkup === "forceReply") {
    body.reply_markup = { ...config.forceReply };
  } else {
    body.reply_markup = { ...config.replyKeyboardRemove };
  }
}

/** The Bot API call for a config. It throws when a field that the operation needs is empty. */
export function buildRequest(config: TelegramConfig): TelegramRequest {
  const { resource, operation } = config;
  const need = <T>(name: keyof TelegramConfig, value: T | undefined): T => {
    if (value === undefined || value === "") {
      throw new Error(`Telegram ${resource}.${operation} needs "${name}"`);
    }
    return value;
  };
  const chat = () => need("chatId", config.chatId);
  const body: Record<string, unknown> = {};

  if (resource === "callback") {
    if (operation === "answerQuery") {
      body.callback_query_id = need("queryId", config.queryId);
      Object.assign(body, config.additionalFields);
      return { method: "answerCallbackQuery", body };
    }
    body.inline_query_id = need("queryId", config.queryId);
    body.results = need("results", config.results);
    Object.assign(body, config.additionalFields);
    return { method: "answerInlineQuery", body };
  }

  if (resource === "chat") {
    body.chat_id = chat();
    switch (operation) {
      case "get":
        return { method: "getChat", body };
      case "administrators":
        return { method: "getChatAdministrators", body };
      case "leave":
        return { method: "leaveChat", body };
      case "member":
        body.user_id = need("userId", config.userId);
        return { method: "getChatMember", body };
      case "setDescription":
        body.description = need("description", config.description);
        return { method: "setChatDescription", body };
      case "setTitle":
        body.title = need("title", config.title);
        return { method: "setChatTitle", body };
    }
    throw new Error(`"${operation}" is not an operation of "chat"`);
  }

  if (resource === "file") {
    body.file_id = need("fileId", config.fileId);
    return { method: "getFile", body };
  }

  switch (operation) {
    case "editMessageText":
      if (config.messageType === "inlineMessage") {
        body.inline_message_id = need("inlineMessageId", config.inlineMessageId);
      } else {
        body.chat_id = chat();
        body.message_id = need("messageId", config.messageId);
      }
      body.text = need("text", config.text);
      addAdditionalFields(body, config);
      return { method: "editMessageText", body };
    case "deleteMessage":
    case "unpinChatMessage":
      body.chat_id = chat();
      body.message_id = need("messageId", config.messageId);
      return { method: operation, body };
    case "pinChatMessage":
      body.chat_id = chat();
      body.message_id = need("messageId", config.messageId);
      if (config.additionalFields.disable_notification) body.disable_notification = true;
      return { method: "pinChatMessage", body };
    case "sendChatAction":
      body.chat_id = chat();
      body.action = need("action", config.action);
      return { method: "sendChatAction", body };
    case "sendLocation":
      body.chat_id = chat();
      body.latitude = need("latitude", config.latitude);
      body.longitude = need("longitude", config.longitude);
      addAdditionalFields(body, config);
      return { method: "sendLocation", body };
    case "sendMessage":
      body.chat_id = chat();
      body.text = need("text", config.text);
      addAdditionalFields(body, config);
      return { method: "sendMessage", body };
    case "sendMediaGroup": {
      body.chat_id = chat();
      Object.assign(body, config.additionalFields);
      body.media = need("media", config.media).media.map(({ additionalFields, ...item }) => ({
        ...item,
        ...additionalFields,
      }));
      return { method: "sendMediaGroup", body };
    }
    default: {
      const field = FILE_FIELD[operation];
      if (!field) throw new Error(`"${operation}" is not an operation of "message"`);
      body.chat_id = chat();
      // With binary data, the file goes in the upload form.
      if (!config.binaryData) body[field] = need("file", config.file);
      addAdditionalFields(body, config);
      return { method: operation, body };
    }
  }
}
