import { describe, expect, it } from "vitest";
import { commitNotice, repoCommitHint } from "./project-work";

/** KOBE-767: the words of a commit to a Repo. */
describe("commit outcomes and hints on a Repo", () => {
  it("words a pushed commit, a joined pull request and a fallback", () => {
    expect(
      commitNotice("App", {
        status: "pushed",
        branch: "main",
        commitSha: "a".repeat(40),
        seq: 5,
        commitId: "c",
      }),
    ).toEqual({ text: "Committed to main on the git host (#5 in Kaiju)." });
    expect(
      commitNotice("App", {
        status: "pull_request",
        branch: "kobe/a/b-1",
        commitSha: "a".repeat(40),
        number: 3,
        url: "",
        opened: false,
        fallback: false,
      }),
    ).toEqual({ text: "Added your commit to pull request #3 (branch kobe/a/b-1)." });
    expect(
      commitNotice("App", {
        status: "pull_request",
        branch: "kobe/a/b-1",
        commitSha: "a".repeat(40),
        number: 4,
        url: "https://h.test/pr/4",
        opened: true,
        fallback: true,
      }).text,
    ).toMatch(/^The git host protects the default branch/);
  });

  it("says where a commit goes, and nothing for an ordinary project", () => {
    const repo = {
      defaultBranch: "main",
      directCommits: true,
      canCommit: true,
      pullRequest: null,
      workingCopy: null,
    };
    expect(repoCommitHint({ repo: null })).toBeNull();
    expect(repoCommitHint(null)).toBeNull();
    expect(repoCommitHint({ repo })).toMatch(/straight to main/);
    expect(
      repoCommitHint({
        repo: { ...repo, directCommits: false, pullRequest: { branch: "b", number: 2, url: "" } },
      }),
    ).toMatch(/added to your pull request #2/);
    expect(repoCommitHint({ repo: { ...repo, canCommit: false } })).toMatch(/can't commit/);
  });
});
