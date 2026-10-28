// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from "node:crypto";
import { defineNode, type WebhookContext } from "@zerodot/engine";
import { z } from "zod";
import { callGithub, GITHUB_OAUTH2_CREDENTIAL, GITHUB_TOKEN_CREDENTIAL, githubAccess } from "./api";
import { AUTHENTICATION } from "./config";

export const EVENTS = [
  "*",
  "push",
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "release",
  "create",
  "delete",
  "fork",
  "watch",
  "star",
  "workflow_run",
  "check_run",
  "check_suite",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "label",
  "milestone",
  "project",
  "repository",
  "status",
] as const;

export const triggerConfig = z.object({
  authentication: z
    .enum(AUTHENTICATION)
    .default("accessToken")
    .meta({
      title: "Authentication",
      labels: { accessToken: "Access Token", oAuth2: "OAuth2" },
      hints: {
        accessToken: "A personal access token",
        oAuth2: "Sign in with a GitHub account",
      },
    }),
  owner: z
    .string()
    .min(1)
    .meta({ description: "The user or organization that owns the repository" }),
  repository: z.string().min(1),
  events: z
    .array(z.enum(EVENTS))
    .min(1)
    .default(["push"])
    .meta({
      title: "Events",
      labels: {
        "*": "All Events",
        push: "Push",
        issues: "Issues",
        issue_comment: "Issue Comment",
        pull_request: "Pull Request",
        pull_request_review: "Pull Request Review",
        pull_request_review_comment: "Pull Request Review Comment",
        release: "Release",
        create: "Create",
        delete: "Delete",
        fork: "Fork",
        watch: "Watch",
        star: "Star",
        workflow_run: "Workflow Run",
        check_run: "Check Run",
        check_suite: "Check Suite",
        deployment: "Deployment",
        deployment_status: "Deployment Status",
        discussion: "Discussion",
        discussion_comment: "Discussion Comment",
        label: "Label",
        milestone: "Milestone",
        project: "Project",
        repository: "Repository",
        status: "Status",
      },
      hints: {
        "*": "All events of the repository",
        push: "Someone pushed commits",
        issues: "An issue was opened, edited, closed, or changed",
        issue_comment: "A comment on an issue or pull request changed",
        pull_request: "A pull request was opened, closed, or changed",
        pull_request_review: "A review of a pull request was sent or changed",
        pull_request_review_comment: "A comment on the diff of a pull request changed",
        release: "A release was published or changed",
        create: "A branch or a tag was made",
        delete: "A branch or a tag was deleted",
        fork: "Someone forked the repository",
        watch: "Someone starred the repository",
        star: "Someone starred or unstarred the repository",
        workflow_run: "A GitHub Actions run was requested or finished",
        check_run: "A check run was made or changed",
        check_suite: "A check suite finished or was requested",
        deployment: "A deployment was made",
        deployment_status: "The status of a deployment changed",
        discussion: "A discussion was made or changed",
        discussion_comment: "A comment on a discussion changed",
        label: "A label was made, edited, or deleted",
        milestone: "A milestone was made, edited, or deleted",
        project: "A project was made, edited, or deleted",
        repository: "The repository was made, renamed, archived, or changed",
        status: "The status of a commit changed",
      },
    }),
});

export type GithubTriggerConfig = z.output<typeof triggerConfig>;

const TIMEOUT_MS = 15_000;

/**
 * The secret that GitHub signs each delivery with. It comes from the webhook address, which has
 * a random token. So the secret stays the same while the credential token changes.
 */
export function githubSecret(url: string): string {
  return createHmac("sha256", url).update("zerodot-github-trigger").digest("base64url");
}

/** The `x-hub-signature-256` value of a delivery. */
export function githubSignature(url: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", githubSecret(url)).update(rawBody).digest("hex")}`;
}

function signatureValid(url: string, rawBody: string, given: string | undefined): boolean {
  const wanted = Buffer.from(githubSignature(url, rawBody));
  const got = Buffer.from(given ?? "");
  return got.byteLength === wanted.byteLength && timingSafeEqual(got, wanted);
}

type HookState = { hookId?: number } | null | undefined;

