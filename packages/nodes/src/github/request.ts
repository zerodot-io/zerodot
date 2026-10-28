// SPDX-License-Identifier: AGPL-3.0-only
import type { GithubRequest } from "./api";
import type { GithubConfig } from "./config";

const seg = encodeURIComponent;

const list = (text: string | undefined): string[] | undefined => {
  const items = text
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? items : undefined;
};

const need = <T>(value: T | undefined, name: string, operation: string): T => {
  if (value === undefined || value === "") throw new Error(`"${name}" is needed to ${operation}`);
  return value;
};

const compact = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));

const parseInputs = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text?.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('"workflowInputs" must be a JSON object');
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error('"workflowInputs" must be a JSON object');
  }
  return value as Record<string, unknown>;
};

/** The path of a file. Each part is escaped, the slashes stay. */
const filePathOf = (path: string | undefined) =>
  (path ?? "").split("/").filter(Boolean).map(seg).join("/");

const contents = (repo: string, path: string | undefined) => {
  const escaped = filePathOf(path);
  return escaped ? `${repo}/contents/${escaped}` : `${repo}/contents`;
};

/** The API call for one operation, without the network. A list returns `list: true`. */
export function buildRequest(c: GithubConfig): GithubRequest & { list?: boolean } {
  const repo = `/repos/${seg(c.owner)}/${seg(c.repository)}`;
  const op = `${c.resource}.${c.operation}`;
  const issue = () => `${repo}/issues/${need(c.issueNumber, "issueNumber", op)}`;

  switch (op) {
    case "issue.create":
      return {
        method: "POST",
        path: `${repo}/issues`,
        body: compact({
          title: need(c.title, "title", op),
          body: c.body,
          labels: list(c.labels),
          assignees: list(c.assignees),
        }),
      };
    case "issue.createComment":
      return {
        method: "POST",
        path: `${issue()}/comments`,
        body: { body: need(c.body, "body", op) },
      };
    case "issue.edit":
      return {
        method: "PATCH",
        path: issue(),
        body: compact({
          title: c.title,
          body: c.body,
          state: c.state,
          labels: list(c.labels),
          assignees: list(c.assignees),
        }),
      };
    case "issue.get":
      return { method: "GET", path: issue() };
    case "issue.lock":
      return {
        method: "PUT",
        path: `${issue()}/lock`,
        body: compact({ lock_reason: c.lockReason }),
      };

    case "repository.get":
      return { method: "GET", path: repo };
    case "repository.getProfile":
      return { method: "GET", path: `${repo}/community/profile` };
    case "repository.getIssues":
      return { method: "GET", path: `${repo}/issues`, query: { state: c.listState }, list: true };
    case "repository.getPullRequests":
      return { method: "GET", path: `${repo}/pulls`, query: { state: c.listState }, list: true };

    case "file.get":
      return {
        method: "GET",
        path: contents(repo, need(c.filePath, "filePath", op)),
        query: { ref: c.branch },
      };
    case "file.list":
      return { method: "GET", path: contents(repo, c.filePath), query: { ref: c.branch } };
    case "file.delete":
      return {
        method: "DELETE",
        path: contents(repo, need(c.filePath, "filePath", op)),
        body: compact({
          message: need(c.commitMessage, "commitMessage", op),
          branch: c.branch,
          sha: c.sha,
        }),
      };
    case "file.create":
    case "file.edit":
      return {
        method: "PUT",
        path: contents(repo, need(c.filePath, "filePath", op)),
        body: compact({
          message: need(c.commitMessage, "commitMessage", op),
          content: Buffer.from(c.fileContent ?? "", "utf8").toString("base64"),
          branch: c.branch,
          sha: c.sha,
        }),
      };

    case "release.create":
      return {
        method: "POST",
        path: `${repo}/releases`,
        body: compact({
          tag_name: need(c.tagName, "tagName", op),
          name: c.releaseName,
          body: c.releaseBody,
          target_commitish: c.targetCommitish,
          draft: c.draft,
          prerelease: c.prerelease,
        }),
      };
    case "release.get":
      return { method: "GET", path: `${repo}/releases/${need(c.releaseId, "releaseId", op)}` };
    case "release.getAll":
      return { method: "GET", path: `${repo}/releases`, list: true };
    case "release.update":
      return {
        method: "PATCH",
        path: `${repo}/releases/${need(c.releaseId, "releaseId", op)}`,
        body: compact({
          tag_name: c.tagName,
          name: c.releaseName,
          body: c.releaseBody,
          target_commitish: c.targetCommitish,
          draft: c.draft,
          prerelease: c.prerelease,
        }),
      };
    case "release.delete":
      return { method: "DELETE", path: `${repo}/releases/${need(c.releaseId, "releaseId", op)}` };

    case "workflow.list":
      return {
        method: "GET",
        path: `${repo}/actions/workflows`,
        list: true,
        itemsKey: "workflows",
      };
    case "workflow.dispatch":
      return {
        method: "POST",
        path: `${repo}/actions/workflows/${seg(need(c.workflowId, "workflowId", op))}/dispatches`,
        body: compact({ ref: need(c.ref, "ref", op), inputs: parseInputs(c.workflowInputs) }),
      };
  }
  throw new Error(`Unknown GitHub operation "${op}"`);
}
