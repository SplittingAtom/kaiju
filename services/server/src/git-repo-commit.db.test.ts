import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { repoCommitInfoSchema } from "@kobe/protocol";
import { createApp } from "./app.js";
import { RawBody, TestBrowser } from "./testing/browser.js";
import { PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { createWorkspaceSync } from "./workspace-sync/index.js";
import { loadRunGitContext } from "./git/sandbox-git.js";
import { recordRepoStatus, runGitRepo } from "./git/working-copy.js";
import {
  PREFIX,
  objects,
  bare,
  forgejo,
  fx,
  git,
  hostRepo,
  must,
  project,
  settled,
  sha,
  start,
  world,
  type World,
} from "./testing/git-conversion-fixture.js";

/**
 * KOBE-767 (GIT-11, spec workspace-git G18, GQ11) on a real Postgres with a real `git
 * http-backend` behind the Forgejo fake (`testing/git-conversion-fixture.ts`). ac-1: a commit from
 * Kobe's commit dialog to a Repo becomes a git commit authored as the member, on a branch of its
 * own, with a pull request into the default branch; the next commit from the same working copy is
 * added to it. ac-2: with direct commits allowed it goes straight to the default branch (Kobe's
 * copy and the checkout move on); a branch moved on the host is refused (`repo_moved`) and nothing
 * is overwritten; a host that refuses the default branch gets a pull request instead; a read-only
 * connection and readers are refused.
 */

/** The REST app with the workspace Files routes (checkout, the editor's save), as in KOBE-579. */
let app: ReturnType<typeof createApp>;
beforeAll(() => {
  const silent = { error: () => {}, warn: () => {}, info: () => {} };
  const sync = createWorkspaceSync({
    db: fx.db,
    objects,
    prefix: PREFIX,
    limits: { maxFileBytes: 1024 * 1024, maxWorkspaceBytes: 8 * 1024 * 1024, maxFiles: 200 },
    log: silent,
  });
  fx.replica(0).deps.projectMounts.use(sync);
  app = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() } },
  });
});

