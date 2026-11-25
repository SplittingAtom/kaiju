import { execFileSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSessionDir } from "../pi/session-files.js";
import { moveStateFolder, type StateFolderFs } from "./state-folder.js";

/**
 * KOBE-827 ac-1/ac-3: `/workspace/.kobe` becomes `.kaiju` at wake in one rename, idempotently,
 * never merging two folders, never following a link, never losing a working copy.
 */
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "kaiju-state-folder-"));
  dirs.push(dir);
  return dir;
}

async function workspace(): Promise<string> {
  const root = path.join(await scratch(), "workspace");
  await mkdir(root);
  return root;
}

async function put(root: string, rel: string, content: string, mode = 0o644): Promise<void> {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content, { mode });
}

/** Every entry under `dir` (relative path, kind, mode, content or link target), sorted. */
async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const name of (await readdir(abs)).sort()) {
      const file = path.join(abs, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      const info = await lstat(file);
      const mode = (info.mode & 0o7777).toString(8);
      if (info.isSymbolicLink()) out.push(`${r} -> ${await readlink(file)}`);
      else if (info.isDirectory()) {
        out.push(`${r}/ ${mode}`);
        await walk(file, r);
      } else out.push(`${r} ${mode} ${await readFile(file, "utf8")}`);
    }
  };
  await walk(dir, "");
  return out;
}

const exists = (file: string) =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** An old volume's folder: sessions, the agent's state, a dirty working copy with a link in it. */
async function oldFolder(root: string): Promise<void> {
  await put(
    root,
    ".kobe/sessions/0b5e1f3a-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jsonl",
    '{"type":"session"}\n',
  );
  await put(root, ".kobe/agent/sync-stamps.json", "{}");
  await put(root, ".kobe/repos/app/.git/HEAD", "ref: refs/heads/feature\n");
  await put(root, ".kobe/repos/app/src/main.py", "print('unpushed work')\n");
  await put(root, ".kobe/repos/app/run.sh", "#!/bin/sh\n", 0o755);
  await symlink("src/main.py", path.join(root, ".kobe/repos/app/main-link"));
  await chmod(path.join(root, ".kobe"), 0o2770);
}

