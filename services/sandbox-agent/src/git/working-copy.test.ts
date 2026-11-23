import { describe, expect, it } from "vitest";
import type { RunGitRepo } from "@kobe/protocol/sandbox-wire";
import {
  REPO_SCRIPT,
  failedStatus,
  isRepoGitPath,
  parseRepoStatus,
  repoScriptArgs,
  repoStatusFrame,
  workingCopyStatus,
  type ToolCommandRunner,
} from "./working-copy.js";
import { repoStatusFrameSchema } from "@kobe/protocol/sandbox-wire";

const ID = "11111111-1111-4111-8111-111111111111";
const SHA = "b".repeat(40);
const repo: RunGitRepo = {
  project_id: ID,
  slug: "app",
  clone_url: "https://github.com/acme/app.git",
  default_branch: "main",
  access: "write",
};
const line = (...f: string[]) => `noise\nKOBE-REPO-STATUS\t${f.join("\t")}\n`;

describe("Repo working copy (KOBE-767)", () => {
  it("keeps only repos/<x>/.git out of the sync", () => {
    expect(isRepoGitPath("repos/app/.git")).toBe(true);
    expect(isRepoGitPath("repos/app/.git/objects/aa/bb")).toBe(true);
    for (const p of ["repos/app/src/.git", "work/app/.git", ".git", "repos/.git", "repos/app/a"]) {
      expect(isRepoGitPath(p), p).toBe(false);
    }
  });

  it("passes every value as a positional argument, never inside the script", () => {
    const args = repoScriptArgs("/workspace", repo, true);
    expect(args.slice(0, 2)).toEqual(["-c", REPO_SCRIPT]);
    expect(args.slice(3)).toEqual(["/workspace/repos/app", repo.clone_url, "main", "1"]);
    expect(REPO_SCRIPT).not.toContain("github");
    expect(repoScriptArgs("/workspace", repo, false).at(-1)).toBe("0");
  });

  it("parses the status line strictly and caps the counts", () => {
    expect(parseRepoStatus(line("fix/x", SHA, "origin/fix/x", "2", "0", "1", "1", ""))).toEqual({
      branch: "fix/x",
      head_sha: SHA,
      upstream: "origin/fix/x",
      ahead: 2,
      behind: 0,
      dirty: true,
      fetched: true,
      problem: null,
    });
    const odd = parseRepoStatus(line("", "nope", "", "99999", "x", "0", "0", "fetch failed"));
    expect(odd).toMatchObject({ branch: null, head_sha: null, ahead: 10_000, behind: 0 });
    expect(odd?.problem).toBe("fetch failed");
    expect(parseRepoStatus("KOBE-REPO-STATUS\ttoo\tfew\n")).toBeUndefined();
    expect(parseRepoStatus("nothing here")).toBeUndefined();
    expect(parseRepoStatus(line("a", "b", "c", "1", "1", "1", "1", "x".repeat(5000)))).toBe(
      undefined,
    );
  });

  it("makes a valid frame from any status, a failure included", () => {
    const frame = repoStatusFrame(ID, ID, repo, failedStatus("timed out"));
    expect(repoStatusFrameSchema.safeParse(frame).success).toBe(true);
    expect(frame.problem).toBe("timed out");
  });

  it("turns a runner failure or a missing line into a problem, never a throw", async () => {
    const failed: ToolCommandRunner = () => Promise.resolve({ failed: "timed out" });
    await expect(
      workingCopyStatus(failed, "/workspace", repo, { fetch: true, timeoutMs: 1000 }),
    ).resolves.toMatchObject({ problem: "timed out", fetched: false });
    const silent: ToolCommandRunner = () => Promise.resolve({ stdout: "" });
    await expect(
      workingCopyStatus(silent, "/workspace", repo, { fetch: true, timeoutMs: 1000 }),
    ).resolves.toMatchObject({ problem: "no status from git" });
    const throws: ToolCommandRunner = () => Promise.reject(new Error("x"));
    await expect(
      workingCopyStatus(throws, "/workspace", repo, { fetch: true, timeoutMs: 1000 }),
    ).resolves.toMatchObject({ problem: "git could not run" });
  });
});
