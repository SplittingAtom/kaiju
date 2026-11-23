import { describe, expect, it } from "vitest";
import { projectCommitOutcomeSchema } from "@kobe/protocol";
import { commitSubject, REPO_COMMIT_TOOL, replyOf } from "./project-commit.js";

/** KOBE-767: the agent's `commit_project` on a Repo, for new and older agents. */
describe("commit_project answers on a Repo", () => {
  const pr = {
    status: "pull_request" as const,
    branch: "kobe/ada/fix-1234567",
    commitSha: "a".repeat(40),
    number: 4,
    url: "https://git.acme.test/acme/app/pulls/4",
    opened: true,
    fallback: false,
  };

  it("gives agents with repo_commits the outcome, valid on the wire", () => {
    const reply = replyOf(pr, true);
    expect(reply).toEqual({
      ok: true,
      outcome: {
        status: "pull_request",
        branch: pr.branch,
        number: 4,
        url: pr.url,
        opened: true,
      },
    });
    if (reply.ok) expect(projectCommitOutcomeSchema.safeParse(reply.outcome).success).toBe(true);
    const pushed = replyOf(
      { status: "pushed", branch: "main", commitSha: pr.commitSha, seq: null, commitId: null },
      true,
    );
    expect(pushed).toEqual({ ok: true, outcome: { status: "pushed", branch: "main", seq: null } });
  });

  it("tells older agents in words, never with an outcome they would refuse", () => {
    expect(replyOf(pr, false)).toEqual({
      ok: false,
      code: "committed_as_pull_request",
      message: `Committed to the Repo as pull request #4 (branch ${pr.branch}): ${pr.url}. Do not commit again for the same change.`,
    });
    expect(
      replyOf(
        { status: "pushed", branch: "main", commitSha: pr.commitSha, seq: 3, commitId: null },
        false,
      ),
    ).toMatchObject({ ok: false, code: "committed_to_default_branch" });
  });

  it("passes the Repo refusals on with their reason", () => {
    expect(
      replyOf({ status: "refused", error: "repo_moved", detail: "main moved. Update." }),
    ).toEqual({ ok: false, code: "repo_moved", message: "main moved. Update." });
    expect(replyOf({ status: "refused", error: "repo_push_rejected" })).toEqual({
      ok: false,
      code: "repo_push_rejected",
      message: "The git host refused the push.",
    });
  });
});

describe("who decides an agent's commit (review M2)", () => {
  it("a Repo's commit always asks, as its own subject; a rule covers only Kobe's own commits", () => {
    expect(commitSubject("git.acme.test/acme/app: a branch", true)).toEqual({
      tool: REPO_COMMIT_TOOL,
      ask: true,
    });
    expect(REPO_COMMIT_TOOL).toBe("commit_repo");
    expect(commitSubject(undefined, true)).toEqual({ tool: "commit_project", ask: false });
    expect(commitSubject(undefined, false)).toEqual({ tool: "commit_project", ask: true });
  });
});
