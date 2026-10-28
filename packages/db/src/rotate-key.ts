// SPDX-License-Identifier: AGPL-3.0-only
// Re-seal all credentials with a new key.
//   ZERODOT_SECRET_KEY=<old> ZERODOT_NEW_SECRET_KEY=<new> DATABASE_URL=... pnpm run rotate-key
// Then set ZERODOT_SECRET_KEY to the new key in every service and restart them.
import { createDb } from "./client";
import { parseSecretKey } from "./crypto";
import { rotateSecretKey } from "./scoped-credentials";

const url = process.env.DATABASE_URL;
const oldRaw = process.env.ZERODOT_SECRET_KEY;
const newRaw = process.env.ZERODOT_NEW_SECRET_KEY;
if (!url || !oldRaw || !newRaw) {
  console.error("Set DATABASE_URL, ZERODOT_SECRET_KEY (old key), and ZERODOT_NEW_SECRET_KEY.");
  process.exit(1);
}

const handle = createDb(url);
try {
  const count = await rotateSecretKey(handle.db, parseSecretKey(oldRaw), parseSecretKey(newRaw));
  console.log(`Re-sealed ${count} credential(s). Now use the new key as ZERODOT_SECRET_KEY.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await handle.close();
}
