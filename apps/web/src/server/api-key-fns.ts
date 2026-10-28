// SPDX-License-Identifier: AGPL-3.0-only
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { projectFor } from "./settings-fns";

const slugInput = z.object({ projectSlug: z.string().min(1) });
const DAY_MS = 86_400_000;

// Keys give API and MCP access to the whole project. Only an owner or an admin manages them.
const ADMIN = { admin: true } as const;

export const listApiKeysFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, ADMIN);
    return ctx.scope.apiKeys.list();
  });

/** The full key is in this answer once. The server keeps only a hash. */
export const createApiKeyFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      name: z.string().trim().min(1).max(80),
      role: z.enum(["admin", "member"]),
      expiresInDays: z.number().int().min(1).max(3650).nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, ADMIN);
    return ctx.scope.apiKeys.create({
      name: data.name,
      role: data.role,
      expiresAt: data.expiresInDays ? new Date(Date.now() + data.expiresInDays * DAY_MS) : null,
      userId: ctx.user.id,
    });
  });

export const deleteApiKeyFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, ADMIN);
    return { deleted: await ctx.scope.apiKeys.remove(data.id) };
  });
