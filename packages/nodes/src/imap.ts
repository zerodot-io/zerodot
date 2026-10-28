// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import type { ImapFlowOptions } from "imapflow";
import type { AddressObject, ParsedMail } from "mailparser";
import { type BinaryData, toBinary } from "./binary";

export const IMAP_CREDENTIAL_TYPES = ["imap"];

export const IMAP_FORMATS = ["simple", "resolved", "raw"] as const;
export type ImapFormat = (typeof IMAP_FORMATS)[number];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The connection settings from an `imap` credential. Empty `secure` means true. */
export function imapOptions(credential: ResolvedCredential | null): ImapFlowOptions {
  if (credential?.type !== "imap") throw new Error("Pick an IMAP credential");
  const { data } = credential;
  const host = text(data.host);
  const user = text(data.user);
  const pass = text(data.password);
  if (!host) throw new Error('The credential has no "host"');
  if (!user || !pass) throw new Error("The credential needs a user and a password");
  const secure = data.secure !== "false";
  const port = text(data.port) ? Number(data.port) : secure ? 993 : 143;
  return {
    host,
    port,
    secure,
    auth: { user, pass },
    // The logger would print the mail commands. They hold the password.
    logger: false,
    emitLogs: false,
    ...(data.allowUnauthorizedCerts === "true" ? { tls: { rejectUnauthorized: false } } : {}),
  };
}

type Address = { name: string; address: string };

export type MailAddresses = { text: string; value: Address[] };

const addresses = (field: AddressObject | AddressObject[] | undefined): MailAddresses | null => {
  if (!field) return null;
  const list = Array.isArray(field) ? field : [field];
  return {
    text: list.map((entry) => entry.text).join(", "),
    value: list.flatMap((entry) =>
      entry.value.map((a) => ({ name: a.name ?? "", address: a.address ?? "" })),
    ),
  };
};

export type MailItem = {
  uid: number;
  messageId: string | null;
  subject: string | null;
  from: MailAddresses | null;
  to: MailAddresses | null;
  cc: MailAddresses | null;
  bcc: MailAddresses | null;
  replyTo: MailAddresses | null;
  date: string | null;
  text: string | null;
  html: string | null;
  attachments: { fileName: string | null; mimeType: string; size: number }[];
  binary?: Record<string, BinaryData>;
};

/**
 * The trigger input for one mail. `simple` has the parsed fields and the list of attachments.
 * `resolved` also has the attachments as binary data (`attachment_0`, `attachment_1`, ...).
 * `raw` has the whole message, as base64 text under `raw`.
 */
export async function toMailItem(
  source: Buffer,
  uid: number,
  format: ImapFormat,
): Promise<MailItem | { uid: number; raw: string }> {
  if (format === "raw") return { uid, raw: source.toString("base64") };
  const { simpleParser } = await import("mailparser");
  const mail: ParsedMail = await simpleParser(source);
  const item: MailItem = {
    uid,
    messageId: mail.messageId ?? null,
    subject: mail.subject ?? null,
    from: addresses(mail.from),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    bcc: addresses(mail.bcc),
    replyTo: addresses(mail.replyTo),
    date: mail.date ? mail.date.toISOString() : null,
    text: mail.text ?? null,
    html: mail.html === false ? null : (mail.html ?? null),
    attachments: mail.attachments.map((a) => ({
      fileName: a.filename ?? null,
      mimeType: a.contentType,
      size: a.size,
    })),
  };
  if (format === "resolved" && mail.attachments.length > 0) {
    item.binary = {};
    mail.attachments.forEach((a, i) => {
      if (item.binary) {
        item.binary[`attachment_${i}`] = toBinary(
          a.content,
          a.filename ?? `attachment_${i}`,
          a.contentType,
        );
      }
    });
  }
  return item;
}
