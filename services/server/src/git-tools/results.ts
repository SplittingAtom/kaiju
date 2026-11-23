import type { GitConnectionRecord } from "@kobe/db";
import {
  cloneUrlFor,
  type GitBranch,
  type GitFileContent,
  type GitIssue,
  type GitPage,
  type GitPullRequest,
  type GitRepository,
} from "../git-hosts/adapter.js";
import { KOBE_RESULT_MAX_BYTES } from "../kobe-mcp/catalog.js";
import {
  fenceGitContent,
  gitContentNotice,
  newNonce,
  plainHostText,
} from "../kobe-mcp/untrusted.js";
import { toolError, type GitToolError } from "./errors.js";
import type { GitWriteRecord } from "./ledger.js";

/**
 * What the agent gets back from a git host tool (spec workspace-git §9; KOBE-762): ids, names,
 * states and links the adapters already bounded (web links on the connection's own origin, clone
 * URLs built from the base URL), and the host's free text (titles, bodies, file content) sanitised
 * and fenced as untrusted content with a fresh nonce, so it never reads as instructions. Never a
 * credential, and never more than {@link KOBE_RESULT_MAX_BYTES}.
 */

export type GitResultData =
  | { readonly kind: "repositories"; readonly page: GitPage<GitRepository> }
  | { readonly kind: "repository"; readonly repository: GitRepository }
  | { readonly kind: "branches"; readonly repository: string; readonly page: GitPage<GitBranch> }
  | {
      readonly kind: "file";
      readonly repository: string;
      readonly ref: string | null;
      readonly file: GitFileContent;
    }
  | {
      readonly kind: "pull_requests";
      readonly repository: string;
      readonly page: GitPage<GitPullRequest>;
    }
  | {
      readonly kind: "pull_request";
      readonly repository: string;
      readonly pullRequest: GitPullRequest;
    }
  | { readonly kind: "issues"; readonly repository: string; readonly page: GitPage<GitIssue> }
  | { readonly kind: "issue"; readonly repository: string; readonly issue: GitIssue };

export function connectionView(c: GitConnectionRecord) {
  return {
    id: c.id,
    display_name: c.displayName,
    provider: c.provider,
    host: new URL(c.baseUrl).host,
    organization: c.organization,
    access_level: c.accessLevel,
  };
}

const repositoryView = (r: GitRepository) => ({
  name: r.name,
  full_name: plainHostText(r.fullName, 201),
  visibility: r.visibility,
  default_branch: r.defaultBranch === null ? null : plainHostText(r.defaultBranch, 255),
  archived: r.archived,
  empty: r.empty,
  web_url: r.webUrl,
  clone_url: r.cloneUrl,
});

function done(value: Record<string, unknown>): { ok: true; text: string } | GitToolError {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > KOBE_RESULT_MAX_BYTES) {
    return toolError(
      "too_large",
      "The result is too large; ask for a smaller page or a smaller file.",
    );
  }
  return { ok: true, text };
}

export function readResult(
  connection: GitConnectionRecord,
  data: GitResultData,
): { ok: true; text: string } | GitToolError {
  const nonce = newNonce();
  const fence = (text: string) => fenceGitContent(nonce, text);
  const conn = { connection: connection.id, organization: connection.organization };
  const next = (page: GitPage<unknown>) => (page.next === null ? {} : { next_cursor: page.next });
  const pr = (p: GitPullRequest) => ({
    number: p.number,
    title: fence(p.title),
    state: p.state,
    draft: p.draft,
    head: plainHostText(p.head),
    base: plainHostText(p.base),
    author: p.author === null ? null : plainHostText(p.author, 100),
    web_url: p.webUrl,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    ...(p.body === undefined
      ? {}
      : { body: fence(p.body), body_truncated: p.bodyTruncated === true }),
  });
  const issue = (i: GitIssue) => ({
    number: i.number,
    title: fence(i.title),
    state: i.state,
    author: i.author === null ? null : plainHostText(i.author, 100),
    comments: i.comments,
    web_url: i.webUrl,
    created_at: i.createdAt,
    updated_at: i.updatedAt,
    ...(i.body === undefined
      ? {}
      : { body: fence(i.body), body_truncated: i.bodyTruncated === true }),
  });
  const notice = { untrusted_notice: gitContentNotice(nonce) };
  switch (data.kind) {
    case "repositories":
      return done({
        ...conn,
        repositories: data.page.items.map(repositoryView),
        ...next(data.page),
      });
    case "repository":
      return done({ ...conn, repository: repositoryView(data.repository) });
    case "branches":
      return done({
        ...conn,
        repository: data.repository,
        branches: data.page.items.map((b) => ({
          name: plainHostText(b.name, 255),
          commit: b.commitSha,
          protected: b.protected,
        })),
        ...next(data.page),
      });
    case "file": {
      const f = data.file;
      const body =
        f.kind === "directory"
          ? {
              kind: "directory",
              path: f.path,
              entries: f.entries.map((e) => ({
                name: plainHostText(e.name, 255),
                path: plainHostText(e.path, 1000),
                type: e.type,
                size: e.size,
              })),
            }
          : {
              kind: "file",
              path: f.path,
              size: f.size,
              sha: f.sha,
              binary: f.binary,
              truncated: f.truncated,
              ...(f.binary ? {} : { content: fence(f.content) }),
            };
      return done({ ...conn, repository: data.repository, ref: data.ref, ...body, ...notice });
    }
    case "pull_requests":
      return done({
        ...conn,
        repository: data.repository,
        pull_requests: data.page.items.map(pr),
        ...next(data.page),
        ...notice,
      });
    case "pull_request":
      return done({
        ...conn,
        repository: data.repository,
        pull_request: pr(data.pullRequest),
        ...notice,
      });
    case "issues":
      return done({
        ...conn,
        repository: data.repository,
        issues: data.page.items.map(issue),
        ...next(data.page),
        ...notice,
      });
    case "issue":
      return done({ ...conn, repository: data.repository, issue: issue(data.issue), ...notice });
  }
}

/** A write's answer; `repeated` when the same call already acted and nothing was sent again. */
export function writeResult(
  connection: GitConnectionRecord,
  record: GitWriteRecord,
  repeated: boolean,
): { ok: true; text: string } | GitToolError {
  const clone =
    record.kind === "repository"
      ? {
          clone_url:
            record.cloneUrl ??
            cloneUrlFor(connection.baseUrl, connection.organization, record.repository),
        }
      : {};
  return done({
    done: true,
    ...(repeated
      ? {
          already_done: "This exact call already ran in this conversation; nothing was sent again.",
        }
      : {}),
    connection: connection.id,
    organization: connection.organization,
    kind: record.kind,
    repository: record.repository,
    ...(record.number === undefined || record.number === null ? {} : { number: record.number }),
    ...(record.on === undefined ? {} : { on: record.on }),
    ...(record.visibility === undefined ? {} : { visibility: record.visibility }),
    ...(record.url === undefined || record.url === "" ? {} : { web_url: record.url }),
    ...clone,
  });
}
