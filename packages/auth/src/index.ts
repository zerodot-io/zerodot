// SPDX-License-Identifier: AGPL-3.0-only
import { type Db, firstOrganizationId, hasPendingInvitation, schema } from "@zerodot/db";
import { type BetterAuthPlugin, betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";

export type AuthOptions = {
  db: Db;
  baseURL: string;
  secret: string;
  /** Other origins that may call the auth routes. `ZERODOT_BASE_URL` is always trusted. */
  trustedOrigins?: string[];
  /** True, or a function that answers per signup (for a setting an admin can change at run time). */
  signupDisabled?: boolean | (() => boolean | Promise<boolean>);
  /** Framework plugins (cookie handling). Must be last. */
  extraPlugins?: BetterAuthPlugin[];
};

const PERSONAL_PROJECT_NAME = "Personal";

function personalSlug() {
  return `personal-${crypto.randomUUID().slice(0, 8)}`;
}

export function createAuth({
  db,
  baseURL,
  secret,
  trustedOrigins = [],
  signupDisabled = false,
  extraPlugins = [],
}: AuthOptions) {
  const auth = betterAuth({
    baseURL,
    secret,
    trustedOrigins,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const disabled =
              typeof signupDisabled === "function" ? await signupDisabled() : signupDisabled;
            if (!disabled) return;
            // Invitations still work when public signup is off.
            if (!(await hasPendingInvitation(db, user.email))) {
              throw new APIError("FORBIDDEN", { message: "Signup is disabled" });
            }
          },
          after: async (user) => {
            // Invited users join the inviting project. Do not add a personal one.
            if (await hasPendingInvitation(db, user.email)) return;
            await auth.api.createOrganization({
              body: { name: PERSONAL_PROJECT_NAME, slug: personalSlug(), userId: user.id },
            });
          },
        },
      },
      session: {
        create: {
          before: async (session) => {
            const activeOrganizationId = await firstOrganizationId(db, session.userId);
            return { data: { ...session, activeOrganizationId } };
          },
        },
      },
    },
    plugins: [organization(), ...extraPlugins],
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
