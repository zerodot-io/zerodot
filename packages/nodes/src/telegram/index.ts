// SPDX-License-Identifier: AGPL-3.0-only
import telegram from "./node";
import telegramTrigger from "./trigger";

export const telegramNodes = [telegramTrigger, telegram];
export { DEFAULT_BASE_URL, TELEGRAM_CREDENTIAL, telegramAccess } from "./api";
export {
  checkTelegramUpdate,
  registerTelegramWebhook,
  removeTelegramWebhook,
  type UpdateVerdict,
} from "./trigger";
