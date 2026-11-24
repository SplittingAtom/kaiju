import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  componentRefusal,
  gitattributesRefusal,
  hostRejectsPath,
  isGitattributes,
  pathRefusal,
} from "./paths.js";

/**
 * KOBE-765 review M1: the names git's own `fsck --strict` refuses (what GitHub, Gitea and
 * Forgejo run on receive) are exactly the ones `paths.ts` refuses, checked against the real git.
 * `.gitmodules` is refused by Kaiju outright (submodules are not carried), so it is listed apart.
 */
const root = mkdtempSync(path.join(tmpdir(), "kobe-paths-test-"));
let probes = 0;
const run = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Whether git's fsck refuses a tree holding one entry `name` with `content` (a fresh repository each). */
function fsckRefuses(name: string, content = "x\n"): boolean {
  probes += 1;
  const dir = path.join(root, `r${probes}`);
  run(root, ["init", "-q", "--bare", dir]);
  const blob = run(dir, ["hash-object", "-w", "--stdin"], content).trim();
  const tree = run(dir, ["mktree"], `100644 blob ${blob}\t${name}\n`).trim();
  const commit = run(dir, ["commit-tree", tree, "-m", "t"], "").trim();
  run(dir, ["update-ref", "refs/heads/main", commit]);
  try {
    run(dir, ["fsck", "--strict", "--no-dangling"]);
    return false;
  } catch {
    return true;
  }
}

const NAMES = [
  ".git",
  ".GIT",
  ".git.",
  ".git ",
  ".git. . ",
  ".git:x",
  ".git::$INDEX_ALLOCATION",
  "git~1",
  "GIT~1",
  "git~1.",
  "GIT~1 ",
  "git~1:y",
  ".g‌it",
  ".gi﻿t",
  ".gitx",
  ".git-notes",
  "git~2",
  "git~10",
  ".gitignore",
  ".github",
  "a.git",
  "git",
  "README.md",
  "naïve.txt",
  "with space",
];

describe("paths a host's fsck refuses", () => {
  it.each(NAMES)("%s: Kaiju and git fsck agree", (name) => {
    expect(componentRefusal(name) !== undefined).toBe(fsckRefuses(name));
  });

  it("refuses .gitmodules in every spelling git treats as one", () => {
    for (const name of [
      ".gitmodules",
      ".GITMODULES",
      ".gitmodules.",
      ".gitmodules:x",
      "gitmod~1",
      "GITMOD~4 ",
      "gi7eba~1",
      ".gitmodule‌s",
    ]) {
      expect(componentRefusal(name), name).toContain(".gitmodules");
    }
    for (const name of ["gitmod~5", ".gitmodulesx", "gitmodules"]) {
      expect(componentRefusal(name), name).toBeUndefined();
    }
  });

  it("checks every component and control characters", () => {
    expect(hostRejectsPath("a/b/.git:x/c")).toBe(true);
    expect(hostRejectsPath("a/b\u0001c")).toBe(true);
    expect(pathRefusal("a/./b")).toBeDefined();
    expect(hostRejectsPath("docs/.github/workflows/ci.yml")).toBe(false);
  });

  it("refuses .gitattributes lines git refuses, and nothing else", () => {
    expect(isGitattributes(".gitattributes")).toBe(true);
    expect(isGitattributes("gitatt~1")).toBe(true);
    expect(isGitattributes(".gitattributesx")).toBe(false);
    const ok = new TextEncoder().encode(`${"a".repeat(2047)}\nb\n`);
    const long = new TextEncoder().encode(`${"a".repeat(2048)}\n`);
    expect(gitattributesRefusal(ok)).toBeUndefined();
    expect(gitattributesRefusal(long)).toBeDefined();
    // The same verdict as git's fsck on the blob under that name.
    const fsckOnAttributes = (content: string) => fsckRefuses(".gitattributes", content);
    expect(fsckOnAttributes(`${"a".repeat(2047)}\n`)).toBe(false);
    expect(fsckOnAttributes(`${"a".repeat(2048)}\n`)).toBe(true);
  });
});
