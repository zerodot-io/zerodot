// SPDX-License-Identifier: AGPL-3.0-only
import type { ResolvedCredential } from "@zerodot/engine";
import type { Client, ConnectConfig, SFTPWrapper } from "ssh2";

export const SSH_CREDENTIAL_TYPES = ["ssh"];

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The connection settings from an `ssh` credential. Empty `authType` means password. */
export function sshOptions(credential: ResolvedCredential | null): ConnectConfig {
  if (credential?.type !== "ssh") throw new Error("Pick an SSH credential");
  const { data } = credential;
  const host = text(data.host);
  const username = text(data.username);
  if (!host) throw new Error('The credential has no "host"');
  if (!username) throw new Error('The credential has no "username"');
  const options: ConnectConfig = {
    host,
    port: text(data.port) ? Number(data.port) : 22,
    username,
    readyTimeout: 15_000,
  };
  if (data.authType === "privateKey") {
    const key = text(data.privateKey);
    if (!key) throw new Error('The credential has no "privateKey"');
    options.privateKey = key;
    const passphrase = text(data.passphrase);
    if (passphrase) options.passphrase = passphrase;
  } else {
    const password = text(data.password);
    if (!password) throw new Error('The credential has no "password"');
    options.password = password;
  }
  return options;
}

/** Opens the connection. The driver loads on first use. The caller ends the client. */
export async function connectSsh(credential: ResolvedCredential | null): Promise<Client> {
  const options = sshOptions(credential);
  const { Client } = await import("ssh2");
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect(options);
  });
  // Later errors would crash the worker, if nobody listens.
  client.on("error", () => {});
  return client;
}

export type CommandResult = { exitCode: number; stdout: string; stderr: string };

const MAX_OUTPUT_BYTES = 1024 * 1024;

export function runRemoteCommand(
  client: Client,
  command: string,
  signal: AbortSignal,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const abort = () => {
        stream.close();
        reject(new Error("Run cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      const collect = (into: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) {
          stream.close();
          reject(new Error("The output of the command is too large"));
          return;
        }
        into.push(chunk);
      };
      stream.on("data", collect(out));
      stream.stderr.on("data", collect(err));
      stream.on("close", (code: number | null) => {
        signal.removeEventListener("abort", abort);
        resolve({
          exitCode: code ?? -1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
  });
}

export function openSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => (error ? reject(error) : resolve(sftp)));
  });
}
