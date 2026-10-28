// SPDX-License-Identifier: AGPL-3.0-only

import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { checkVariableValue, MAX_VARIABLES, variableInputSchema } from "@zerodot/engine";
import { testCredential, validateCredentialData } from "@zerodot/nodes";
import { z } from "zod";
import { asJson } from "../lib/json";

const slugInput = z.object({ projectSlug: z.string().min(1) });

/** Any member can read names. Only owners and admins change credentials and variables. */
export const projectFor = createServerOnlyFn(
  async (slug: string, options: { admin?: boolean } = {}) => {
    const { forOrganization } = await import("@zerodot/db");
    const { requireProject, isAdmin } = await import("./session.server");
    const { getServices } = await import("@zerodot/server/services.server");
    const ctx = await requireProject(slug);
    if (!ctx) throw new Error("Not found");
    if (options.admin && !isAdmin(ctx.project.role)) {
      throw new Error("Only an owner or an admin can do this");
    }
    const { secretKey, config } = await getServices();
    return {
      ...ctx,
      scope: forOrganization(ctx.db, ctx.project.organizationId, {
        secretKey,
        tableMaxRows: config.ZERODOT_TABLE_MAX_ROWS,
      }),
    };
  },
);

// @zerodot/db loads on demand. A static import would put it in the browser bundle.
async function conflictToMessage(error: unknown): Promise<never> {
  const { ConflictError } = await import("@zerodot/db");
  if (error instanceof ConflictError) throw new Error(error.message);
  throw error;
}

// ---- Credentials. No function here returns a credential value. ----

export const listCredentialsFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return ctx.scope.credentials.list();
  });

export const createCredentialFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      name: z.string().trim().min(1).max(80),
      type: z.string().min(1),
      fields: z.record(z.string(), z.string()),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const problem = validateCredentialData(data.type, data.fields);
    if (problem) throw new Error(problem);
    return ctx.scope.credentials
      .create({ name: data.name, type: data.type, data: data.fields })
      .catch(conflictToMessage);
  });

export const updateCredentialFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      id: z.string().uuid(),
      name: z.string().trim().min(1).max(80).optional(),
      // Fields left empty keep their saved value.
      fields: z.record(z.string(), z.string()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const patch = Object.fromEntries(Object.entries(data.fields ?? {}).filter(([, v]) => v !== ""));
    const current = (await ctx.scope.credentials.list()).find((c) => c.id === data.id);
    if (!current) throw new Error("Not found");
    const problem = validateCredentialData(current.type, patch, { partial: true });
    if (problem) throw new Error(problem);
    const row = await ctx.scope.credentials
      .update(data.id, { name: data.name, patch })
      .catch(conflictToMessage);
    if (!row) throw new Error("Not found");
    return row;
  });

/** The address to register at the OAuth2 provider. */
export const oauth2RedirectUrlFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    await projectFor(data.projectSlug, { admin: true });
    const { oauth2RedirectUrl } = await import("@zerodot/server/oauth2.server");
    return { url: await oauth2RedirectUrl() };
  });

/** Returns the provider URL. The browser goes there. The tokens never reach the browser. */
export const startOAuth2Fn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const { startOAuth2 } = await import("@zerodot/server/oauth2.server");
    const url = await startOAuth2({
      organizationId: ctx.project.organizationId,
      projectSlug: data.projectSlug,
      userId: ctx.user.id,
      credentialId: data.id,
    });
    return { url };
  });

/**
 * Tries to connect. The result has no credential value.
 * With `id`, it uses the saved values. Non-empty `fields` replace them, and nothing is saved.
 * Without `id`, it tests `fields` of `type`.
 */
export const testCredentialFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      id: z.string().uuid().optional(),
      type: z.string().min(1).optional(),
      fields: z.record(z.string(), z.string()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const patch = Object.fromEntries(Object.entries(data.fields ?? {}).filter(([, v]) => v !== ""));
    if (data.id) {
      const opened = await ctx.scope.credentials.open(data.id);
      if (!opened) throw new Error("Not found");
      const merged = { ...opened.data, ...patch };
      const problem = validateCredentialData(opened.type, merged);
      if (problem) throw new Error(problem);
      return testCredential({ type: opened.type, data: merged });
    }
    if (!data.type) throw new Error("Type is required");
    const problem = validateCredentialData(data.type, patch);
    if (problem) throw new Error(problem);
    return testCredential({ type: data.type, data: patch });
  });

export const credentialUsageFn = createServerFn({ method: "GET" })
  .validator(slugInput.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return ctx.scope.credentials.usedBy(data.id);
  });