/** `p` signed in on the app with the Files routes, in `team`. */
function as(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

/** The host's tree listing for the fake's `git/trees/{sha}`, read from the real repository. */
forgejo.treeSource = undefined;
function useRealTrees(): void {
  forgejo.treeSource = (full, sha) => {
    let out: string;
    try {
      out = bare(full, ["ls-tree", sha]).trim();
    } catch {
      return undefined;
    }
    if (out === "") return [];
    return out.split("\n").map((line) => {
      const [meta, name] = line.split("\t") as [string, string];
      const [mode, type, oid] = meta.split(" ") as [string, "blob" | "tree" | "commit", string];
      return { path: name, mode, type, sha: oid };
    });
  };
}

function save(b: TestBrowser, filePath: string, base: string | null, content: string) {
  const q = new URLSearchParams({
    path: filePath,
    ...(base === null ? {} : { base_sha256: base }),
  });
  return b.request(
    "PUT",
    `/v1/workspace/file?${q.toString()}`,
    new RawBody(Buffer.from(content), "text/plain"),
    { "content-length": String(Buffer.byteLength(content)) },
  );
}

/** A converted Repo with one commit, checked out by its owner. */
async function repo(w: World) {
  const p = await project(w, [
    { by: w.owner, message: "Start", files: { "README.md": "# Hi\n", "docs/a.md": "a\n" } },
  ]);
  hostRepo(p.slug);
  expect((await start(w.owner, p.id, { connection_id: w.connectionId })).status).toBe(202);
  expect((await settled(w.owner, p.id)).status).toBe("completed");
  useRealTrees();
  const co = await as(w.owner, w.team).request("POST", `/v1/projects/${p.id}/checkout`, {});
  expect(co.status, co.text).toBe(200);
  return { ...p, full: `acme/${p.slug}`, dir: `projects/${p.slug}` };
}

const commit = (b: TestBrowser, id: string, message: string) =>
  b.request("POST", `/v1/projects/${id}/commit`, { message });

async function audits(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

describe("a commit from the Commit dialog on a Repo (ac-1)", () => {
  it("pushes a branch authored as the member and opens a pull request; the next one joins it", async () => {
    const w = await world();
    const r = await repo(w);
    const main = bare(r.full, ["rev-parse", "main"]).trim();
    expect(
      (
        await save(
          as(w.owner, w.team),
          `${r.dir}/README.md`,
          sha(Buffer.from("# Hi\n")),
          "# Hi\n\nMore.\n",
        )
      ).status,
    ).toBe(200);
    expect((await save(as(w.owner, w.team), `${r.dir}/docs/new.md`, null, "new\n")).status).toBe(
      200,
    );

    const first = await commit(as(w.owner, w.team), r.id, "Explain more\n\nThe readme was short.");
    expect(first.status, first.text).toBe(200);
    expect(first.json).toMatchObject({
      status: "pull_request",
      number: 1,
      opened: true,
      fallback: false,
    });
    const branch = first.json.branch as string;
    expect(branch).toMatch(/^kobe\/[a-z0-9-]+\/explain-more-[0-9a-f]{7}$/);
    // main is untouched; the branch holds a commit on top of it, authored as the owner.
    expect(bare(r.full, ["rev-parse", "main"]).trim()).toBe(main);
    expect(bare(r.full, ["rev-parse", branch]).trim()).toBe(first.json.commit_sha);
    bare(r.full, ["fsck", "--strict", "--no-dangling"]);
    const { rows } = await fx.admin.query<{ name: string; email: string }>(
      `SELECT name, email FROM users WHERE id = $1`,
      [w.owner.id],
    );
    const owner = must(rows[0]);
    expect(bare(r.full, ["log", "-1", "--format=%an|%ae|%cn|%P|%s", branch]).trim()).toBe(
      `${owner.name}|${owner.email}|${owner.name} via Kobe|${main}|Explain more`,
    );
    expect(bare(r.full, ["show", `${branch}:README.md`])).toBe("# Hi\n\nMore.\n");
    expect(bare(r.full, ["show", `${branch}:docs/new.md`])).toBe("new\n");
    expect(bare(r.full, ["show", `${branch}:docs/a.md`])).toBe("a\n");
    const prs = forgejo.pullRequests(r.slug);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 1, title: "Explain more", head: branch, base: "main" });
    expect(prs[0]?.body).toMatch(
      /^The readme was short\.\n\n---\nCommitted by .+ with Kobe's commit dialog$/,
    );
    // Nothing of Kobe's own history moved: the Repo's record is the host.
    const info = await as(w.owner, w.team).request("GET", `/v1/projects/${r.id}/repo-status`);
    expect(info.status).toBe(200);
    expect(repoCommitInfoSchema.parse(info.json)).toMatchObject({
      repo: {
        default_branch: "main",
        direct_commits: false,
        can_commit: true,
        pull_request: { branch, number: 1 },
        working_copy: null,
      },
    });

    // The next commit from the same working copy is added to the open pull request.
    expect(
      (
        await save(
          as(w.owner, w.team),
          `${r.dir}/docs/new.md`,
          sha(Buffer.from("new\n")),
          "newer\n",
        )
      ).status,
    ).toBe(200);
    const second = await commit(as(w.owner, w.team), r.id, "Tweak");
    expect(second.json).toMatchObject({ status: "pull_request", number: 1, opened: false, branch });
    expect(bare(r.full, ["log", "-1", "--format=%P", branch]).trim()).toBe(first.json.commit_sha);
    expect(forgejo.pullRequests(r.slug)).toHaveLength(1);
    expect((await commit(as(w.owner, w.team), r.id, "Again")).json).toEqual({
      status: "nothing_to_commit",
    });

    // A merged or closed pull request: the next commit starts a new one.
    forgejo.closedPulls.add(1);
    expect(
      (await save(as(w.owner, w.team), `${r.dir}/docs/a.md`, sha(Buffer.from("a\n")), "A\n"))
        .status,
    ).toBe(200);
    const third = await commit(as(w.owner, w.team), r.id, "Another change");
    expect(third.json).toMatchObject({ status: "pull_request", number: 2, opened: true });
    expect(third.json.branch).not.toBe(branch);

    const committed = await audits(w.team, "git.repo.committed");
    expect(committed.map((a) => [a.mode, a.opened, a.number])).toEqual([
      ["pull_request", true, 1],
      ["pull_request", false, 1],
      ["pull_request", true, 2],
    ]);
    expect(JSON.stringify(committed)).not.toContain("README");
    expect(JSON.stringify(committed)).not.toContain(branch);
  });
});

