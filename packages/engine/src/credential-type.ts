// SPDX-License-Identifier: AGPL-3.0-only
import type { z } from "zod";
import type { ResolvedCredential } from "./node";

/** How the client sends its id and secret to the token URL. */
export type OAuth2Authentication = "header" | "body";

export type OAuth2Config = {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Extra query parameters for the authorize URL, for example `access_type=offline`. */
  authQuery?: Record<string, string>;
  authentication: OAuth2Authentication;
  pkce?: boolean;
};

export type OAuth2Resolver = (data: Record<string, unknown>) => OAuth2Config | null;

export type CredentialTypeDefinition = {
  type: string;
  label: string;
  fields: z.ZodObject<Record<string, z.ZodType<string | undefined>>>;
  /** Fields the form shows as password inputs. The form never shows a saved value of any field. */
  secretFields: string[];
  /** Fields that only the server sets. The form hides them, and a client cannot write them. */
  serverFields?: string[];
  /**
   * An OAuth2 credential. A preset has fixed endpoints. A function builds the endpoints from the
   * credential data (for example a server address). `"custom"` reads `authUrl`, `tokenUrl`,
   * `scope` and `authentication` from the credential data.
   */
  oauth2?: OAuth2Config | OAuth2Resolver | "custom";
  /** Lucide icon name. */
  icon?: string;
  /** Image URL. It replaces `icon`. */
  iconUrl?: string;
  /**
   * Checks a saved credential, for the "Test" button of the credential form. It throws with a
   * short message when the credential does not work. zerodot removes secrets from the message.
   */
  test?(credential: ResolvedCredential): Promise<void>;
};
