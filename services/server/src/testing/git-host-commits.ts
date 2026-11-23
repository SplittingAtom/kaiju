import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Commits made "on the host" for the Repo mirror tests (KOBE-766): a temporary clone of a bare
 * repository of the test git server (`git-http-server.ts`), the files written (null removes one,
 * a path ending in `.sh` is made executable), committed as another person and pushed back over
 * the file system. Returns the new head.
 */
export function commitOnHost(
  root: string,
  name: string,
  files: Readonly<Record<string, string | Buffer | null>>,
  message: string,
  author = { name: "Hana Host", email: "hana@example.org" },
): string {
  const bare = path.join(root, `${name}.git`);
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
  const run = (cwd: string, args: readonly string[]) =>
    execFileSync("git", [...args], { cwd, encoding: "utf8", env });
  const work = mkdtempSync(path.join(root, "host-commit-"));
  try {
    run(root, ["clone", "--quiet", bare, work]);
    const branch = run(bare, ["symbolic-ref", "--short", "HEAD"]).trim();
    run(work, ["checkout", "--quiet", "-B", branch]);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(work, rel);
      if (content === null) {
        run(work, ["rm", "--quiet", rel]);
        continue;
      }
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
      if (rel.endsWith(".sh")) chmodSync(full, 0o755);
    }
    run(work, ["add", "-A"]);
    run(work, ["commit", "--quiet", "--allow-empty", "-m", message]);
    run(work, ["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`]);
    return run(work, ["rev-parse", "HEAD"]).trim();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Adds a symlink on the host (left out of the mirror). */
export function symlinkOnHost(root: string, name: string, link: string, target: string): string {
  const bare = path.join(root, `${name}.git`);
  const env = { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: readonly string[], input?: string) =>
    execFileSync("git", [...args], { cwd: bare, encoding: "utf8", env, input }).trim();
  const blob = run(["hash-object", "-w", "--stdin"], target);
  const head = run(["rev-parse", "HEAD"]);
  const listing = run(["ls-tree", "HEAD"]);
  const tree = run(["mktree"], `${listing}\n120000 blob ${blob}\t${link}\n`);
  const commit = execFileSync("git", ["commit-tree", tree, "-p", head, "-m", "Add a link"], {
    cwd: bare,
    encoding: "utf8",
    env: {
      ...env,
      GIT_AUTHOR_NAME: "Hana Host",
      GIT_AUTHOR_EMAIL: "hana@example.org",
      GIT_COMMITTER_NAME: "Hana Host",
      GIT_COMMITTER_EMAIL: "hana@example.org",
    },
  }).trim();
  run(["update-ref", "HEAD", commit]);
  return commit;
}
