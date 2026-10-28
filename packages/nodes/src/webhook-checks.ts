// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

/** Link previewers and crawlers. A request from one of them does not start a run. */
const BOT_AGENT =
  /bot\b|crawl|spider|slurp|facebookexternalhit|embedly|whatsapp|preview|mediapartners/i;

export function isBot(userAgent: string | undefined): boolean {
  return userAgent !== undefined && BOT_AGENT.test(userAgent);
}

/** Compares two secrets in constant time. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return null;
    value = value * 256 + Number(part);
  }
  return value;
}

/**
 * `list` is a comma separated list of origins. `*` allows all. An entry can start its host with
 * `*.` to allow all subdomains: `https://*.example.com`. The scheme and port must match.
 * Returns the origin to put in the CORS header, or null.
 */
export function originAllowed(origin: string | null, list: string): string | null {
  const entries = list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.includes("*")) return "*";
  if (!origin) return null;
  if (entries.includes(origin)) return origin;
  let given: URL;
  try {
    given = new URL(origin);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const wild = /^([a-z][a-z0-9+.-]*:)\/\/\*\.(.+)$/i.exec(entry);
    if (!wild) continue;
    let pattern: URL;
    try {
      pattern = new URL(`${wild[1]}//${wild[2]}`);
    } catch {
      continue;
    }
    // The wildcard needs at least one label before the dot.
    if (
      given.protocol === pattern.protocol &&
      given.port === pattern.port &&
      given.hostname.endsWith(`.${pattern.hostname}`)
    ) {
      return origin;
    }
  }
  return null;
}

/** `list` is a comma separated list of addresses. An IPv4 entry can be a range: `10.0.0.0/8`. */
export function ipAllowed(ip: string | null | undefined, list: string): boolean {
  if (!ip) return false;
  const address = ip.replace(/^::ffff:/i, "");
  const addressNumber = ipv4ToNumber(address);
  for (const raw of list.split(",")) {
    const entry = raw.trim().replace(/^::ffff:/i, "");
    if (entry === "") continue;
    const [base = "", bits] = entry.split("/");
    if (bits === undefined) {
      if (entry.toLowerCase() === address.toLowerCase()) return true;
      continue;
    }
    const baseNumber = ipv4ToNumber(base);
    const size = Number(bits);
    if (addressNumber === null || baseNumber === null) continue;
    if (!Number.isInteger(size) || size < 0 || size > 32) continue;
    const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
    if ((addressNumber & mask) >>> 0 === (baseNumber & mask) >>> 0) return true;
  }
  return false;
}

const HASH: Record<string, string> = { "256": "sha256", "384": "sha384", "512": "sha512" };

/**
 * Checks a JWT: the signature, `exp` and `nbf`. `algorithm` comes from the credential, never from
 * the token header, so a token cannot choose a weaker algorithm.
 */
export function jwtValid(
  token: string,
  key: { algorithm: string; secret?: string; publicKey?: string },
): boolean {
  const parts = token.split(".");
  const [head, payload, signature] = parts;
  if (parts.length !== 3 || !head || !payload || !signature) return false;
  const family = key.algorithm.slice(0, 2);
  const hash = HASH[key.algorithm.slice(2)];
  if (!hash) return false;
  try {
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== key.algorithm) return false;
    const signed = Buffer.from(`${head}.${payload}`);
    const given = Buffer.from(signature, "base64url");
    if (family === "HS") {
      if (!key.secret) return false;
      const expected = createHmac(hash, key.secret).update(signed).digest();
      if (given.byteLength !== expected.byteLength || !timingSafeEqual(given, expected)) {
        return false;
      }
    } else {
      if (!key.publicKey) return false;
      const publicKey = createPublicKey(key.publicKey);
      const ok =
        family === "ES"
          ? verify(hash, signed, { key: publicKey, dsaEncoding: "ieee-p1363" }, given)
          : family === "PS"
            ? verify(hash, signed, { key: publicKey, padding: 6 }, given)
            : family === "RS"
              ? verify(hash, signed, publicKey, given)
              : false;
      if (!ok) return false;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: unknown;
      nbf?: unknown;
    };
    const now = Date.now() / 1000;
    if (typeof claims.exp === "number" && now >= claims.exp) return false;
    if (typeof claims.nbf === "number" && now < claims.nbf) return false;
    return true;
  } catch {
    return false;
  }
}
