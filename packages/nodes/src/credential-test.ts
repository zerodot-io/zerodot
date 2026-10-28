// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import { credentialTypeByName } from "./credentials";
import { connectSsh } from "./ssh";

export type CredentialTestResult =
  | { status: "ok" }
  | { status: "failed"; message: string }
  /** This credential type has no safe check. The form shows no result. */
  | { status: "unsupported" };

const TIMEOUT_MS = 10_000;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

async function checkTelegram({ data }: ResolvedCredential): Promise<void> {
  const token = text(data.accessToken);
  if (!token) throw new Error('The credential has no "accessToken"');
  const base = (text(data.baseUrl) ?? "https://api.telegram.org").replace(/\/+$/, "");
  const response = await fetch(`${base}/bot${token}/getMe`, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 404) {
    throw new Error("Telegram did not accept the token");
  }
  if (!response.ok) throw new Error(`Telegram answered with status ${response.status}`);
}

async function checkSsh(credential: ResolvedCredential): Promise<void> {
  const client = await connectSsh(credential);
  client.end();
}

async function checkFtp({ data }: ResolvedCredential): Promise<void> {
  const host = text(data.host);
  if (!host) throw new Error('The credential has no "host"');
  const { Client } = await import("basic-ftp");
  const client = new Client(TIMEOUT_MS);
  try {
    await client.access({
      host,
      port: text(data.port) ? Number(data.port) : 21,
      user: text(data.username) ?? "anonymous",
      password: text(data.password) ?? "anonymous@",
      secure: data.secure === "true",
    });
  } finally {
    client.close();
  }
}

const checks: Record<string, (credential: ResolvedCredential) => Promise<void>> = {
  "telegram.bot": checkTelegram,
  ssh: checkSsh,
  ftp: checkFtp,
};

function secretsOf(data: unknown, found: string[] = []): string[] {
  if (typeof data === "string") {
    if (data.length >= 4) found.push(data);
  } else if (data !== null && typeof data === "object") {
    for (const item of Object.values(data)) secretsOf(item, found);
  }
  return found;
}

/**
 * Tries to connect with the saved credential. The message never holds a value of the credential.
 * The caller checks that the user may use the credential.
 */
export async function testCredential(
  credential: ResolvedCredential,
): Promise<CredentialTestResult> {
  const check = checks[credential.type] ?? credentialTypeByName.get(credential.type)?.test;
  if (!check) return { status: "unsupported" };
  try {
    await check(credential);
    return { status: "ok" };
  } catch (error) {
    let message = error instanceof Error ? error.message : "Could not connect";
    for (const secret of secretsOf(credential.data)) message = message.split(secret).join("***");
    return { status: "failed", message: message.slice(0, 300) };
  }
}
