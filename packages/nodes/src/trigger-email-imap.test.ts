// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateCredentialData } from "./credentials";
import { imapOptions, toMailItem } from "./imap";
import { registry } from "./index";

const MAIL = [
  "From: Ann <ann@example.com>",
  "To: bob@example.com, Cy <cy@example.com>",
  "Subject: Hello",
  "Message-ID: <1@example.com>",
  "Date: Mon, 26 Oct 2026 10:00:00 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hi Bob",
  "--b",
  'Content-Type: text/csv; name="a.csv"',
  'Content-Disposition: attachment; filename="a.csv"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("x,y\n1,2\n").toString("base64"),
  "--b--",
  "",
].join("\r\n");

describe("IMAP trigger", () => {
  it("is in the registry and starts from the mail", async () => {
    const node = registry.get("trigger.email_imap");
    assert.ok(node);
    const out = await node.run({ input: { uid: 1 } } as never);
    assert.deepEqual(out, { port: "out", data: { uid: 1 } });
  });

  it("builds the connection settings", () => {
    const options = imapOptions({
      type: "imap",
      data: { host: "imap.example.com", user: "u", password: "p" },
    });
    assert.equal(options.port, 993);
    assert.equal(options.secure, true);
    assert.equal(options.logger, false);
    const plain = imapOptions({
      type: "imap",
      data: {
        host: "h",
        user: "u",
        password: "p",
        secure: "false",
        allowUnauthorizedCerts: "true",
      },
    });
    assert.equal(plain.port, 143);
    assert.deepEqual(plain.tls, { rejectUnauthorized: false });
    assert.throws(() => imapOptions(null), /Pick an IMAP credential/);
  });

  it("checks the credential", () => {
    assert.equal(
      validateCredentialData("imap", { host: "h", user: "u", password: "p", port: "993" }),
      null,
    );
    assert.match(validateCredentialData("imap", { host: "h" }) ?? "", /user/);
  });

  it("makes a simple item", async () => {
    const item = await toMailItem(Buffer.from(MAIL), 7, "simple");
    assert.ok("subject" in item);
    assert.equal(item.uid, 7);
    assert.equal(item.subject, "Hello");
    assert.equal(item.messageId, "<1@example.com>");
    assert.equal(item.from?.value[0]?.address, "ann@example.com");
    assert.equal(item.to?.value.length, 2);
    assert.equal(item.date, "2026-10-26T10:00:00.000Z");
    assert.match(item.text ?? "", /Hi Bob/);
    assert.deepEqual(item.attachments, [{ fileName: "a.csv", mimeType: "text/csv", size: 8 }]);
    assert.equal(item.binary, undefined);
  });

  it("puts the attachments in binary data for the resolved format", async () => {
    const item = await toMailItem(Buffer.from(MAIL), 7, "resolved");
    assert.ok("binary" in item);
    const file = item.binary?.attachment_0;
    assert.equal(file?.fileName, "a.csv");
    assert.equal(file?.mimeType, "text/csv");
    assert.equal(Buffer.from(file?.data ?? "", "base64").toString(), "x,y\n1,2\n");
  });

  it("gives the whole message for the raw format", async () => {
    const item = await toMailItem(Buffer.from(MAIL), 7, "raw");
    assert.deepEqual(item, { uid: 7, raw: Buffer.from(MAIL).toString("base64") });
  });
});
