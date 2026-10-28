// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import { credentialTypeByName } from "./credentials";

const asText = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The credential has no "${field}"`);
  }
  return value;
};

/** The header that a credential adds to an HTTP request. */
export function credentialHeader(credential: ResolvedCredential): [string, string] {
  const { type, data } = credential;
  if (type === "http.basic") {
    const pair = `${asText(data.username, "username")}:${asText(data.password, "password")}`;
    return ["authorization", `Basic ${Buffer.from(pair).toString("base64")}`];
  }
  if (type === "http.bearer") return ["authorization", `Bearer ${asText(data.token, "token")}`];
  if (type === "http.header") return [asText(data.name, "name"), asText(data.value, "value")];
  // The worker refreshed the token before the node got the credential.
  if (credentialTypeByName.get(type)?.oauth2) {
    return ["authorization", `Bearer ${asText(data.accessToken, "accessToken")}`];
  }
  throw new Error(`Unsupported credential type "${type}"`);
}
