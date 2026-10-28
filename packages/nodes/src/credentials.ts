// SPDX-License-Identifier: AGPL-3.0-only
import type {
  CredentialTypeDefinition,
  OAuth2Authentication,
  OAuth2Config,
  OAuth2Resolver,
} from "@zerodot/engine";
import { z } from "zod";

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

const GITHUB_API = "https://api.github.com";
const GITHUB_DEFAULT_SCOPES = ["repo", "read:user"];

/**
 * GitHub, and GitHub Enterprise Server when `server` is set (its API address, for example
 * `https://ghe.example.com/api/v3`). The sign-in pages are on the host of the server.
 */
const githubOAuth2: OAuth2Resolver = (data) => {
  const server = text(data.server) ?? GITHUB_API;
  let origin: string;
  try {
    origin = server === GITHUB_API ? "https://github.com" : new URL(server).origin;
  } catch {
    return null;
  }
  const scope = text(data.scope);
  return {
    authUrl: `${origin}/login/oauth/authorize`,
    tokenUrl: `${origin}/login/oauth/access_token`,
    scopes: scope ? scope.split(/[\s,]+/).filter(Boolean) : GITHUB_DEFAULT_SCOPES,
    authentication: "body",
    pkce: true,
  };
};

export const credentialTypes: CredentialTypeDefinition[] = [
  {
    type: "http.basic",
    label: "Basic auth",
    fields: z.object({
      username: z.string().min(1).meta({ placeholder: "username" }),
      password: z.string().min(1),
    }),
    secretFields: ["password"],
    icon: "KeyRound",
  },
  {
    type: "http.bearer",
    label: "Bearer token",
    fields: z.object({ token: z.string().min(1) }),
    secretFields: ["token"],
    icon: "KeyRound",
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
    icon: "KeyRound",
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
    icon: "KeyRound",
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
    icon: "KeyRound",
  },
  {
    type: "github.token",
    label: "GitHub access token",
    fields: z.object({
      accessToken: z.string().min(1).meta({ placeholder: "ghp_…" }),
      /** The API address of GitHub Enterprise Server. Empty means github.com. */
      server: z.url().optional().meta({ placeholder: "https://api.github.com" }),
    }),
    secretFields: ["accessToken"],
    icon: "KeyRound",
    iconUrl: "/icons/github.svg",
  },
  {
    type: "github.oauth2",
    label: "GitHub OAuth2",
    fields: z.object({
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      /** The API address of GitHub Enterprise Server. Empty means github.com. */
      server: z.url().optional().meta({ placeholder: "https://api.github.com" }),
      /** Scopes, separated by spaces. Empty means `repo read:user`. */
      scope: z.string().optional().meta({ placeholder: "repo read:user" }),
      ...oauth2TokenShape,
    }),
    secretFields: ["clientSecret", "accessToken", "refreshToken"],
    serverFields: [...OAUTH2_TOKEN_FIELDS],
    oauth2: githubOAuth2,
    icon: "KeyRound",
    iconUrl: "/icons/github.svg",
  },
  {
    type: "smtp",
    label: "SMTP",
    // The fields are the usual SMTP settings. The form saves text, so the two
    // switches are "true" or "false". `secure` is on when empty.
    fields: z.object({
      user: z.string().min(1).optional().meta({ placeholder: "you@example.com" }),
      password: z.string().min(1).optional(),
      host: z.string().min(1).meta({ placeholder: "smtp.example.com" }),
      /** Empty means 465. */
      port: z
        .string()
        .regex(/^\d{1,5}$/, "Not a port number")
        .optional()
        .meta({ placeholder: "465" }),
      /** Use SSL/TLS. Empty means true. */
      secure: z.enum(["true", "false"]).optional(),
      /** Do not upgrade to TLS with STARTTLS. Only for SSL/TLS off. */
      disableStartTls: z.enum(["true", "false"]).optional(),
      /** The name of the client, to identify it to the server. */
      hostName: z.string().min(1).optional(),
    }),
    secretFields: ["password"],
    icon: "Mail",
  },
  {
    type: "imap",
    label: "IMAP",
    // The usual IMAP settings. The form saves text, so the two switches are "true" or
    // "false". `secure` is on when empty. Empty port means 993 (SSL/TLS) or 143.
    fields: z.object({
      user: z.string().min(1).meta({ placeholder: "you@example.com" }),
      password: z.string().min(1),
      host: z.string().min(1).meta({ placeholder: "imap.example.com" }),
      port: z
        .string()
        .regex(/^\d{1,5}$/, "Not a port number")
        .optional()
        .meta({ placeholder: "993" }),
      /** Use SSL/TLS. Empty means true. */
      secure: z.enum(["true", "false"]).optional(),
      allowUnauthorizedCerts: z.enum(["true", "false"]).optional(),
    }),
    secretFields: ["password"],
    icon: "Mail",
  },
  {
    type: "ssh",
    label: "SSH",
    // For the SSH and SFTP nodes. `authType` is "password" or "privateKey" (a PEM key).
    fields: z.object({
      host: z.string().min(1).meta({ placeholder: "ssh.example.com" }),
      /** Empty means 22. */
      port: z
        .string()
        .regex(/^\d{1,5}$/, "Not a port number")
        .optional()
        .meta({ placeholder: "22" }),
      username: z.string().min(1).meta({ placeholder: "root" }),
      authType: z.enum(["password", "privateKey"]).optional(),
      password: z.string().min(1).optional(),
      privateKey: z.string().min(1).optional(),
      passphrase: z.string().min(1).optional(),
    }),
    secretFields: ["password", "privateKey", "passphrase"],
    icon: "Terminal",
  },
  {
    type: "ftp",
    label: "FTP",
    fields: z.object({
      host: z.string().min(1).meta({ placeholder: "ftp.example.com" }),
      /** Empty means 21. */
      port: z
        .string()
        .regex(/^\d{1,5}$/, "Not a port number")
        .optional()
        .meta({ placeholder: "21" }),
      username: z.string().min(1).optional().meta({ placeholder: "anonymous" }),
      password: z.string().min(1).optional(),
      /** Use FTPS (TLS). Empty means false. */
      secure: z.enum(["true", "false"]).optional(),
    }),
    secretFields: ["password"],
    icon: "FolderOpen",
  },
  {
    type: "s3",
    label: "S3",
    // For Amazon S3 and for S3-compatible services (MinIO, Cloudflare R2, Backblaze B2, and so
    // on). Empty means: region us-east-1, the Amazon endpoint. A custom endpoint uses path-style
    // addresses, unless `forcePathStyle` is "false".
    fields: z.object({
      accessKeyId: z.string().min(1).meta({ placeholder: "AKIA…" }),
      secretAccessKey: z.string().min(1),
      sessionToken: z.string().min(1).optional(),
      region: z.string().min(1).optional().meta({ placeholder: "us-east-1" }),
      /** The address of an S3-compatible service, for example `https://minio.example.com`. */
      endpoint: z.url().optional().meta({ placeholder: "https://s3.example.com" }),
      forcePathStyle: z.enum(["true", "false"]).optional(),
    }),
    secretFields: ["secretAccessKey", "sessionToken"],
    icon: "HardDrive",
    iconUrl: "/icons/amazon-s3.svg",
  },
  {
    type: "telegram.bot",
    label: "Telegram bot",
    fields: z.object({
      accessToken: z.string().min(1).meta({ placeholder: "123456:ABC-DEF…" }),
      baseUrl: z.url().optional().meta({ placeholder: "https://api.telegram.org" }),
    }),
    secretFields: ["accessToken"],
    icon: "Send",
    iconUrl: "/icons/telegram.svg",
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
  fieldsSchema: z.toJSONSchema(t.fields),
});

export const credentialTypeCatalog: CredentialTypeCatalogEntry[] =
  credentialTypes.map(catalogEntry);

/** The entries that `registerCredentialType` added. The browser does not have them in its bundle. */
export const addedCredentialTypeCatalog: CredentialTypeCatalogEntry[] = [];

/** Adds a credential type at start-up, for example one that a node package brings. */
export function registerCredentialType(definition: CredentialTypeDefinition): void {
  if (credentialTypeByName.has(definition.type)) return;
  credentialTypes.push(definition);
  credentialTypeByName.set(definition.type, definition);
  const entry = catalogEntry(definition);
  credentialTypeCatalog.push(entry);
  addedCredentialTypeCatalog.push(entry);
}

/** The browser calls this with the entries that the server added. A known type is skipped. */
export function mergeCredentialTypeCatalog(entries: CredentialTypeCatalogEntry[]): void {
  for (const entry of entries) {
    if (!credentialTypeCatalog.some((known) => known.type === entry.type)) {
      credentialTypeCatalog.push(entry);
    }
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