describe("moveStateFolder (KOBE-827)", () => {
  it("moves the whole folder in one rename: a dirty working copy arrives intact", async () => {
    const root = await workspace();
    await oldFolder(root);
    const before = await tree(path.join(root, ".kobe"));
    const inode = (await stat(path.join(root, ".kobe/repos/app/src/main.py"))).ino;

    expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });

    expect(await exists(path.join(root, ".kobe"))).toBe(false);
    expect(await tree(path.join(root, ".kaiju"))).toEqual(before);
    // Same inode: renamed, not copied, so nothing could be half-written.
    expect((await stat(path.join(root, ".kaiju/repos/app/src/main.py"))).ino).toBe(inode);
    expect((await stat(path.join(root, ".kaiju"))).mode & 0o7777).toBe(0o2770);
  });

  it("is idempotent: a second run (or a fresh volume) does nothing and creates nothing", async () => {
    const root = await workspace();
    await oldFolder(root);
    await moveStateFolder(root);
    const after = await tree(root);
    expect(await moveStateFolder(root)).toBeUndefined();
    expect(await tree(root)).toEqual(after);

    const fresh = await workspace();
    expect(await moveStateFolder(fresh)).toBeUndefined();
    expect(await readdir(fresh)).toEqual([]);
  });

  it("never recreates the old folder: the agent's own writers only use .kaiju (ac-3)", async () => {
    const root = await workspace();
    await oldFolder(root);
    await moveStateFolder(root);
    await ensureSessionDir(path.join(root, ".kaiju", "sessions"), { workspaceDir: root });
    await moveStateFolder(root);
    expect((await readdir(root)).sort()).toEqual([".kaiju"]);
  });

  it("takes the place of an empty .kaiju folder left behind (an interrupted earlier attempt)", async () => {
    const root = await workspace();
    await oldFolder(root);
    await mkdir(path.join(root, ".kaiju"));
    const before = await tree(path.join(root, ".kobe"));
    expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });
    expect(await tree(path.join(root, ".kaiju"))).toEqual(before);
  });

  it("never merges: with data in both, both stay exactly as they are (a half-copied .kaiju)", async () => {
    const root = await workspace();
    await oldFolder(root);
    // A partial copy someone made by hand: some of the files, not all.
    await put(root, ".kaiju/repos/app/src/main.py", "print('older copy')\n");
    const old = await tree(path.join(root, ".kobe"));
    const next = await tree(path.join(root, ".kaiju"));

    expect(await moveStateFolder(root)).toEqual({ outcome: "conflict" });
    expect(await tree(path.join(root, ".kobe"))).toEqual(old);
    expect(await tree(path.join(root, ".kaiju"))).toEqual(next);
    // Reported again at the next start, still untouched.
    expect(await moveStateFolder(root)).toEqual({ outcome: "conflict" });
    expect(await tree(path.join(root, ".kobe"))).toEqual(old);
  });

  it("removes an empty .kobe beside a .kaiju that holds the data (a tool's mkdir)", async () => {
    const root = await workspace();
    await put(root, ".kaiju/repos/app/README.md", "the real one");
    await mkdir(path.join(root, ".kobe"));
    const next = await tree(path.join(root, ".kaiju"));
    expect(await moveStateFolder(root)).toEqual({ outcome: "removed_empty" });
    expect(await exists(path.join(root, ".kobe"))).toBe(false);
    expect(await tree(path.join(root, ".kaiju"))).toEqual(next);
  });

  it("never follows a .kaiju link planted out of the workspace: the link goes, its target stays", async () => {
    const root = await workspace();
    await oldFolder(root);
    const outside = path.join(path.dirname(root), "outside");
    await put(outside, "secret.txt", "not the workspace's");
    await symlink(outside, path.join(root, ".kaiju"));
    const before = await tree(path.join(root, ".kobe"));
    const target = await tree(outside);

    expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });
    expect((await lstat(path.join(root, ".kaiju"))).isDirectory()).toBe(true);
    expect(await tree(path.join(root, ".kaiju"))).toEqual(before);
    expect(await tree(outside)).toEqual(target);
  });

  it("leaves a .kobe that is a link or a file alone, and never follows it", async () => {
    const root = await workspace();
    const outside = path.join(path.dirname(root), "outside");
    await put(outside, "repos/x/file", "elsewhere");
    await symlink(outside, path.join(root, ".kobe"));
    const target = await tree(outside);
    expect(await moveStateFolder(root)).toEqual({ outcome: "not_a_folder" });
    expect((await lstat(path.join(root, ".kobe"))).isSymbolicLink()).toBe(true);
    expect(await exists(path.join(root, ".kaiju"))).toBe(false);
    expect(await tree(outside)).toEqual(target);

    const other = await workspace();
    await put(other, ".kobe", "a member's file");
    expect(await moveStateFolder(other)).toEqual({ outcome: "not_a_folder" });
    expect(await readFile(path.join(other, ".kobe"), "utf8")).toBe("a member's file");
  });

  it("a failed rename leaves .kobe intact and says why; the next start moves it", async () => {
    const root = await workspace();
    await oldFolder(root);
    const before = await tree(path.join(root, ".kobe"));
    const failing: StateFolderFs = {
      rename: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
      rmdir: async () => undefined,
      unlink: async () => undefined,
    };
    expect(await moveStateFolder(root, failing)).toEqual({ outcome: "failed", code: "EACCES" });
    expect(await tree(path.join(root, ".kobe"))).toEqual(before);
    expect(await exists(path.join(root, ".kaiju"))).toBe(false);

    expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });
    expect(await tree(path.join(root, ".kaiju"))).toEqual(before);
  });

  it("a failure after removing an empty .kaiju loses nothing (the interrupted state moves next time)", async () => {
    const root = await workspace();
    await oldFolder(root);
    await mkdir(path.join(root, ".kaiju"));
    const before = await tree(path.join(root, ".kobe"));
    const crashes: StateFolderFs = {
      rename: async () => {
        throw Object.assign(new Error("killed"), { code: "EINTR" });
      },
      rmdir: (dir) => import("node:fs/promises").then((fs) => fs.rmdir(dir)),
      unlink: async () => undefined,
    };
    expect(await moveStateFolder(root, crashes)).toEqual({ outcome: "failed", code: "EINTR" });
    expect(await exists(path.join(root, ".kaiju"))).toBe(false);
    expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });
    expect(await tree(path.join(root, ".kaiju"))).toEqual(before);
  });

  it.skipIf(!hasGit())(
    "keeps a real git working copy's uncommitted and staged changes",
    async () => {
      const root = await workspace();
      const repo = path.join(root, ".kobe/repos/app");
      await mkdir(repo, { recursive: true });
      const git = (dir: string, ...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH ?? "",
            HOME: root,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: "a",
            GIT_AUTHOR_EMAIL: "a@x.test",
            GIT_COMMITTER_NAME: "a",
            GIT_COMMITTER_EMAIL: "a@x.test",
          },
        });
      git(repo, "init", "-q", "-b", "main");
      await put(repo, "a.txt", "one\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-q", "-m", "first");
      git(repo, "checkout", "-q", "-b", "feature");
      await put(repo, "a.txt", "one\nlocal commit\n");
      git(repo, "commit", "-q", "-am", "unpushed commit");
      await put(repo, "staged.txt", "staged\n");
      git(repo, "add", "staged.txt");
      await put(repo, "a.txt", "one\nlocal commit\nuncommitted\n");
      await put(repo, "new.txt", "untracked\n");
      const status = git(repo, "status", "--porcelain=v2", "--branch");
      const log = git(repo, "log", "--format=%H %s");

      expect(await moveStateFolder(root)).toEqual({ outcome: "moved" });
      const moved = path.join(root, ".kaiju/repos/app");
      expect(git(moved, "status", "--porcelain=v2", "--branch")).toBe(status);
      expect(git(moved, "log", "--format=%H %s")).toBe(log);
      expect(git(moved, "fsck", "--no-progress")).toBe("");
    },
  );
});

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
