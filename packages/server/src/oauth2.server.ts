// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from "node:crypto";
import { forOrganization } from "@zerodot/db";
import {
  buildAuthorizeUrl,
  checkOAuth2Endpoint,
  exchangeAuthorizationCode,
  oauth2ConfigOf,
  pkceChallenge,
} from "@zerodot/nodes";
import { getServices } from "./services.server";
import { isAdmin, projectFor } from "./session.server";

/** A person has this long to allow access at the provider. */
const STATE_TTL_SECONDS = 600;

type PendingConnect = {
  organizationId: string;
  projectSlug: string;
  credentialId: string;
  userId: string;
  verifier: string;
};

const stateKey = (state: string) => `oauth2:state:${state}`;

/** The address that the user registers at the provider. It comes from ZERODOT_BASE_URL only. */
export async function oauth2RedirectUrl(): Promise<string> {
  const { config } = await getServices();
  return new URL("/oauth2/callback", config.ZERODOT_BASE_URL).toString();
}

/**
 * Starts the connect flow for a credential. Returns the URL of the provider. The caller checked
 * that the user is an owner or an admin of the project.
 */
export async function startOAuth2(input: {
  organizationId: string;
  projectSlug: string;
  userId: string;
  credentialId: string;
}): Promise<string> {
  const { db, secretKey, redis, config } = await getServices();
  const scope = forOrganization(db, input.organizationId, { secretKey });
  const opened = await scope.credentials.open(input.credentialId);
  if (!opened) throw new Error("Not found");
  const oauth2 = oauth2ConfigOf(opened.type, opened.data);
  if (!oauth2) throw new Error("This credential does not use OAuth2, or its URLs are not set");
  for (const url of [oauth2.authUrl, oauth2.tokenUrl]) {
    const problem = checkOAuth2Endpoint(url);
    if (problem) throw new Error(`${problem}: ${url}`);
  }
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const pending: PendingConnect = {
    organizationId: input.organizationId,
    projectSlug: input.projectSlug,
    credentialId: input.credentialId,
    userId: input.userId,
    verifier,
  };
  await redis.set(stateKey(state), JSON.stringify(pending), "EX", STATE_TTL_SECONDS);
  return buildAuthorizeUrl(oauth2, opened.data, {
    redirectUri: new URL("/oauth2/callback", config.ZERODOT_BASE_URL).toString(),
    state,
    challenge: pkceChallenge(verifier),
  });
}

const back = (projectSlug: string | null, status: string, message?: string): Response => {
  const path = projectSlug ? `/p/${encodeURIComponent(projectSlug)}/credentials` : "/";
  const query = new URLSearchParams({ oauth2: status });
  if (message) query.set("message", message);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${path}?${query}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
};

/**
 * The provider sends the user here with `code` and `state`. The state is single use and belongs
 * to one user. Tokens go into the credential. No token or code goes into a message or a log.
 */
export async function handleOAuth2Callback(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const { db, secretKey, redis, config } = await getServices();

  // GETDEL: a state works once, also for two requests at the same time.
  const raw = state ? await redis.getdel(stateKey(state)) : null;
  if (!raw) return back(null, "error", "The connect link expired. Try again.");
  const pending = JSON.parse(raw) as PendingConnect;

  const ctx = await projectFor(request.headers, pending.projectSlug);
  if (
    !ctx ||
    ctx.user.id !== pending.userId ||
    ctx.project.organizationId !== pending.organizationId ||
    !isAdmin(ctx.project.role)
  ) {
    return back(null, "error", "Sign in as the user who started the connection.");
  }

  const providerError = url.searchParams.get("error");
  if (providerError) {
    return back(pending.projectSlug, "error", `The provider answered: ${providerError}`);
  }
  const code = url.searchParams.get("code");
  if (!code) return back(pending.projectSlug, "error", "The provider sent no code.");

  const scope = forOrganization(db, pending.organizationId, { secretKey });
  try {
    const result = await scope.credentials.refresh(pending.credentialId, async (current) => ({
      data: await exchangeAuthorizationCode(current.type, current.data, {
        code,
        redirectUri: new URL("/oauth2/callback", config.ZERODOT_BASE_URL).toString(),
        verifier: pending.verifier,
      }),
    }));
    if (!result) return back(pending.projectSlug, "error", "The credential does not exist.");
  } catch (error) {
    return back(pending.projectSlug, "error", error instanceof Error ? error.message : "Failed");
  }
  return back(pending.projectSlug, "connected");
}
