// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import { z } from "zod";
import { IMAP_CREDENTIAL_TYPES, IMAP_FORMATS, imapOptions, toMailItem } from "./imap";

const config = z.object({
  mailbox: z.string().min(1).default("INBOX").meta({
    title: "Mailbox",
    description: "The name of the mailbox to watch, for example INBOX",
  }),
  postProcessAction: z
    .enum(["read", "nothing"])
    .default("read")
    .meta({
      title: "Action",
      description: "What to do with a mail after the run starts",
      labels: { read: "Mark as read", nothing: "Nothing" },
      hints: {
        read: "Sets the seen flag, so the mail does not start a second run",
        nothing: "Leaves the mail as it is. Each mail still starts one run",
      },
    }),
  format: z
    .enum(IMAP_FORMATS)
    .default("simple")
    .meta({
      title: "Format",
      labels: { simple: "Simple", resolved: "Resolved", raw: "Raw" },
      hints: {
        simple: "Subject, addresses, text, html, and a list of the attachments",
        resolved: "Same as simple, and the attachments as binary data",
        raw: "The whole message as base64 text",
      },
    }),
});

/** A mail that was seen is not read again for this long, in the memory of the trigger. */
const SEEN_LIMIT = 5000;

export default defineNode({
  type: "trigger.email_imap",
  label: "On new email (IMAP)",
  description: "Start a run when a new unread mail arrives in a mailbox",
  category: "trigger",
  app: "Email",
  icon: "Mail",
  config,
  defaultConfig: { mailbox: "INBOX", postProcessAction: "read", format: "simple" },
  credentialTypes: IMAP_CREDENTIAL_TYPES,
  ports: { in: [], out: ["out"] },
  subtitle: (cfg) => (typeof cfg.mailbox === "string" ? cfg.mailbox : undefined),
  // The input is the mail that started the run.
  run: ({ input }) => ({ port: "out", data: input }),
  async listen({ config: cfg, credential, signal, emit, fail }) {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow(imapOptions(credential));
    let closing = false;
    // The client does not reconnect. The worker restarts a trigger that reports a failure.
    client.on("error", (error: Error) => fail(error));
    client.on("close", () => {
      if (!closing) fail(new Error("The IMAP connection closed"));
    });
    const abort = () => {
      closing = true;
      client.close();
    };
    signal.addEventListener("abort", abort, { once: true });

    const seen = new Set<string>();
    let chain: Promise<void> = Promise.resolve();

    /** Reads the unread mails and starts a run for each one, oldest first. */
    const drain = async () => {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      const validity = String(client.mailbox ? client.mailbox.uidValidity : "");
      for (const uid of uids.sort((a, b) => a - b)) {
        const key = `${validity}:${uid}`;
        if (seen.has(key)) continue;
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message) continue;
        if (!message.source) continue;
        await emit({ key, data: await toMailItem(message.source, uid, cfg.format) });
        seen.add(key);
        if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value as string);
        if (cfg.postProcessAction === "read") {
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
        }
      }
    };
    const schedule = () => {
      chain = chain.then(drain).catch((error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    };

    try {
      await client.connect();
      // The lock stays until the trigger stops. The client sits in IDLE and tells of new mail.
      const lock = await client.getMailboxLock(cfg.mailbox);
      client.on("exists", schedule);
      schedule();
      return {
        async close() {
          closing = true;
          signal.removeEventListener("abort", abort);
          client.removeListener("exists", schedule);
          try {
            await chain;
          } finally {
            lock.release();
            await client.logout().catch(() => client.close());
          }
        },
      };
    } catch (error) {
      closing = true;
      signal.removeEventListener("abort", abort);
      client.close();
      throw error;
    }
  },
});
