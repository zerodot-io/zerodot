// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";

export const TELEGRAM_CREDENTIAL = "telegram.bot";
export const DEFAULT_BASE_URL = "https://api.telegram.org";

export type TelegramAccess = { accessToken: string; baseUrl: string };

/** The token and the API address of a credential. */
export function telegramAccess(credential: Pick<ResolvedCredential, "type" | "data"> | null) {
  if (!credential || credential.type !== TELEGRAM_CREDENTIAL) {
    throw new Error("The node needs a Telegram bot credential");
  }
  const { accessToken, baseUrl } = credential.data;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error('The credential has no "accessToken"');
  }
  const base = typeof baseUrl === "string" && baseUrl !== "" ? baseUrl : DEFAULT_BASE_URL;
  return { accessToken, baseUrl: base.replace(/\/+$/, "") } satisfies TelegramAccess;
}

type TelegramAnswer = { ok?: boolean; result?: unknown; description?: string };

/** One Bot API call. The error text never has the token, because the token is in the URL. */
export async function callTelegram(
  access: TelegramAccess,
  method: string,
  body: Record<string, unknown> | FormData,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<TelegramAnswer> {
  const isForm = body instanceof FormData;
  const response = await fetch(`${access.baseUrl}/bot${access.accessToken}/${method}`, {
    method: "POST",
    // fetch sets the content type with the boundary for a form.
    headers: isForm ? undefined : { "content-type": "application/json" },
    body: isForm ? body : JSON.stringify(body),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
  });
  const answer = (await response.json().catch(() => null)) as TelegramAnswer | null;
  if (!answer?.ok) {
    throw new Error(
      `Telegram ${method} failed (${response.status}): ${answer?.description ?? "no answer"}`,
    );
  }
  return answer;
}

/** Bot API files are at most 20 MB. */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** The bytes of a file that `getFile` named. The error text never has the token. */
export async function downloadTelegramFile(
  access: TelegramAccess,
  filePath: string,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(`${access.baseUrl}/file/bot${access.accessToken}/${filePath}`, {
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]),
    });
  } catch {
    throw new Error("Telegram file download failed");
  }
  if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("The Telegram file is too large");
  return bytes;
}
