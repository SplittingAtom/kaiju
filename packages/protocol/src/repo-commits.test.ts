import { describe, expect, it } from "vitest";
import {
  isExcludedPath,
  CAPABILITY_REPO_COMMITS,
  PROJECT_COMMIT_ERROR_CODES,
  commitProjectResponseSchema,
  projectCommitOutcomeSchema,
} from "./index.js";
import {
  REPO_WORKING_COPY_DIR,
  repoStatusFrameSchema,
  runGitContextSchema,
  sandboxToServerFrameSchema,
} from "./sandbox-wire/index.js";

const SHA = "a".repeat(40);
const ID = "11111111-1111-4111-8111-111111111111";

describe("commits to a Repo (KOBE-767)", () => {
  it("answers a pull request or a direct push", () => {
    const pr = {
      status: "pull_request",
      branch: "kobe/ada/fix-typo-aaaaaaa",
      commit_sha: SHA,
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      opened: true,
      fallback: false,
    };
    expect(commitProjectResponseSchema.safeParse(pr).success).toBe(true);
    expect(commitProjectResponseSchema.safeParse({ ...pr, url: "" }).success).toBe(true);
    expect(commitProjectResponseSchema.safeParse({ ...pr, url: "javascript:x" }).success).toBe(
      false,
    );
    expect(commitProjectResponseSchema.safeParse({ ...pr, branch: "a b" }).success).toBe(false);
    const pushed = { status: "pushed", branch: "main", commit_sha: SHA, seq: 4, commit_id: ID };
    expect(commitProjectResponseSchema.safeParse(pushed).success).toBe(true);
    expect(
      commitProjectResponseSchema.safeParse({ ...pushed, seq: null, commit_id: null }).success,
    ).toBe(true);
    expect(commitProjectResponseSchema.safeParse({ ...pushed, commit_sha: "zz" }).success).toBe(
      false,
    );
  });

  it("names the new refusals and the agent outcomes behind a capability", () => {
    expect(PROJECT_COMMIT_ERROR_CODES).toEqual(
      expect.arrayContaining(["repo_moved", "repo_unavailable", "repo_push_rejected"]),
    );
    expect(CAPABILITY_REPO_COMMITS).toBe("repo_commits");
    expect(
      projectCommitOutcomeSchema.safeParse({
        status: "pull_request",
        branch: "kobe/x",
        number: 3,
        url: "",
        opened: false,
      }).success,
    ).toBe(true);
    expect(
      projectCommitOutcomeSchema.safeParse({ status: "pushed", branch: "main", seq: null }).success,
    ).toBe(true);
  });
});

describe("Repo working copy on the wire (KOBE-767)", () => {
  const base = {
    author: { name: "Ada", email: "ada@acme.test" },
    committer: { name: "Ada via Kaiju", email: "ada@acme.test" },
    remotes: [{ base_url: "https://github.com", organization: "acme" }],
  };
  const repo = {
    project_id: ID,
    slug: "app",
    clone_url: "https://github.com/acme/app.git",
    default_branch: "main",
    access: "write",
  };

  it("carries the Repo in run.start.git, and an older agent's schema strips it", () => {
    expect(REPO_WORKING_COPY_DIR).toBe(".kobe/repos");
    // Review N2: inside the reserved area the sync and the server leave alone.
    expect(isExcludedPath(`${REPO_WORKING_COPY_DIR}/app/README.md`)).toBe(true);
    expect(isExcludedPath("repos/app/README.md")).toBe(false);
    const parsed = runGitContextSchema.parse({ ...base, repo });
    expect(parsed.repo?.clone_url).toBe(repo.clone_url);
    expect(
      runGitContextSchema.safeParse({
        ...base,
        repo: { ...repo, clone_url: "https://x:y@github.com/acme/app.git" },
      }).success,
    ).toBe(false);
    expect(
      runGitContextSchema.safeParse({ ...base, repo: { ...repo, clone_url: "http://h/a/b.git" } })
        .success,
    ).toBe(false);
    expect(
      runGitContextSchema.safeParse({ ...base, repo: { ...repo, default_branch: "../x" } }).success,
    ).toBe(false);
    expect(
      runGitContextSchema.safeParse({ ...base, repo: { ...repo, slug: "../etc" } }).success,
    ).toBe(false);
  });

  it("reports the working copy with bounded fields and no paths", () => {
    const frame = {
      v: 1,
      type: "repo.status",
      run_id: ID,
      thread_id: ID,
      project_id: ID,
      branch: "fix/typo",
      head_sha: SHA,
      upstream: "origin/fix/typo",
      ahead: 2,
      behind: 0,
      dirty: true,
      fetched: true,
      problem: null,
    };
    expect(repoStatusFrameSchema.safeParse(frame).success).toBe(true);
    expect(sandboxToServerFrameSchema.safeParse(frame).success).toBe(true);
    expect(repoStatusFrameSchema.safeParse({ ...frame, ahead: 10_001 }).success).toBe(false);
    expect(repoStatusFrameSchema.safeParse({ ...frame, files: ["a"] }).success).toBe(false);
    expect(repoStatusFrameSchema.safeParse({ ...frame, problem: "x".repeat(201) }).success).toBe(
      false,
    );
  });
});

describe("Repo commit info (KOBE-767)", () => {
  it("is null for a project and bounded for a Repo", async () => {
    const { repoCommitInfoSchema } = await import("./index.js");
    expect(repoCommitInfoSchema.safeParse({ repo: null }).success).toBe(true);
    const repo = {
      default_branch: "main",
      direct_commits: false,
      can_commit: true,
      pull_request: { branch: "kobe/a/b-1234567", number: 2, url: "" },
      working_copy: {
        branch: "main",
        head_sha: SHA,
        upstream: "origin/main",
        ahead: 1,
        behind: 0,
        dirty: false,
        fetched: true,
        problem: null,
        reported_at: "2026-11-23T10:00:00.000Z",
      },
    };
    expect(repoCommitInfoSchema.safeParse({ repo }).success).toBe(true);
    expect(repoCommitInfoSchema.safeParse({ repo: { ...repo, extra: 1 } }).success).toBe(false);
  });
});
