// SPDX-License-Identifier: AGPL-3.0-only
import { findWorkflowShare, useWorkflowShare } from "@zerodot/db";
import { getServices } from "./services.server";
import { verifySharePassword } from "./share-password";

/** Wrong passwords that one share link accepts in one window, before it refuses all tries. */
const MAX_TRIES = 10;
const TRY_WINDOW_SECONDS = 300;

export type ShareRead =
  | { status: "ok"; file: unknown }
  | { status: "not-found" }
  | { status: "used" }
  | { status: "import-only" }
  | { status: "password"; wrong: boolean }
  | { status: "too-many" };

/**
 * Reads a share link. The caller has no session. A protected link needs its password. A
 * single-use link gives its file once, after the password check.
 */
export async function readShare(
  token: string,
  password: string | null,
  /** True when a zerodot import reads the link. A chat preview must not use a single-use link. */
  importing: boolean,
): Promise<ShareRead> {
  const { db, redis } = await getServices();
  const share = token.length <= 64 ? await findWorkflowShare(db, token) : null;
  if (!share) return { status: "not-found" };
  if (share.usedAt) return { status: "used" };
  if (share.singleUse && !importing) return { status: "import-only" };
  const give = async (): Promise<ShareRead> => {
    if (!share.singleUse) return { status: "ok", file: share.file };
    const used = await useWorkflowShare(db, token);
    return used ? { status: "ok", file: used.file } : { status: "used" };
  };
  if (share.passwordHash === null) return give();
  if (!password) return { status: "password", wrong: false };
  const key = `zerodot:share-tries:${token}`;
  const tries = Number((await redis.get(key)) ?? 0);
  if (tries >= MAX_TRIES) return { status: "too-many" };
  if (await verifySharePassword(password, share.passwordHash)) return give();
  await redis.multi().incr(key).expire(key, TRY_WINDOW_SECONDS).exec();
  return { status: "password", wrong: true };
}
