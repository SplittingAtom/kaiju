import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GitTreeEntry } from "../../git-hosts/trees.js";
import { commitContent, gitObjectId, treeContent, writeLoose } from "./objects.js";
import { editTree, TreeMismatch, type FileEdit } from "./tree-edit.js";
import { messageSlug, pullRequestBody, pullRequestBranch, pullRequestTitle } from "./naming.js";

/**
 * KOBE-767: a commit to a Repo is written on top of the host's tree folder by folder. Checked
 * against the real git: object ids, tree order, the edited tree (`git ls-tree -r`), and a repository
 * holding the written objects passes `git fsck --strict`.
 */
const root = mkdtempSync(path.join(tmpdir(), "kaiju-repo-commit-test-"));
const repo = path.join(root, "repo");
const env = {
  PATH: process.env.PATH ?? "",
  HOME: root,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const git = (args: string[], input?: string) =>
  execFileSync("git", args, { cwd: repo, input, encoding: "utf8", env, stdio: "pipe" }).trim();

let base: string;
beforeAll(() => {
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env });
  const files: Record<string, string> = {
    "README.md": "# Hello\n",
    "docs/a.md": "a\n",
    "docs/b-c.md": "bc\n",
    "docs/b/inner.md": "inner\n",
    "src/run.sh": "#!/bin/sh\n",
    "keep/x.txt": "x\n",
  };
  for (const [p, text] of Object.entries(files)) {
    execFileSync("mkdir", ["-p", path.dirname(path.join(repo, p))]);
    writeFileSync(path.join(repo, p), text);
  }
  git(["add", "."]);
  git(["update-index", "--chmod=+x", "src/run.sh"]);
  git(["commit", "-q", "-m", "base"]);
  base = git(["rev-parse", "HEAD"]);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** One level of a tree as the hosts answer it, read from the real repository. */
function lsTree(sha: string): GitTreeEntry[] {
  const out = git(["ls-tree", sha]);
  if (out === "") return [];
  return out.split("\n").map((line) => {
    const [meta, name] = line.split("\t") as [string, string];
    const [mode, type, oid] = meta.split(" ") as [string, GitTreeEntry["type"], string];
    return { name, mode: mode === "040000" ? "40000" : mode, type, sha: oid };
  });
}

const gitdir = () => path.join(repo, ".git");

describe("git objects (KOBE-767)", () => {
  it("computes blob ids as git does", () => {
    const bytes = Buffer.from("hello\né\n");
    expect(gitObjectId("blob", bytes)).toBe(git(["hash-object", "--stdin"], bytes.toString()));
  });

  it("writes trees in git's order (a folder sorts as if it ended with /)", async () => {
    const blob = await writeLoose(gitdir(), "blob", Buffer.from("z\n"));
    const sub = git(["mktree"], "");
    const entries: GitTreeEntry[] = [
      { name: "b.md", mode: "100644", type: "blob", sha: blob },
      { name: "b", mode: "40000", type: "tree", sha: sub },
      { name: "b-c", mode: "100755", type: "blob", sha: blob },
      { name: "a", mode: "120000", type: "blob", sha: blob },
    ];
    const ours = await writeLoose(gitdir(), "tree", treeContent(entries));
    const theirs = git(
      ["mktree"],
      entries
        .map((e) => `${e.mode === "40000" ? "040000" : e.mode} ${e.type} ${e.sha}\t${e.name}`)
        .join("\n"),
    );
    expect(ours).toBe(theirs);
  });

  it("edits only the folders on changed paths, keeps the rest, drops emptied folders", async () => {
    const edits = new Map<string, FileEdit>([
      [
        "docs/a.md",
        { blob: await writeLoose(gitdir(), "blob", Buffer.from("A!\n")), executable: false },
      ],
      ["docs/b/inner.md", null],
      [
        "new/deep/n.py",
        { blob: await writeLoose(gitdir(), "blob", Buffer.from("print()\n")), executable: true },
      ],
      ["README.md", null],
    ]);
    const reads: string[] = [];
    const { tree } = await editTree(base, edits, {
      read: async (sha) => {
        reads.push(sha);
        return lsTree(sha);
      },
      write: (content) => writeLoose(gitdir(), "tree", content),
    });
    // root, docs and docs/b only: keep/, src/ and new/ are never read.
    expect(reads).toHaveLength(3);
    const listing = git(["ls-tree", "-r", tree]);
    expect(listing).toContain("docs/a.md");
    expect(listing).not.toContain("docs/b/inner.md");
    expect(listing).not.toContain("README.md");
    expect(listing).toMatch(/^100755 blob [0-9a-f]{40}\tnew\/deep\/n\.py$/m);
    expect(listing).toMatch(/^100755 blob [0-9a-f]{40}\tsrc\/run\.sh$/m);
    expect(git(["cat-file", "-p", `${tree}:docs/a.md`])).toBe("A!");
    // The unchanged folders keep their ids.
    expect(git(["rev-parse", `${tree}:keep`])).toBe(git(["rev-parse", `${base}:keep`]));
    const commit = await writeLoose(
      gitdir(),
      "commit",
      commitContent({
        tree,
        parent: base,
        author: { name: "Ada Lovelace", email: "ada@acme.test" },
        committer: { name: "Ada Lovelace via Kaiju", email: "ada@acme.test" },
        at: new Date("2026-11-23T10:00:00Z"),
        message: "Fix the docs\n\nWith a body.  \n",
      }),
    );
    git(["fsck", "--strict", "--no-dangling"]);
    expect(git(["log", "-1", "--format=%an <%ae>|%cn|%s|%P", commit])).toBe(
      `Ada Lovelace <ada@acme.test>|Ada Lovelace via Kaiju|Fix the docs|${base}`,
    );
    expect(git(["cat-file", "-p", commit]).endsWith("Fix the docs\n\nWith a body.")).toBe(true);
  });

  it("refuses a file where the host has a folder, and a folder where it has a file", async () => {
    const blob = await writeLoose(gitdir(), "blob", Buffer.from("x\n"));
    const io = {
      read: async (sha: string) => lsTree(sha),
      write: (content: Buffer) => writeLoose(gitdir(), "tree", content),
    };
    await expect(
      editTree(base, new Map([["docs", { blob, executable: false }]]), io),
    ).rejects.toBeInstanceOf(TreeMismatch);
    await expect(
      editTree(base, new Map([["README.md/x", { blob, executable: false }]]), io),
    ).rejects.toBeInstanceOf(TreeMismatch);
  });
});

describe("pull request names and text (KOBE-767)", () => {
  it("builds a readable branch, title and body that names the member", () => {
    expect(messageSlug("Fix: the Élan typo!\nmore")).toBe("fix-the-elan-typo");
    expect(messageSlug("!!!")).toBe("changes");
    expect(pullRequestBranch("Ada Lovelace", "Fix typo", "abcdef1234")).toBe(
      "kobe/ada-lovelace/fix-typo-abcdef1",
    );
    expect(pullRequestTitle("  First line  \nsecond")).toBe("First line");
    expect(
      pullRequestBody({
        message: "Title\n\nWhy it changed.",
        memberName: "Ada *L*",
        publicUrl: "https://k.test",
      }),
    ).toBe("Why it changed.\n\n---\nCommitted by Ada \\*L\\* with Kaiju's commit dialog");
    const agent = pullRequestBody({
      message: "Only a title",
      memberName: "Ada",
      publicUrl: "https://k.test/",
      threadId: "11111111-1111-4111-8111-111111111111",
    });
    expect(agent).toBe(
      "Committed by Ada via Kaiju, from conversation https://k.test/?thread=11111111-1111-4111-8111-111111111111",
    );
    const long = pullRequestBody({
      message: `t\n${"x".repeat(30_000)}`,
      memberName: "A",
      publicUrl: "https://k.test",
    });
    expect(long.length).toBeLessThanOrEqual(20_000);
    expect(long.endsWith("with Kaiju's commit dialog")).toBe(true);
  });
});
