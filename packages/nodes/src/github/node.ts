// SPDX-License-Identifier: AGPL-3.0-only
import { defineNode } from "@zerodot/engine";
import {
  callGithub,
  callGithubList,
  GITHUB_OAUTH2_CREDENTIAL,
  GITHUB_TOKEN_CREDENTIAL,
  type GithubAccess,
  githubAccess,
} from "./api";
import { type GithubConfig, githubConfig } from "./config";
import { buildRequest } from "./request";

/** The text of a file that the contents API sent as base64. */
function withText(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const file = data as { encoding?: unknown; content?: unknown };
  if (file.encoding !== "base64" || typeof file.content !== "string") return data;
  return { ...data, text: Buffer.from(file.content, "base64").toString("utf8") };
}

async function fileSha(
  access: GithubAccess,
  config: GithubConfig,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<string> {
  const current = (await callGithub(
    access,
    buildRequest({ ...config, operation: "get" }),
    options,
  )) as { sha?: unknown };
  if (typeof current?.sha !== "string") throw new Error("GitHub did not give the SHA of the file");
  return current.sha;
}

export default defineNode({
  type: "github.api",
  label: "GitHub",
  description: "Work with issues, repositories, files, and releases on GitHub",
  category: "integration",
  app: "GitHub",
  // The names of the actions of the GitHub node.
  actions: [
    { label: "Create an issue", config: { resource: "issue", operation: "create" } },
    {
      label: "Create a comment on an issue",
      config: { resource: "issue", operation: "createComment" },
    },
    { label: "Edit an issue", config: { resource: "issue", operation: "edit" } },
    { label: "Get an issue", config: { resource: "issue", operation: "get" } },
    { label: "Lock an issue", config: { resource: "issue", operation: "lock" } },
    { label: "Get a repository", config: { resource: "repository", operation: "get" } },
    {
      label: "Get issues of a repository",
      config: { resource: "repository", operation: "getIssues" },
    },
    {
      label: "Get pull requests of a repository",
      config: { resource: "repository", operation: "getPullRequests" },
    },
    {
      label: "Get the community profile of a repository",
      config: { resource: "repository", operation: "getProfile" },
    },
    { label: "Create a file", config: { resource: "file", operation: "create" } },
    { label: "Delete a file", config: { resource: "file", operation: "delete" } },
    { label: "Edit a file", config: { resource: "file", operation: "edit" } },
    { label: "Get a file", config: { resource: "file", operation: "get" } },
    { label: "List files in a repository", config: { resource: "file", operation: "list" } },
    { label: "Create a release", config: { resource: "release", operation: "create" } },
    { label: "Delete a release", config: { resource: "release", operation: "delete" } },
    { label: "Get a release", config: { resource: "release", operation: "get" } },
    { label: "Get many releases", config: { resource: "release", operation: "getAll" } },
    { label: "Update a release", config: { resource: "release", operation: "update" } },
    { label: "Dispatch a workflow", config: { resource: "workflow", operation: "dispatch" } },
    { label: "List workflows", config: { resource: "workflow", operation: "list" } },
  ],
  icon: "GitBranch",
  iconUrl: "/icons/github.svg",
  config: githubConfig,
  defaultConfig: {
    authentication: "accessToken",
    resource: "issue",
    operation: "get",
    owner: "",
    repository: "",
    listState: "open",
    returnAll: false,
    limit: 50,
    timeoutMs: 30_000,
  },
  credentialTypes: [GITHUB_TOKEN_CREDENTIAL, GITHUB_OAUTH2_CREDENTIAL],
  // The Authentication field says which credential type the user picks.
  credentialRules: {
    [GITHUB_TOKEN_CREDENTIAL]: { showWhen: { authentication: ["accessToken"] } },
    [GITHUB_OAUTH2_CREDENTIAL]: { showWhen: { authentication: ["oAuth2"] } },
  },
  ports: { in: ["in"], out: ["out"] },
  subtitle: (config) =>
    typeof config.operation === "string"
      ? `${String(config.resource ?? "issue")}: ${config.operation}`
      : undefined,
  async run({ config, credential, signal }) {
    const access = githubAccess(credential);
    const options = { signal, timeoutMs: config.timeoutMs };
    const request = buildRequest(config);

    if (request.list) {
      const items = await callGithubList(
        access,
        request,
        config.returnAll ? null : config.limit,
        options,
      );
      return { port: "out", data: items };
    }

    if (
      config.resource === "file" &&
      (config.operation === "edit" || config.operation === "delete") &&
      !config.sha
    ) {
      request.body = { ...request.body, sha: await fileSha(access, config, options) };
    }
    const data = await callGithub(access, request, options);
    // A lock, a delete, and a dispatch answer with no body.
    if (data === null) return { port: "out", data: { success: true } };
    return { port: "out", data: config.operation === "get" ? withText(data) : data };
  },
});