describe("direct commits and conflicts (ac-2)", () => {
  it("commits straight to the default branch when the connection allows it; Kobe's copy follows", async () => {
    const w = await world();
    const r = await repo(w);
    const patch = await as(w.admin, w.team).request(
      "PATCH",
      `/v1/team/git/connections/${w.connectionId}`,
      { direct_commits: true },
    );
    expect(patch.status, patch.text).toBe(200);
    expect((await audits(w.team, "git.connection.updated")).at(-1)).toMatchObject({
      fields: ["direct_commits"],
    });
    const main = bare(r.full, ["rev-parse", "main"]).trim();
    expect(
      (
        await save(
          as(w.owner, w.team),
          `${r.dir}/README.md`,
          sha(Buffer.from("# Hi\n")),
          "# Direct\n",
        )
      ).status,
    ).toBe(200);
    const res = await commit(as(w.owner, w.team), r.id, "Straight in");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ status: "pushed", branch: "main", seq: 2 });
    expect(bare(r.full, ["rev-parse", "main"]).trim()).toBe(res.json.commit_sha);
    expect(bare(r.full, ["log", "-1", "--format=%P", "main"]).trim()).toBe(main);
    expect(forgejo.pullRequests(r.slug)).toHaveLength(0);
    const { rows } = await fx.admin.query<{ mirror_head_sha: string }>(
      `SELECT mirror_head_sha FROM git_repositories WHERE team_id = $1 AND project_id = $2`,
      [w.team, r.id],
    );
    expect(rows[0]?.mirror_head_sha).toBe(res.json.commit_sha);
    const checkout = await as(w.owner, w.team).request("GET", `/v1/projects/${r.id}/checkout`);
    expect(checkout.json).toMatchObject({ base_commit_seq: 2, diff: [] });
    expect((await audits(w.team, "git.repo.committed")).at(-1)).toMatchObject({
      mode: "direct",
      fallback: false,
      commitSha: res.json.commit_sha,
    });
  });

  it("refuses when the default branch moved on the host, and overwrites nothing", async () => {
    const w = await world();
    const r = await repo(w);
    await as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
      direct_commits: true,
    });
    // Someone pushes to main on the host.
    const tree = bare(r.full, ["rev-parse", "main^{tree}"]).trim();
    const moved = bare(r.full, ["commit-tree", tree, "-p", "main", "-m", "On the host"]).trim();
    bare(r.full, ["update-ref", "refs/heads/main", moved]);
    expect(
      (
        await save(
          as(w.owner, w.team),
          `${r.dir}/README.md`,
          sha(Buffer.from("# Hi\n")),
          "# Mine\n",
        )
      ).status,
    ).toBe(200);
    const res = await commit(as(w.owner, w.team), r.id, "Mine");
    expect(res.status, res.text).toBe(409);
    expect(res.json).toMatchObject({ code: "repo_moved" });
    expect(res.json.message).toMatch(/Update, then commit again/);
    expect(bare(r.full, ["rev-parse", "main"]).trim()).toBe(moved);
    expect((await audits(w.team, "git.repo.commit_failed")).at(-1)).toMatchObject({
      mode: "direct",
      failure: "repo_moved",
    });
  });

  it("opens a pull request when the host refuses a commit to the default branch", async () => {
    const w = await world();
    const r = await repo(w);
    await as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
      direct_commits: true,
    });
    const hook = path.join(git.root, `${r.full}.git`, "hooks", "pre-receive");
    writeFileSync(
      hook,
      '#!/bin/sh\nwhile read old new ref; do [ "$ref" = refs/heads/main ] && { echo "main is protected" >&2; exit 1; }; done\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    expect(
      (await save(as(w.owner, w.team), `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# PR\n"))
        .status,
    ).toBe(200);
    const res = await commit(as(w.owner, w.team), r.id, "Through review");
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ status: "pull_request", opened: true, fallback: true });
    expect(forgejo.pullRequests(r.slug)).toHaveLength(1);
  });

  it("refuses at a read-only connection, and refuses readers", async () => {
    const w = await world();
    const r = await repo(w);
    await as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
      access_level: "read",
    });
    expect(
      (await save(as(w.owner, w.team), `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# RO\n"))
        .status,
    ).toBe(200);
    const res = await commit(as(w.owner, w.team), r.id, "Nope");
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ code: "repo_unavailable" });
    expect(res.json.message).toMatch(/Read and write/);
    // A Workspace reader (team role member) can't check out to commit at all.
    expect(
      (await as(w.member, w.team).request("POST", `/v1/projects/${r.id}/checkout`, {})).status,
    ).toBe(403);
    const info = repoCommitInfoSchema.parse(
      (await as(w.member, w.team).request("GET", `/v1/projects/${r.id}/repo-status`)).json,
    );
    expect(info.repo?.can_commit).toBe(false);
  });
});

