// SPDX-License-Identifier: AGPL-3.0-only
import { FORM_FIELD_TYPES } from "@zerodot/engine";
import { z } from "zod";

// The names of resources, operations, and parameters follow the Telegram Bot API.

export const RESOURCES = ["message", "chat", "callback", "file"] as const;

export const OPERATIONS = [
  // message
  "sendMessage",
  "editMessageText",
  "deleteMessage",
  "pinChatMessage",
  "unpinChatMessage",
  "sendPhoto",
  "sendVideo",
  "sendAudio",
  "sendDocument",
  "sendAnimation",
  "sendSticker",
  "sendLocation",
  "sendMediaGroup",
  "sendChatAction",
  "sendAndWait",
  // chat
  "get",
  "administrators",
  "member",
  "leave",
  "setTitle",
  "setDescription",
  // callback
  "answerQuery",
  "answerInlineQuery",
] as const;

export type Resource = (typeof RESOURCES)[number];
export type Operation = (typeof OPERATIONS)[number];

/** Operations of each resource. `get` is in `chat` and in `file`. */
export const OPERATIONS_OF: Record<Resource, readonly Operation[]> = {
  message: [
    "sendMessage",
    "editMessageText",
    "deleteMessage",
    "pinChatMessage",
    "unpinChatMessage",
    "sendPhoto",
    "sendVideo",
    "sendAudio",
    "sendDocument",
    "sendAnimation",
    "sendSticker",
    "sendLocation",
    "sendMediaGroup",
    "sendChatAction",
    "sendAndWait",
  ],
  chat: ["get", "administrators", "member", "leave", "setTitle", "setDescription"],
  callback: ["answerQuery", "answerInlineQuery"],
  file: ["get"],
};

export const CHAT_ACTIONS = [
  "typing",
  "find_location",
  "record_audio",
  "record_video",
  "record_video_note",
  "upload_audio",
  "upload_document",
  "upload_photo",
  "upload_video",
  "upload_video_note",
] as const;

const id = z.union([z.string(), z.number()]);

const button = z.object({
  text: z.string(),
  additionalFields: z.record(z.string(), z.unknown()).optional(),
});

/** The "fixed collection" shape: rows.row.buttons. */
const keyboard = z.object({
  rows: z.array(z.object({ row: z.object({ buttons: z.array(button) }) })).default([]),
});

const mediaItem = z.object({
  type: z.enum(["photo", "video"]),
  media: z.string(),
  additionalFields: z
    .object({ caption: z.string(), parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]) })
    .partial()
    .optional(),
});

export const additionalFields = z
  .object({
    caption: z.string(),
    disable_notification: z.boolean(),
    disable_web_page_preview: z.boolean(),
    duration: z.number(),
    fileName: z.string(),
    height: z.number(),
    parse_mode: z.enum(["Markdown", "MarkdownV2", "HTML"]),
    performer: z.string(),
    reply_to_message_id: z.number(),
    message_thread_id: z.number(),
    title: z.string(),
    thumb: z.string(),
    width: z.number(),
    // answerQuery and answerInlineQuery
    cache_time: z.number(),
    show_alert: z.boolean(),
    text: z.string(),
    url: z.string(),
    // file.get with a download
    mimeType: z.string(),
  })
  .partial()
  .catchall(z.unknown());

const forOperations = (...operations: Operation[]) => ({ showWhen: { operation: operations } });
const SEND_FILE: Operation[] = [
  "sendPhoto",
  "sendVideo",
  "sendAudio",
  "sendDocument",
  "sendAnimation",
  "sendSticker",
];
const WITH_ADDITIONAL: Operation[] = [
  "sendMessage",
  "editMessageText",
  ...SEND_FILE,
  "sendLocation",
  "sendMediaGroup",
  "pinChatMessage",
  "answerQuery",
  "answerInlineQuery",
];
const WITH_MARKUP: Operation[] = ["sendMessage", ...SEND_FILE, "sendLocation"];

