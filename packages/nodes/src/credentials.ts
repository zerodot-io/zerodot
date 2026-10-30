// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CredentialTypeDefinition,
  OAuth2Authentication,
  OAuth2Config,
  OAuth2Resolver,
} from "@zerodot/engine";
import { z } from "zod";
import { kept } from "./kept";
import { sentSchemas } from "./schema-copies";

export type { CredentialTypeDefinition, OAuth2Authentication, OAuth2Config, OAuth2Resolver };

/** Fields that only the server writes, after the user connects the account. */
export const OAUTH2_TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "expiresAt",
  "tokenType",
  "grantedScope",
] as const;

/** Text fields for the token. The user cannot set them. */
const oauth2TokenShape = {
  accessToken: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  /** ISO 8601 time. */
  expiresAt: z.iso.datetime().optional(),
  tokenType: z.string().min(1).optional(),
  grantedScope: z.string().optional(),
};

export const JWT_ALGORITHMS = [
  "HS256",
  "HS384",
  "HS512",
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
] as const;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

export const credentialTypes: CredentialTypeDefinition[] = [
  {
    type: "http.basic",
    label: "Basic auth",
    fields: z.object({
      username: z.string().min(1).meta({ placeholder: "username" }),
      password: z.string().min(1),
    }),
    secretFields: ["password"],
    icon: "Key01Icon",
  },
  {
    type: "http.bearer",
    label: "Bearer token",
    fields: z.object({ token: z.string().min(1) }),
    secretFields: ["token"],
    icon: "Key01Icon",
  },
  {
    type: "http.header",
    label: "Header auth",
    fields: z.object({
      name: z
        .string()
        .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "Not a valid header name")
        .meta({ placeholder: "X-API-Key" }),
      value: z.string().min(1),
    }),
    secretFields: ["value"],
    icon: "Key01Icon",
  },
  {
    type: "jwt.auth",
    label: "JWT auth",
    // HS* algorithms use `secret`. RS*, PS* and ES* algorithms use `publicKey` (PEM).
    fields: z.object({
      algorithm: z.enum(JWT_ALGORITHMS),
      secret: z.string().min(1).optional(),
      publicKey: z.string().min(1).optional(),
    }),
    secretFields: ["secret"],
    icon: "Key01Icon",
  },
  {
    type: "oauth2.generic",
    label: "OAuth2",
    fields: z.object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      authUrl: z.url(),
      tokenUrl: z.url(),
      /** Scopes, separated by spaces. */
      scope: z.string().optional(),
      authentication: z.enum(["header", "body"]).optional(),
      ...oauth2TokenShape,
    }),
    secretFields: ["clientSecret", "accessToken", "refreshToken"],
    serverFields: [...OAUTH2_TOKEN_FIELDS],
    oauth2: "custom",
    icon: "Key01Icon",
  },
];

export const credentialTypeByName = new Map(credentialTypes.map((t) => [t.type, t]));

export type CredentialTypeCatalogEntry = {
  type: string;
  label: string;
  secretFields: string[];
  /** Fields that the form must not show. Only the server sets them. */
  serverFields: string[];
  /** True for a type that connects an account with OAuth2. */
  oauth2: boolean;
  icon?: string;
  iconUrl?: string;
  /** JSON Schema of the fields. The form is built from it. */
  fieldsSchema: unknown;
};

const catalogEntry = (t: CredentialTypeDefinition): CredentialTypeCatalogEntry => ({
  type: t.type,
  label: t.label,
  secretFields: t.secretFields,
  serverFields: t.serverFields ?? [],
  oauth2: t.oauth2 !== undefined,
  icon: t.icon,
  iconUrl: t.iconUrl,
  fieldsSchema: sentSchemas.get(t.fields) ?? z.toJSONSchema(t.fields),
});

export const credentialTypeCatalog: CredentialTypeCatalogEntry[] =
  credentialTypes.map(catalogEntry);

/** The entries that `registerCredentialType` added. The browser does not have them in its bundle. */
export const addedCredentialTypeCatalog: CredentialTypeCatalogEntry[] = [];

/** The credential types that packages added. They stay when this module runs again (see `kept`). */
const addedCredentialTypes = kept("addedCredentialTypes", (): CredentialTypeDefinition[] => []);

function addCredentialType(definition: CredentialTypeDefinition): void {
  credentialTypes.push(definition);
  credentialTypeByName.set(definition.type, definition);
  const entry = catalogEntry(definition);
  credentialTypeCatalog.push(entry);
  addedCredentialTypeCatalog.push(entry);
}

/** Adds a credential type at start-up, for example one that a node package brings. */
export function registerCredentialType(definition: CredentialTypeDefinition): void {
  if (credentialTypeByName.has(definition.type)) return;
  addCredentialType(definition);
  addedCredentialTypes.push(definition);
}

for (const definition of addedCredentialTypes) {
  if (!credentialTypeByName.has(definition.type)) addCredentialType(definition);
}

/** Removes credential types that `registerCredentialType` added, for example on a package upgrade. */
export function unregisterCredentialTypes(types: string[]): void {
  for (const type of types) {
    if (!addedCredentialTypeCatalog.some((entry) => entry.type === type)) continue;
    credentialTypeByName.delete(type);
    for (const list of [
      credentialTypes,
      credentialTypeCatalog,
      addedCredentialTypeCatalog,
      addedCredentialTypes,
    ] as {
      type: string;
    }[][]) {
      const at = list.findIndex((entry) => entry.type === type);
      if (at >= 0) list.splice(at, 1);
    }
  }
}

/** The browser calls this with the entries that the server added. A known entry is replaced. */
export function mergeCredentialTypeCatalog(entries: CredentialTypeCatalogEntry[]): void {
  for (const entry of entries) {
    const at = credentialTypeCatalog.findIndex((known) => known.type === entry.type);
    if (at >= 0) credentialTypeCatalog[at] = entry;
    else credentialTypeCatalog.push(entry);
  }
}

/** Returns an error message, or null when `data` has the fields this credential type needs. */
export function validateCredentialData(
  type: string,
  data: unknown,
  options: { partial?: boolean; trusted?: boolean } = {},
): string | null {
  const definition = credentialTypeByName.get(type);
  if (!definition) return `Unknown credential type "${type}"`;
  if (!options.trusted && typeof data === "object" && data !== null) {
    const forbidden = (definition.serverFields ?? []).filter((field) => field in data);
    if (forbidden.length > 0) return `${forbidden.join(", ")}: set by the server`;
  }
  const schema = options.partial ? definition.fields.partial() : definition.fields;
  const result = schema.strict().safeParse(data);
  return result.success
    ? null
    : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * The OAuth2 settings of a credential. Returns null when the type is not OAuth2, or when a custom
 * credential has no usable URLs.
 */
export function oauth2ConfigOf(type: string, data: Record<string, unknown>): OAuth2Config | null {
  const oauth2 = credentialTypeByName.get(type)?.oauth2;
  if (!oauth2) return null;
  if (typeof oauth2 === "function") return oauth2(data);
  if (oauth2 !== "custom") return oauth2;
  const authUrl = text(data.authUrl);
  const tokenUrl = text(data.tokenUrl);
  if (!authUrl || !tokenUrl) return null;
  return {
    authUrl,
    tokenUrl,
    scopes: (text(data.scope) ?? "").split(/\s+/).filter(Boolean),
    authentication: data.authentication === "body" ? "body" : "header",
    pkce: true,
  };
}
