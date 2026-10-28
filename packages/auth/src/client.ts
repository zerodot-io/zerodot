// SPDX-License-Identifier: AGPL-3.0-only
import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({ plugins: [organizationClient()] });
