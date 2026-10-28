// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode, type ResolvedCredential } from "@zerodot/engine";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { z } from "zod";
import { readBinary } from "./binary";

export const SMTP_CREDENTIAL_TYPES = ["smtp"];

const option = (title: string) => ({ option: true, title });

const ATTRIBUTION = "This email was sent automatically with zerodot";

type MessageConfig = {
  fromEmail: string;
  toEmail: string;
  subject: string;
  emailFormat: "text" | "html" | "both";
  text?: string;
  html?: string;
  ccEmail?: string;
  bccEmail?: string;
  replyTo?: string;
  attachments?: string;
  appendAttribution: boolean;
};

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/**
 * The connection settings. The credential fields are
 * text, so `secure` and `disableStartTls` are "true" or "false". `secure` is on when unset.
 */
export function smtpOptions(
  credential: ResolvedCredential | null,
  allowUnauthorizedCerts = false,
): SMTPTransport.Options {
  if (!credential || credential.type !== "smtp") throw new Error("Pick an SMTP credential");
  const { data } = credential;
  const host = text(data.host);
  if (!host) throw new Error('The credential has no "host"');
  const secure = data.secure !== "false";
  const options: SMTPTransport.Options = {
    host,
    port: text(data.port) ? Number(data.port) : 465,
    secure,
  };
  if (!secure) options.ignoreTLS = data.disableStartTls === "true";
  const hostName = text(data.hostName);
  if (hostName) options.name = hostName;
  const user = text(data.user);
  const pass = text(data.password);
  if (user || pass) options.auth = { user: user ?? "", pass: pass ?? "" };
  if (allowUnauthorizedCerts) options.tls = { rejectUnauthorized: false };
  return options;
}

/**
 * The message for nodemailer. An attachment name is a property of `input.binary`. The content id
 * of an attachment is its property name, so the body can show it with `<img src="cid:data">`.
 */
export function buildMessage(config: MessageConfig, input: unknown) {
  const { emailFormat } = config;
  const message: Record<string, unknown> = {
    from: config.fromEmail,
    to: config.toEmail,
    cc: config.ccEmail || undefined,
    bcc: config.bccEmail || undefined,
    subject: config.subject,
    replyTo: config.replyTo || undefined,
  };
  if (emailFormat === "text" || emailFormat === "both") message.text = config.text ?? "";
  if (emailFormat === "html" || emailFormat === "both") message.html = config.html ?? "";
  if (config.appendAttribution) {
    if (emailFormat === "html" || (emailFormat === "both" && message.html)) {
      message.html = `\n\t\t\t\t\t${message.html}\n\t\t\t\t\t<br>\n\t\t\t\t\t<br>\n\t\t\t\t\t---\n\t\t\t\t\t<br>\n\t\t\t\t\t<em>${ATTRIBUTION}</em>\n\t\t\t\t\t`;
    } else {
      message.text = `${message.text}\n\n---\n${ATTRIBUTION}`;
    }
  }
  const names = (config.attachments ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length > 0) {
    message.attachments = names.map((name) => {
      const file = readBinary(input, name);
      return {
        filename: file.fileName || "unknown",
        content: Buffer.from(file.data, "base64"),
        cid: name,
      };
    });
  }
  return message;
}

/** The editor imports this package for the node catalog. nodemailer loads on first use. */
async function loadNodemailer() {
  return (await import("nodemailer")).default;
}

export default defineNode({
  type: "email.send",
  label: "Send Email",
  description: "Sends an email using SMTP protocol",
  category: "integration",
  icon: "Mail",
  config: z.object({
    fromEmail: z.string().min(1).meta({
      title: "From Email",
      placeholder: "admin@example.com",
      description:
        "Email address of the sender. You can also specify a name: Nathan Doe <nate@example.com>.",
    }),
    toEmail: z.string().min(1).meta({
      title: "To Email",
      placeholder: "info@example.com",
      description:
        "Email address of the recipient. You can also specify a name: Nathan Doe <nate@example.com>.",
    }),
    subject: z.string().default("").meta({
      title: "Subject",
      placeholder: "My subject line",
      description: "Subject line of the email",
    }),
    emailFormat: z
      .enum(["text", "html", "both"])
      .default("html")
      .meta({
        title: "Email Format",
        labels: { text: "Text", html: "HTML", both: "Both" },
        hints: {
          text: "Send email as plain text",
          html: "Send email as HTML",
          both: "Send both formats, recipient's client selects version to display",
        },
      }),
    text: z
      .string()
      .optional()
      .meta({
        title: "Text",
        description: "Plain text message of email",
        showWhen: { emailFormat: ["text", "both"] },
      }),
    html: z
      .string()
      .optional()
      .meta({
        title: "HTML",
        description: "HTML text message of email",
        showWhen: { emailFormat: ["html", "both"] },
      }),
    appendAttribution: z
      .boolean()
      .default(true)
      .meta({
        ...option("Append zerodot Attribution"),
        description:
          "Whether to include the phrase “This email was sent automatically with zerodot”",
      }),
    attachments: z
      .string()
      .optional()
      .meta({
        ...option("Attachments"),
        description:
          'Name of the binary properties that contain data to add to email as attachment. Multiple ones can be comma-separated. Reference embedded images or other content within the body of an email message, e.g. <img src="cid:image_1">',
      }),
    ccEmail: z
      .string()
      .optional()
      .meta({
        ...option("CC Email"),
        placeholder: "cc@example.com",
        description: "Email address of CC recipient",
      }),
    bccEmail: z
      .string()
      .optional()
      .meta({
        ...option("BCC Email"),
        placeholder: "bcc@example.com",
        description: "Email address of BCC recipient",
      }),
    allowUnauthorizedCerts: z
      .boolean()
      .default(false)
      .meta({
        ...option("Ignore SSL Issues (Insecure)"),
        description: "Whether to connect even if SSL certificate validation is not possible",
      }),
    replyTo: z
      .string()
      .optional()
      .meta({
        ...option("Reply To"),
        placeholder: "info@example.com",
        description: "The email address to send the reply to",
      }),
  }),
  defaultConfig: {
    fromEmail: "",
    toEmail: "",
    subject: "",
    emailFormat: "html",
    html: "",
    appendAttribution: true,
    allowUnauthorizedCerts: false,
  },
  credentialTypes: SMTP_CREDENTIAL_TYPES,
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.toEmail === "string" && config.toEmail !== "" ? config.toEmail : undefined,
  // The output is the result of nodemailer (messageId, accepted, rejected, response...).
  async run({ config, input, credential, signal }) {
    const nodemailer = await loadNodemailer();
    const transport = nodemailer.createTransport(
      smtpOptions(credential, config.allowUnauthorizedCerts),
    );
    const abort = () => transport.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const info = await transport.sendMail(buildMessage(config, input));
      return { port: "out", data: info };
    } finally {
      signal.removeEventListener("abort", abort);
      transport.close();
    }
  },
});