export const telegramConfig = z
  .object({
    resource: z
      .enum(RESOURCES)
      .default("message")
      .meta({
        labels: { message: "Message", chat: "Chat", callback: "Callback", file: "File" },
        hints: {
          message: "Send, edit, delete, or pin messages",
          chat: "Get or change a chat, a channel, or a group",
          callback: "Answer a button press or an inline query",
          file: "Get a file that Telegram has",
        },
      }),
    operation: z
      .enum(OPERATIONS)
      .default("sendMessage")
      .meta({
        labels: {
          sendMessage: "Send Message",
          editMessageText: "Edit Message Text",
          deleteMessage: "Delete Message",
          pinChatMessage: "Pin Message",
          unpinChatMessage: "Unpin Message",
          sendPhoto: "Send Photo",
          sendVideo: "Send Video",
          sendAudio: "Send Audio",
          sendDocument: "Send Document",
          sendAnimation: "Send Animation",
          sendSticker: "Send Sticker",
          sendLocation: "Send Location",
          sendMediaGroup: "Send Media Group",
          sendChatAction: "Send Chat Action",
          sendAndWait: "Send and Wait for Response",
          get: "Get",
          administrators: "Get Administrators",
          member: "Get Member",
          leave: "Leave",
          setTitle: "Set Title",
          setDescription: "Set Description",
          answerQuery: "Answer Query",
          answerInlineQuery: "Answer Inline Query",
        },
        hints: {
          sendMessage: "Send a text message",
          editMessageText: "Change the text of a message",
          deleteMessage: "Delete a message from a chat",
          pinChatMessage: "Pin a message in a chat",
          unpinChatMessage: "Unpin a message in a chat",
          sendPhoto: "Send a photo",
          sendVideo: "Send a video",
          sendAudio: "Send an audio file",
          sendDocument: "Send a document",
          sendAnimation: "Send a GIF or a short video without sound",
          sendSticker: "Send a sticker",
          sendLocation: "Send a point on the map",
          sendMediaGroup: "Send photos and videos as one album",
          sendChatAction: "Show a status such as typing",
          sendAndWait: "Send a message and pause the workflow until the user answers",
          get: "Get a chat, or a file",
          administrators: "Get the administrators of a chat",
          member: "Get one member of a chat",
          leave: "Make the bot leave a chat",
          setTitle: "Change the title of a chat",
          setDescription: "Change the description of a chat",
          answerQuery: "Answer a button press",
          answerInlineQuery: "Answer an inline query",
        },
      }),
    chatId: id.optional().meta({
      ...forOperations(
        "sendMessage",
        "editMessageText",
        "deleteMessage",
        "pinChatMessage",
        "unpinChatMessage",
        ...SEND_FILE,
        "sendLocation",
        "sendMediaGroup",
        "sendChatAction",
        "sendAndWait",
        "get",
        "administrators",
        "member",
        "leave",
        "setTitle",
        "setDescription",
      ),
      showWhen: {
        resource: ["message", "chat"],
        operation: [
          "sendMessage",
          "editMessageText",
          "deleteMessage",
          "pinChatMessage",
          "unpinChatMessage",
          ...SEND_FILE,
          "sendLocation",
          "sendMediaGroup",
          "sendChatAction",
          "sendAndWait",
          "get",
          "administrators",
          "member",
          "leave",
          "setTitle",
          "setDescription",
        ],
      },
      description: "Unique identifier of the target chat, or @channelusername",
    }),
    messageId: id
      .optional()
      .meta(
        forOperations("editMessageText", "deleteMessage", "pinChatMessage", "unpinChatMessage"),
      ),
    messageType: z
      .enum(["message", "inlineMessage"])
      .optional()
      .meta({
        ...forOperations("editMessageText"),
        labels: { message: "Message", inlineMessage: "Inline Message" },
        hints: {
          message: "A message in a chat",
          inlineMessage: "A message that was sent through inline mode",
        },
      }),
    inlineMessageId: z.string().optional().meta(forOperations("editMessageText")),
    userId: id.optional().meta(forOperations("member")),
    title: z.string().optional().meta(forOperations("setTitle")),
    description: z.string().optional().meta(forOperations("setDescription")),
    queryId: z.string().optional().meta(forOperations("answerQuery", "answerInlineQuery")),
    results: z
      .string()
      .optional()
      .meta({
        ...forOperations("answerInlineQuery"),
        description: "A JSON array of results for the inline query",
      }),
    fileId: z
      .string()
      .optional()
      .meta({ showWhen: { resource: ["file"], operation: ["get"] } }),
    download: z
      .boolean()
      .default(false)
      .meta({
        showWhen: { resource: ["file"], operation: ["get"] },
        description: "Add the file as binary data to the output",
      }),
    binaryData: z
      .boolean()
      .default(false)
      .meta({
        ...forOperations(...SEND_FILE),
        description: "Upload the binary data of the input instead of a URL or a file_id",
      }),
    binaryPropertyName: z
      .string()
      .default("data")
      .meta({
        showWhen: { binaryData: [true] },
        description: "The property of `binary` in the input that holds the file",
      }),
    message: z
      .string()
      .optional()
      .meta({
        ...forOperations("sendAndWait"),
        description: "The message to send, with the buttons",
      }),
    responseType: z
      .enum(["approval", "freeText", "customForm"])
      .default("approval")
      .meta({
        ...forOperations("sendAndWait"),
        title: "Response Type",
        labels: { approval: "Approval", freeText: "Free Text", customForm: "Custom Form" },
        hints: {
          approval: "The user presses an approve or decline button",
          freeText: "The user writes an answer in text",
          customForm: "The user fills in a form with the fields that you set",
        },
      }),
    approvalOptions: z
      .object({
        approvalType: z.enum(["single", "double"]).default("single"),
        approveLabel: z.string().default("Approve"),
        disapproveLabel: z.string().default("Decline"),
      })
      .partial()
      .optional()
      .meta({ showWhen: { operation: ["sendAndWait"], responseType: ["approval"] } }),
    formFields: z
      .array(
        z.object({
          fieldLabel: z.string(),
          fieldType: z.enum(FORM_FIELD_TYPES).optional(),
          placeholder: z.string().optional(),
          requiredField: z.boolean().optional(),
          fieldOptions: z.object({ values: z.array(z.object({ option: z.string() })) }).optional(),
        }),
      )
      .optional()
      .meta({ showWhen: { operation: ["sendAndWait"], responseType: ["customForm"] } }),
    options: z
      .object({
        messageButtonLabel: z.string(),
        responseFormTitle: z.string(),
        responseFormDescription: z.string(),
        responseFormButtonLabel: z.string(),
        limitWaitTimeHours: z.number().min(0.01).max(720),
      })
      .partial()
      .optional()
      .meta({
        ...forOperations("sendAndWait"),
        description: "limitWaitTimeHours: how long to wait for an answer. Default 168 (7 days).",
      }),
    text: z
      .string()
      .optional()
      .meta({ ...forOperations("sendMessage", "editMessageText"), ui: "textarea" }),
    file: z
      .string()
      .optional()
      .meta({
        ...forOperations(...SEND_FILE),
        description: "A public URL, or the file_id of a file that Telegram has",
      }),
    action: z
      .enum(CHAT_ACTIONS)
      .optional()
      .meta({
        ...forOperations("sendChatAction"),
        labels: {
          typing: "Typing a Message",
          find_location: "Selecting a Location",
          record_audio: "Recording Audio",
          record_video: "Recording Video",
          record_video_note: "Recording Video Note",
          upload_audio: "Uploading Audio",
          upload_document: "Uploading Document",
          upload_photo: "Uploading Photo",
          upload_video: "Uploading Video",
          upload_video_note: "Uploading Video Note",
        },
        hints: {
          typing: "Show that the bot writes text",
          find_location: "Show that the bot picks a location",
          record_audio: "Show that the bot records a voice message",
          record_video: "Show that the bot records a video",
          record_video_note: "Show that the bot records a round video",
          upload_audio: "Show that the bot sends audio",
          upload_document: "Show that the bot sends a document",
          upload_photo: "Show that the bot sends a photo",
          upload_video: "Show that the bot sends a video",
          upload_video_note: "Show that the bot sends a round video",
        },
      }),
    latitude: z.number().optional().meta(forOperations("sendLocation")),
    longitude: z.number().optional().meta(forOperations("sendLocation")),
    media: z
      .object({ media: z.array(mediaItem) })
      .optional()
      .meta(forOperations("sendMediaGroup")),
    replyMarkup: z
      .enum(["none", "inlineKeyboard", "replyKeyboard", "replyKeyboardRemove", "forceReply"])
      .default("none")
      .meta({
        ...forOperations(...WITH_MARKUP, "editMessageText"),
        title: "Reply Markup",
        labels: {
          none: "None",
          inlineKeyboard: "Inline Keyboard",
          replyKeyboard: "Reply Keyboard",
          replyKeyboardRemove: "Reply Keyboard Remove",
          forceReply: "Force Reply",
        },
        hints: {
          none: "No buttons",
          inlineKeyboard: "Buttons under the message",
          replyKeyboard: "Buttons that replace the keyboard of the user",
          replyKeyboardRemove: "Remove the reply keyboard",
          forceReply: "Make the user reply to the message",
        },
      }),
    inlineKeyboard: keyboard.optional().meta({ showWhen: { replyMarkup: ["inlineKeyboard"] } }),
    replyKeyboard: keyboard.optional().meta({ showWhen: { replyMarkup: ["replyKeyboard"] } }),
    replyKeyboardOptions: z
      .object({
        resize_keyboard: z.boolean(),
        one_time_keyboard: z.boolean(),
        selective: z.boolean(),
      })
      .partial()
      .optional()
      .meta({ showWhen: { replyMarkup: ["replyKeyboard"] } }),
    replyKeyboardRemove: z
      .object({ remove_keyboard: z.boolean(), selective: z.boolean() })
      .partial()
      .optional()
      .meta({ showWhen: { replyMarkup: ["replyKeyboardRemove"] } }),
    forceReply: z
      .object({ force_reply: z.boolean(), selective: z.boolean() })
      .partial()
      .optional()
      .meta({ showWhen: { replyMarkup: ["forceReply"] } }),
    additionalFields: additionalFields.default({}).meta(forOperations(...WITH_ADDITIONAL)),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  })
  .superRefine((config, context) => {
    if (!OPERATIONS_OF[config.resource].includes(config.operation)) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: `"${config.operation}" is not an operation of "${config.resource}"`,
      });
    }
  });

export type TelegramConfig = z.output<typeof telegramConfig>;
