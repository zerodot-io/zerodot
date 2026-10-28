// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import { credentialTypeByName } from "./credentials";

export type CredentialTestResult =
  | { status: "ok" }
  | { status: "failed"; message: string }
  /** This credential type has no safe check. The form shows no result. */
  | { status: "unsupported" };

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
  const check = credentialTypeByName.get(credential.type)?.test;
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
