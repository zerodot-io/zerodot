// SPDX-License-Identifier: AGPL-3.0-only
// Used only by `better-auth generate`. Not imported at runtime.

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

export const auth = betterAuth({
  database: drizzleAdapter({} as never, { provider: "pg" }),
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});
