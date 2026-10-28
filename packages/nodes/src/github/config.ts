// SPDX-License-Identifier: AGPL-3.0-only
import { z } from "zod";

// Resource and operation names follow the GitHub REST API.

export const RESOURCES = ["issue", "repository", "file", "release", "workflow"] as const;
export type Resource = (typeof RESOURCES)[number];

export const OPERATIONS_OF = {
  issue: ["create", "createComment", "edit", "get", "lock"],
  repository: ["get", "getIssues", "getPullRequests", "getProfile"],
  file: ["get", "list", "create", "edit", "delete"],
  release: ["create", "get", "getAll", "update", "delete"],
  workflow: ["list", "dispatch"],
} as const satisfies Record<Resource, readonly string[]>;

const ALL_OPERATIONS = [...new Set(Object.values(OPERATIONS_OF).flat())] as [string, ...string[]];

export const AUTHENTICATION = ["accessToken", "oAuth2"] as const;

/** Show a field only for these operations of a resource. */
const on = (resource: Resource, ...operations: string[]) => ({
  showWhen: { resource: [resource], operation: operations },
});

const filter = on("repository", "getIssues", "getPullRequests");

export const githubConfig = z
  .object({
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
    resource: z
      .enum(RESOURCES)
      .default("issue")
      .meta({
        labels: {
          issue: "Issue",
          repository: "Repository",
          file: "File",
          release: "Release",
          workflow: "Workflow",
        },
        hints: {
          issue: "Create, edit, comment on, or lock an issue",
          repository: "Get a repository, its issues, or its pull requests",
          file: "Read, list, create, edit, or delete files in a repository",
          release: "Create, get, update, or delete releases",
          workflow: "List GitHub Actions workflows or run one",
        },
      }),
    operation: z
      .enum(ALL_OPERATIONS)
      .default("get")
      .meta({
        labels: {
          create: "Create",
          createComment: "Create Comment",
          edit: "Edit",
          get: "Get",
          lock: "Lock",
          getIssues: "Get Issues",
          getPullRequests: "Get Pull Requests",
          getProfile: "Get Community Profile",
          list: "List",
          getAll: "Get Many",
          update: "Update",
          delete: "Delete",
          dispatch: "Dispatch",
        },
        hints: {
          create: "Create a new item",
          createComment: "Add a comment to an issue",
          edit: "Change an existing item",
          get: "Get one item",
          lock: "Lock an issue",
          getIssues: "Get the issues of a repository",
          getPullRequests: "Get the pull requests of a repository",
          getProfile: "Get the community profile of a repository",
          list: "List the items in a folder or repository",
          getAll: "Get all items",
          update: "Change an existing release",
          delete: "Delete an item",
          dispatch: "Run a workflow on a branch or tag",
        },
      }),
    owner: z
      .string()
      .min(1)
      .meta({ description: "The user or organization that owns the repository" }),
    repository: z.string().min(1),
    issueNumber: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta(on("issue", "createComment", "edit", "get", "lock")),
    title: z
      .string()
      .optional()
      .meta(on("issue", "create", "edit")),
    body: z
      .string()
      .optional()
      .meta(on("issue", "create", "createComment", "edit")),
    labels: z
      .string()
      .optional()
      .meta({ ...on("issue", "create", "edit"), description: "Names with commas between" }),
    assignees: z
      .string()
      .optional()
      .meta({ ...on("issue", "create", "edit"), description: "User names with commas between" }),
    state: z
      .enum(["open", "closed"])
      .optional()
      .meta({
        ...on("issue", "edit"),
        labels: { open: "Open", closed: "Closed" },
        hints: { open: "Open the issue again", closed: "Close the issue" },
      }),
    lockReason: z
      .enum(["off-topic", "too heated", "resolved", "spam"])
      .optional()
      .meta({
        ...on("issue", "lock"),
        title: "Lock Reason",
        labels: {
          "off-topic": "Off Topic",
          "too heated": "Too Heated",
          resolved: "Resolved",
          spam: "Spam",
        },
        hints: {
          "off-topic": "The talk is not about the issue",
          "too heated": "The talk is not polite",
          resolved: "The issue is done",
          spam: "The issue has spam",
        },
      }),
    // repository lists
    listState: z
      .enum(["open", "closed", "all"])
      .default("open")
      .meta({
        ...filter,
        title: "State",
        labels: { open: "Open", closed: "Closed", all: "All" },
        hints: {
          open: "Only open items",
          closed: "Only closed items",
          all: "Open and closed items",
        },
      }),
    // files
    filePath: z
      .string()
      .optional()
      .meta({
        showWhen: { resource: ["file"], operation: ["get", "list", "create", "edit", "delete"] },
        description: "Path in the repository. Empty for the top folder of a list",
      }),
    fileContent: z
      .string()
      .optional()
      .meta({ ...on("file", "create", "edit"), ui: "code" }),
    commitMessage: z
      .string()
      .optional()
      .meta(on("file", "create", "edit", "delete")),
    branch: z
      .string()
      .optional()
      .meta({
        showWhen: { resource: ["file"], operation: ["get", "list", "create", "edit", "delete"] },
        description: "Empty means the default branch",
      }),
    sha: z
      .string()
      .optional()
      .meta({
        ...on("file", "edit", "delete"),
        description: "SHA of the file to change. Empty: zerodot reads it first",
      }),
    // releases
    tagName: z
      .string()
      .optional()
      .meta(on("release", "create", "update")),
    releaseName: z
      .string()
      .optional()
      .meta(on("release", "create", "update")),
    releaseBody: z
      .string()
      .optional()
      .meta(on("release", "create", "update")),
    targetCommitish: z
      .string()
      .optional()
      .meta(on("release", "create", "update")),
    draft: z
      .boolean()
      .optional()
      .meta(on("release", "create", "update")),
    prerelease: z
      .boolean()
      .optional()
      .meta(on("release", "create", "update")),
    releaseId: z
      .number()
      .int()
      .min(1)
      .optional()
      .meta(on("release", "get", "update", "delete")),
    // workflows
    workflowId: z
      .string()
      .optional()
      .meta({
        ...on("workflow", "dispatch"),
        description: "The ID or the file name, for example ci.yml",
      }),
    ref: z
      .string()
      .optional()
      .meta({ ...on("workflow", "dispatch"), description: "The branch or tag to run on" }),
    workflowInputs: z
      .string()
      .optional()
      .meta({ ...on("workflow", "dispatch"), ui: "code", description: "JSON object of inputs" }),
    // lists
    returnAll: z
      .boolean()
      .default(false)
      .meta({
        showWhen: {
          resource: ["repository", "release", "workflow"],
          operation: ["getIssues", "getPullRequests", "getAll", "list"],
        },
      }),
    limit: z
      .number()
      .int()
      .min(1)
      .max(5000)
      .default(50)
      .meta({
        showWhen: {
          resource: ["repository", "release", "workflow"],
          operation: ["getIssues", "getPullRequests", "getAll", "list"],
          returnAll: [false],
        },
      }),
    timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  })
  .superRefine((config, context) => {
    const operations: readonly string[] = OPERATIONS_OF[config.resource];
    if (!operations.includes(config.operation)) {
      context.addIssue({
        code: "custom",
        path: ["operation"],
        message: `"${config.operation}" is not an operation of "${config.resource}"`,
      });
    }
  });

export type GithubConfig = z.output<typeof githubConfig>;
