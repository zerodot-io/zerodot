// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCredentialData } from "./credentials";
import { buildMessage, smtpOptions } from "./email-send";
import { registry } from "./index";

const base = {
  fromEmail: "a@x.io",
  toEmail: "b@x.io",
  subject: "Hi",
  emailFormat: "text" as const,
  text: "Yo",
  appendAttribution: false,
};

describe("smtpOptions", () => {
  it("uses port 465 and SSL by default", () => {
    const options = smtpOptions({ type: "smtp", data: { host: "mail.x.io" } });
    assert.equal(options.port, 465);
    assert.equal(options.secure, true);
    assert.equal(options.ignoreTLS, undefined);
    assert.equal(options.auth, undefined);
  });

  it("reads STARTTLS, client name and login", () => {
    const options = smtpOptions({
      type: "smtp",
      data: {
        host: "mail.x.io",
        port: "587",
        secure: "false",
        disableStartTls: "true",
        hostName: "zerodot.local",
        user: "u",
        password: "p",
      },
    });
    assert.equal(options.port, 587);
    assert.equal(options.secure, false);
    assert.equal(options.ignoreTLS, true);
    assert.equal(options.name, "zerodot.local");
    assert.deepEqual(options.auth, { user: "u", pass: "p" });
  });

  it("ignores certificate errors on request", () => {
    const options = smtpOptions({ type: "smtp", data: { host: "h" } }, true);
    assert.deepEqual(options.tls, { rejectUnauthorized: false });
  });

  it("fails without a credential", () => {
    assert.throws(() => smtpOptions(null), /SMTP credential/);
  });
});

describe("buildMessage", () => {
  it("sends only the text for the text format", () => {
    const message = buildMessage({ ...base, html: "<b>x</b>" }, {});
    assert.equal(message.text, "Yo");
    assert.equal(message.html, undefined);
  });

  it("sends both bodies for the both format", () => {
    const message = buildMessage({ ...base, emailFormat: "both", html: "<b>x</b>" }, {});
    assert.equal(message.text, "Yo");
    assert.equal(message.html, "<b>x</b>");
  });

  it("adds cc, bcc and reply to", () => {
    const message = buildMessage(
      { ...base, ccEmail: "c@x.io", bccEmail: "d@x.io", replyTo: "r@x.io" },
      {},
    );
    assert.equal(message.cc, "c@x.io");
    assert.equal(message.bcc, "d@x.io");
    assert.equal(message.replyTo, "r@x.io");
  });

  it("appends the attribution to the text", () => {
    const message = buildMessage({ ...base, appendAttribution: true }, {});
    assert.equal(message.text, "Yo\n\n---\nThis email was sent automatically with zerodot");
  });

  it("appends the attribution to the HTML", () => {
    const message = buildMessage(
      { ...base, emailFormat: "html", html: "<p>x</p>", appendAttribution: true },
      {},
    );
    assert.match(String(message.html), /<p>x<\/p>[\s\S]*<em>This email was sent automatically/);
  });

  it("reads attachments from the binary input, with the property name as content id", () => {
    const input = {
      binary: { data: { data: Buffer.from("abc").toString("base64"), mimeType: "text/plain" } },
    };
    const message = buildMessage({ ...base, attachments: " data " }, input);
    const [file] = message.attachments as { filename: string; content: Buffer; cid: string }[];
    assert.equal(file?.filename, "unknown");
    assert.equal(file?.cid, "data");
    assert.equal(file?.content.toString(), "abc");
  });

  it("fails when the binary property is missing", () => {
    assert.throws(() => buildMessage({ ...base, attachments: "file" }, {}), /"file"/);
  });
});

describe("email.send config", () => {
  const schema = registry.get("email.send")?.config;
  it("defaults to HTML with the attribution on", () => {
    const parsed = schema?.parse({ fromEmail: "a@x.io", toEmail: "b@x.io" }) as Record<
      string,
      unknown
    >;
    assert.equal(parsed.emailFormat, "html");
    assert.equal(parsed.appendAttribution, true);
  });

  it("needs a sender and a recipient", () => {
    assert.equal(schema?.safeParse({ fromEmail: "", toEmail: "b@x.io" }).success, false);
  });
});

describe("smtp credential", () => {
  it("accepts a valid account", () => {
    assert.equal(validateCredentialData("smtp", { host: "h", port: "25", secure: "false" }), null);
  });

  it("rejects a bad port", () => {
    assert.match(validateCredentialData("smtp", { host: "h", port: "abc" }) ?? "", /port/);
  });
});