describe("a conversation on a Repo gets a git working copy (ac-3)", () => {
  it("names the Repo in run.start.git and keeps the sandbox's ahead/behind for the member", async () => {
    const w = await world();
    const r = await repo(w);
    const made = await as(w.owner, w.team).request("POST", "/v1/threads", { project_id: r.id });
    expect(made.status, made.text).toBe(201);
    const threadId = made.json.thread_id as string;
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, threadId],
    );
    const runId = must(rows[0]).id;
    const target = { teamId: w.team, userId: w.owner.id };
    const context = must(await loadRunGitContext(fx.db, target, "kobe.test"));
    // The fake host is served on a port; the sandbox's git reaches only https on 443, so the
    // remote is given as the test's own (as for a connection on 443).
    const base = forgejo.baseUrl.replace(/^http:/, "https:").replace(/:\d+$/, "");
    const remotes = [{ base_url: base, organization: "acme" }];
    await fx.admin.query(`UPDATE git_connections SET base_url = $2 WHERE team_id = $1`, [
      w.team,
      base,
    ]);
    const got = await runGitRepo(fx.db, target, threadId, { ...context, remotes });
    expect(got).toEqual({
      project_id: r.id,
      slug: r.slug,
      clone_url: `${base}/acme/${r.slug}.git`,
      default_branch: "main",
      access: "write",
    });
    // Not listed among the sandbox's remotes: no working copy.
    expect(await runGitRepo(fx.db, target, threadId, { ...context, remotes: [] })).toBeUndefined();
    // Another member's thread: nothing.
    expect(
      await runGitRepo(fx.db, { teamId: w.team, userId: w.member.id }, threadId, {
        ...context,
        remotes,
      }),
    ).toBeUndefined();

    const report = {
      v: 1 as const,
      type: "repo.status" as const,
      run_id: runId,
      thread_id: threadId,
      project_id: r.id,
      branch: "fix/typo",
      head_sha: "a".repeat(40),
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      dirty: true,
      fetched: true,
      problem: null,
    };
    expect(await recordRepoStatus(fx.db, target, report)).toBe(true);
    // Another member cannot report on this thread.
    expect(await recordRepoStatus(fx.db, { teamId: w.team, userId: w.member.id }, report)).toBe(
      false,
    );
    const info = repoCommitInfoSchema.parse(
      (await as(w.owner, w.team).request("GET", `/v1/projects/${r.id}/repo-status`)).json,
    );
    expect(info.repo?.working_copy).toMatchObject({
      branch: "fix/typo",
      ahead: 2,
      behind: 1,
      dirty: true,
      upstream: "origin/main",
    });
    // Only the member's own: another member sees none.
    const theirs = repoCommitInfoSchema.parse(
      (await as(w.member, w.team).request("GET", `/v1/projects/${r.id}/repo-status`)).json,
    );
    expect(theirs.repo?.working_copy).toBeNull();
  });
});