const hooksPath = (c: GithubTriggerConfig) =>
  `/repos/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repository)}/hooks`;

const hookBody = (c: GithubTriggerConfig, url: string) => ({
  active: true,
  events: c.events.includes("*") ? ["*"] : c.events,
  config: { url, content_type: "json", secret: githubSecret(url), insecure_ssl: "0" },
});

export default defineNode({
  type: "trigger.github",
  label: "GitHub Trigger",
  description: "Start the workflow on an event in a GitHub repository",
  category: "trigger",
  app: "GitHub",
  icon: "GitBranch",
  iconUrl: "/icons/github.svg",
  config: triggerConfig,
  defaultConfig: { authentication: "accessToken", owner: "", repository: "", events: ["push"] },
  credentialTypes: [GITHUB_TOKEN_CREDENTIAL, GITHUB_OAUTH2_CREDENTIAL],
  credentialRules: {
    [GITHUB_TOKEN_CREDENTIAL]: { showWhen: { authentication: ["accessToken"] } },
    [GITHUB_OAUTH2_CREDENTIAL]: { showWhen: { authentication: ["oAuth2"] } },
  },
  ports: { in: [], out: ["out"] },
  subtitle: (config) =>
    typeof config.owner === "string" && config.owner !== ""
      ? `${config.owner}/${String(config.repository ?? "")}`
      : undefined,
  // The input is { event, action, delivery, body }. `body` is the payload from GitHub.
  run: ({ input }) => ({ port: "out", data: input }),
  webhook: {
    async receive({ config: raw, request, url }) {
      const config = triggerConfig.parse(raw);
      if (!signatureValid(url, request.rawBody ?? "", request.headers["x-hub-signature-256"])) {
        return { verdict: "forbidden", status: 403 };
      }
      const event = request.headers["x-github-event"] ?? "";
      // GitHub sends a ping when the webhook is made.
      if (event === "ping")
        return { verdict: "ignore", response: { status: 200, body: { ok: true } } };
      if (!config.events.includes("*") && !(config.events as string[]).includes(event)) {
        return { verdict: "ignore" };
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      return {
        verdict: "accept",
        input: {
          event,
          action: typeof body.action === "string" ? body.action : null,
          delivery: request.headers["x-github-delivery"] ?? null,
          body,
        },
      };
    },

    /** Makes the webhook at GitHub, or updates the one that has this address already. */
    async activate({ config: raw, credential, url, signal }: WebhookContext) {
      const config = triggerConfig.parse(raw);
      const access = githubAccess(credential);
      const options = { signal, timeoutMs: TIMEOUT_MS };
      const hooks = (await callGithub(
        access,
        { method: "GET", path: hooksPath(config), query: { per_page: 100 } },
        options,
      )) as { id: number; config?: { url?: string } }[];
      const existing = hooks.find((hook) => hook.config?.url === url);
      const saved = (await callGithub(
        access,
        existing
          ? {
              method: "PATCH",
              path: `${hooksPath(config)}/${existing.id}`,
              body: hookBody(config, url),
            }
          : {
              method: "POST",
              path: hooksPath(config),
              body: { name: "web", ...hookBody(config, url) },
            },
        options,
      )) as { id: number };
      return { hookId: saved.id } satisfies HookState;
    },

    /** Removes the webhook. A webhook that is gone already is fine. */
    async deactivate({ config: raw, credential, url, state, signal }: WebhookContext) {
      const config = triggerConfig.parse(raw);
      const access = githubAccess(credential);
      const options = { signal, timeoutMs: TIMEOUT_MS };
      let hookId = (state as HookState)?.hookId;
      if (hookId === undefined) {
        const hooks = (await callGithub(
          access,
          { method: "GET", path: hooksPath(config), query: { per_page: 100 } },
          options,
        )) as { id: number; config?: { url?: string } }[];
        hookId = hooks.find((hook) => hook.config?.url === url)?.id;
      }
      if (hookId === undefined) return null;
      try {
        await callGithub(
          access,
          { method: "DELETE", path: `${hooksPath(config)}/${hookId}` },
          options,
        );
      } catch (error) {
        if (!String(error).includes("(404)")) throw error;
      }
      return null;
    },
  },
});
