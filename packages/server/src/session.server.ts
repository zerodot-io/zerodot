// SPDX-License-Identifier: AGPL-3.0-only
import { listMemberships, resolveMembership } from "@zerodot/db";
import { getServices } from "./services.server";

export async function sessionFor(headers: Headers) {
  const { auth, db } = await getServices();
  const session = await auth.api.getSession({ headers });
  return { session, db };
}

/** Session plus membership for a project slug. Null when signed out or not a member. */
export async function projectFor(headers: Headers, slug: string) {
  const { session, db } = await sessionFor(headers);
  if (!session) return null;
  const project = await resolveMembership(db, session.user.id, slug);
  if (!project) return null;
  return { db, user: session.user, project };
}

/** Roles are `owner`, `admin`, `member`. better-auth can store several, separated by commas. */
export function isAdmin(role: string): boolean {
  return role.split(",").some((r) => r === "owner" || r === "admin");
}

export async function projectsFor(userId: string) {
  const { db } = await getServices();
  return listMemberships(db, userId);
}
