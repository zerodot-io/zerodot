// SPDX-License-Identifier: AGPL-3.0-only
import type { WaitForm } from "@zerodot/engine";
import type { TelegramConfig } from "./config";

export const DEFAULT_WAIT_HOURS = 168;

/** The form of the resume page. Approval needs none: the buttons carry the answer. */
export function waitFormOf(config: Record<string, unknown>): WaitForm | null {
  const { responseType, formFields, options } = config as Pick<
    TelegramConfig,
    "responseType" | "formFields" | "options"
  >;
  const base = {
    title: options?.responseFormTitle,
    description: options?.responseFormDescription,
    buttonLabel: options?.responseFormButtonLabel,
  };
  if (responseType === "freeText") {
    // The answer is returned as `text`.
    return {
      ...base,
      fields: [{ fieldLabel: "Response", key: "text", fieldType: "textarea", requiredField: true }],
    };
  }
  if (responseType === "customForm") return { ...base, fields: formFields ?? [] };
  return null;
}

/** The Bot API call for `sendAndWait`: the message, with link buttons to the resume page. */
export function buildSendAndWait(config: TelegramConfig, resumeUrl: string) {
  if (config.chatId === undefined || config.chatId === "") {
    throw new Error('Telegram message.sendAndWait needs "chatId"');
  }
  if (!config.message) throw new Error('Telegram message.sendAndWait needs "message"');
  let buttons: { text: string; url: string }[];
  if (config.responseType === "approval") {
    const {
      approvalType = "single",
      approveLabel = "Approve",
      disapproveLabel = "Decline",
    } = config.approvalOptions ?? {};
    buttons = [{ text: approveLabel, url: `${resumeUrl}&approved=true` }];
    if (approvalType === "double") {
      buttons.push({ text: disapproveLabel, url: `${resumeUrl}&approved=false` });
    }
  } else {
    buttons = [{ text: config.options?.messageButtonLabel ?? "Respond", url: resumeUrl }];
  }
  return {
    method: "sendMessage",
    body: {
      chat_id: config.chatId,
      text: config.message,
      disable_web_page_preview: true,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: [buttons] },
    },
  };
}

/** When the wait ends without an answer. */
export const waitDeadline = (config: TelegramConfig) =>
  Date.now() + (config.options?.limitWaitTimeHours ?? DEFAULT_WAIT_HOURS) * 3_600_000;