export const deleteCredentialFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ id: z.string().uuid() }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const users = await ctx.scope.credentials.usedBy(data.id);
    if (users.length > 0) {
      throw new Error(`In use by: ${users.map((w) => w.name).join(", ")}. Remove it there first.`);
    }
    return { deleted: await ctx.scope.credentials.remove(data.id) };
  });

// ---- Variables ----

const variableRow = (v: {
  key: string;
  type: "string" | "number" | "boolean" | "json";
  value: unknown;
  description: string;
  updatedAt: Date;
}) => ({
  key: v.key,
  type: v.type,
  value: asJson(v.value),
  description: v.description,
  updatedAt: v.updatedAt,
});

export const listVariablesFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return (await ctx.scope.variables.list()).map(variableRow);
  });

export const createVariableFn = createServerFn({ method: "POST" })
  .validator(slugInput.and(variableInputSchema))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    if ((await ctx.scope.variables.count()) >= MAX_VARIABLES) {
      throw new Error(`A project can have ${MAX_VARIABLES} variables`);
    }
    const row = await ctx.scope.variables
      .create(
        { key: data.key, type: data.type, value: data.value, description: data.description },
        ctx.user.id,
      )
      .catch(conflictToMessage);
    return variableRow(row);
  });

export const updateVariableFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      key: z.string().min(1),
      type: z.enum(["string", "number", "boolean", "json"]),
      value: z.unknown(),
      description: z.string().max(500),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const problem = checkVariableValue(data.type, data.value);
    if (problem) throw new Error(problem);
    const row = await ctx.scope.variables.update(
      data.key,
      { type: data.type, value: data.value, description: data.description },
      ctx.user.id,
    );
    if (!row) throw new Error("Not found");
    return variableRow(row);
  });

export const variableUsageFn = createServerFn({ method: "GET" })
  .validator(slugInput.extend({ key: z.string().min(1) }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return ctx.scope.variables.usedBy(data.key);
  });

export const deleteVariableFn = createServerFn({ method: "POST" })
  .validator(slugInput.extend({ key: z.string().min(1) }))
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    return { deleted: await ctx.scope.variables.remove(data.key) };
  });

// ---- MCP servers (the editor lists the tools of an MCP Call Tool node) ----

const MCP_LIST_TIMEOUT_MS = 15_000;

/** Connects with the chosen credential on the server. The credential never goes to the browser. */
export const listMcpToolsFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({ url: z.string().url(), credentialId: z.string().uuid().nullable() }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    const credential = data.credentialId
      ? await ctx.scope.credentials.open(data.credentialId)
      : null;
    if (data.credentialId && !credential) throw new Error("The credential does not exist");
    try {
      const { listMcpTools } = await import("@zerodot/server/mcp-tools.server");
      const tools = await listMcpTools({
        url: data.url,
        credential: credential && { type: credential.type, data: credential.data },
        signal: AbortSignal.timeout(MCP_LIST_TIMEOUT_MS),
        timeoutMs: MCP_LIST_TIMEOUT_MS,
      });
      return tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: asJson(t.inputSchema),
      }));
    } catch (error) {
      // The message can name the credential in a header echo. Show a fixed text and the cause.
      const reason = error instanceof Error ? error.message : "unknown error";
      throw new Error(`Could not read the tools of this MCP server: ${reason}`);
    }
  });

// ---- Project settings ----

export const getSettingsFn = createServerFn({ method: "GET" })
  .validator(slugInput)
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug);
    return ctx.scope.settings.get();
  });

export const setSettingsFn = createServerFn({ method: "POST" })
  .validator(
    slugInput.extend({
      // Null uses the server default.
      runRetentionDays: z.number().int().min(1).max(3650).nullable().optional(),
      // Null uses UTC.
      timezone: z
        .string()
        .refine((zone) => {
          try {
            new Intl.DateTimeFormat("en", { timeZone: zone });
            return true;
          } catch {
            return false;
          }
        }, "Unknown time zone")
        .nullable()
        .optional(),
    }),
  )
  .handler(async ({ data }) => {
    const ctx = await projectFor(data.projectSlug, { admin: true });
    const saved = await ctx.scope.settings.set({
      runRetentionDays: data.runRetentionDays,
      timezone: data.timezone,
    });
    if (data.timezone !== undefined) {
      const { syncProjectSchedules } = await import("@zerodot/server/schedules.server");
      await syncProjectSchedules(ctx.project.organizationId);
    }
    return saved;
  });
