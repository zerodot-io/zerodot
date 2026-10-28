// SPDX-License-Identifier: AGPL-3.0-only
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Layout of a sealed value: version (1 byte), iv (12), auth tag (16), cipher text.
const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** ZERODOT_SECRET_KEY is 32 bytes, base64. */
export function parseSecretKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ZERODOT_SECRET_KEY must be 32 bytes in base64. Make one with: openssl rand -base64 32",
    );
  }
  return key;
}

/**
 * AES-256-GCM. `aad` binds the value to its owner (the organization id),
 * so a copied row does not open in another organization.
 */
export function seal(key: Buffer, value: unknown, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer, aad: string): unknown {
  if (sealed.length < 1 + IV_BYTES + TAG_BYTES || sealed[0] !== VERSION) {
    throw new Error("Unknown credential format");
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
  } catch {
    throw new Error(
      "Could not decrypt the credential. Is ZERODOT_SECRET_KEY the key that sealed it?",
    );
  }
}
