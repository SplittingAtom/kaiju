import { describe, expect, it } from "vitest";
import type { Project } from "../../lib/projects/api";
import type { RepoView } from "../../lib/projects/repo-api";
import { mayConvert, repoRowWords } from "./repo-row";
import type { GitConnections } from "./workspace-repos";

const project = (over: Partial<Project> = {}): Project => ({
  id: "p1",
  teamId: "t1",
  slug: "q4",
  name: "Q4",
  description: "",
  instructions: "",
  defaultAgentId: null,
  myRole: "owner",
  fileCount: 1,
  createdBy: "u1",
  createdAt: "2026-11-01T10:00:00Z",
  updatedAt: "2026-11-01T10:00:00Z",
  archivedAt: null,
  kind: "project",
  repoConversion: null,
  ...over,
});

const connection = (accessLevel: "off" | "read" | "read_write") => ({
  id: "c1",
  provider: "github" as const,
  baseUrl: "https://github.com",
  organization: "acme",
  displayName: "Acme",
  accessLevel,
  status: "ok" as const,
});

const git = (over: Partial<GitConnections> = {}): GitConnections => ({
  connections: [connection("read_write")],
  enabled: true,
  admin: false,
  ...over,
});

const view = (over: Partial<RepoView> = {}): RepoView => ({
  projectId: "p1",
  repositoryId: "r1",
  connectionId: "c1",
  provider: "github",
  baseUrl: "https://github.com",
  fullName: "acme/q4",
  webUrl: "https://github.com/acme/q4",
  defaultBranch: "main",
  hostState: "active",
  readOnly: false,
  readOnlyReason: null,
  canManage: false,
  mirror: {
    headSha: null,
    refreshedAt: null,
    attemptedAt: null,
    refreshing: false,
    nextAttemptAt: null,
    failures: 0,
    error: null,
    tooLarge: false,
  },
  commits: [],
  ...over,
});

describe("who may convert (G16, GQ13)", () => {
  it("owners and Workspace admins, with a connection at Read and write", () => {
    expect(mayConvert(project(), git())).toBe(true);
    expect(mayConvert(project({ myRole: null }), git())).toBe(true);
    expect(mayConvert(project({ myRole: "editor" }), git())).toBe(false);
    expect(mayConvert(project({ myRole: "reader" }), git())).toBe(false);
  });
  it("not without a writable connection, with git off, archived, or already a Repo", () => {
    expect(mayConvert(project(), git({ connections: [connection("read")] }))).toBe(false);
    expect(mayConvert(project(), git({ enabled: false }))).toBe(false);
    expect(mayConvert(project(), null)).toBe(false);
    expect(mayConvert(project({ archivedAt: "2026-11-02T00:00:00Z" }), git())).toBe(false);
    expect(mayConvert(project({ kind: "repo" }), git())).toBe(false);
  });
  it("a running or failed conversion stays reachable to follow, retry or abandon", () => {
    expect(mayConvert(project({ repoConversion: "failed" }), null)).toBe(true);
    expect(mayConvert(project({ repoConversion: "running" }), git({ enabled: false }))).toBe(true);
  });
});

describe("a Repo's row (G19)", () => {
  it("before it is read: just Repo", () => {
    expect(repoRowWords(undefined)).toEqual({ subtitle: "Repo", chips: [], words: [] });
  });
  it("host and repository, the branch, ahead/behind of the member's working copy", () => {
    const words = repoRowWords({
      view: view(),
      status: {
        defaultBranch: "main",
        directCommits: false,
        canCommit: true,
        pullRequest: null,
        workingCopy: {
          branch: "fix",
          headSha: null,
          upstream: null,
          ahead: 3,
          behind: 0,
          dirty: false,
          fetched: true,
          problem: null,
          reportedAt: "2026-11-23T10:00:00Z",
        },
      },
    });
    expect(words).toEqual({
      subtitle: "github.com · acme/q4",
      chips: ["fix", "↑3"],
      words: ["branch fix", "3 ahead"],
    });
  });
  it("read-only, too large and failed refreshes are marked", () => {
    expect(
      repoRowWords({ view: view({ readOnly: true, readOnlyReason: "archived" }), status: null })
        .chips,
    ).toEqual(["main", "read-only"]);
    const big = view();
    expect(
      repoRowWords({ view: { ...big, mirror: { ...big.mirror, tooLarge: true } }, status: null })
        .chips,
    ).toEqual(["main", "too large to mirror"]);
    expect(
      repoRowWords({
        view: {
          ...big,
          mirror: { ...big.mirror, error: { code: "host_unreachable", message: "x" } },
        },
        status: null,
      }).chips,
    ).toEqual(["main", "refresh failed"]);
  });
});
