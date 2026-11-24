import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { repoCommitInfoSchema } from "@kobe/protocol";
import { applyMirror } from "./mirror/apply.js";
import { mirrorDeps } from "./mirror/deps.js";
import { refreshRepository } from "./mirror/refresh.js";
import { claimRefresh } from "./mirror/store.js";
import { commitToRepo, GIT_REPO_COMMIT_RATE, type RepoCommitDeps } from "./repo-commit/commit.js";
import { repoCommitWiring } from "./repo-commit/wiring.js";
import { headOf, loadTree } from "../projects/tree.js";
import { checkRateLimit } from "../rate-limit.js";
import { createApp } from "../app.js";
import { RawBody, TestBrowser } from "../testing/browser.js";
import { PUBLIC_URL, type Person } from "../testing/event-stream-fixture.js";
import { createWorkspaceSync } from "../workspace-sync/index.js";
import { loadRunGitContext } from "./sandbox-git.js";
import { recordRepoStatus, runGitRepo } from "./working-copy.js";
import { commitOnHost } from "../testing/git-host-commits.js";
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
} from "../testing/git-conversion-fixture.js";

/**
 * KOBE-767 (GIT-11, spec workspace-git G18, GQ11) on a real Postgres with a real `git
 * http-backend` behind the Forgejo fake (`testing/git-conversion-fixture.ts`). ac-1: a commit from
 * Kaiju's commit dialog to a Repo becomes a git commit authored as the member, on a branch of its
 * own, with a pull request into the default branch; the next commit from the same working copy is
 * added to it. ac-2: with direct commits allowed it goes straight to the default branch (Kaiju's
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
      `${owner.name}|${owner.email}|${owner.name} via Kaiju|${main}|Explain more`,
    );
    expect(bare(r.full, ["show", `${branch}:README.md`])).toBe("# Hi\n\nMore.\n");
    expect(bare(r.full, ["show", `${branch}:docs/new.md`])).toBe("new\n");
    expect(bare(r.full, ["show", `${branch}:docs/a.md`])).toBe("a\n");
    const prs = forgejo.pullRequests(r.slug);
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({ number: 1, title: "Explain more", head: branch, base: "main" });
    expect(prs[0]?.body).toMatch(
      /^The readme was short\.\n\n---\nCommitted by .+ with Kaiju's commit dialog$/,
    );
    // Nothing of Kaiju's own history moved: the Repo's record is the host.
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
  it("commits straight to the default branch when the connection allows it; Kaiju's copy follows", async () => {
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

  it("refuses a file someone changed on the host, and overwrites nothing (H1)", async () => {
    const w = await world();
    const r = await repo(w);
    await as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
      direct_commits: true,
    });
    // Someone changes README.md on the host.
    const moved = commitOnHost(git.root, r.full, { "README.md": "# Theirs\n" }, "On the host");
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
    expect(res.json.message).toMatch(
      /README\.md changed on the git host.*Update, then commit again/,
    );
    expect(bare(r.full, ["rev-parse", "main"]).trim()).toBe(moved);
    expect(bare(r.full, ["show", "main:README.md"])).toBe("# Theirs\n");
    expect((await audits(w.team, "git.repo.commit_failed")).at(-1)).toMatchObject({
      mode: "direct",
      failure: "repo_moved",
    });
  });

  it("keeps another person's change to a different file and builds on it (H1)", async () => {
    const w = await world();
    const r = await repo(w);
    await as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
      direct_commits: true,
    });
    const moved = commitOnHost(git.root, r.full, { "docs/a.md": "theirs\n" }, "On the host");
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
    expect(res.status, res.text).toBe(200);
    // Kaiju's copy stood on an older head, so it is not written now: the mirror brings it in.
    expect(res.json).toMatchObject({ status: "pushed", branch: "main", seq: null });
    expect(bare(r.full, ["log", "-1", "--format=%P", "main"]).trim()).toBe(moved);
    expect(bare(r.full, ["show", "main:docs/a.md"])).toBe("theirs\n");
    expect(bare(r.full, ["show", "main:README.md"])).toBe("# Mine\n");
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

/** The commit deps the REST route builds, for calling the commit flow with test hooks. */
function repoDeps(extra: Partial<RepoCommitDeps> = {}): RepoCommitDeps {
  const d = fx.replica(0).deps;
  return {
    ...repoCommitWiring(d),
    commit: {
      db: fx.db,
      blobs: d.blobs,
      mounts: d.projectMounts,
      limits: { quotaDefaultBytes: 1e12, maxObjectsDefault: 1e6, maxFileBytes: 50 * 1024 * 1024 },
      log: { warn: () => {}, error: () => {} },
    },
    ...extra,
  };
}

async function waitIdle(team: string, projectId: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await fx.admin.query<{ busy: boolean }>(
      `SELECT mirror_lease_until IS NOT NULL AND mirror_lease_until > now() AS busy
         FROM git_repositories WHERE team_id = $1 AND project_id = $2`,
      [team, projectId],
    );
    if (rows[0]?.busy !== true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the mirror refresh did not finish");
}

const directOn = (w: World) =>
  as(w.admin, w.team).request("PATCH", `/v1/team/git/connections/${w.connectionId}`, {
    direct_commits: true,
  });

describe("review fixes (H1, M1, M3, L2, L9)", () => {
  it("a change on the host between the plan and the push is never overwritten (H1)", async () => {
    const w = await world();
    const r = await repo(w);
    await directOn(w);
    const ownerB = as(w.owner, w.team);
    expect(
      (await save(ownerB, `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# Mine\n")).status,
    ).toBe(200);
    const req = {
      owner: { teamId: w.team, userId: w.owner.id },
      projectId: r.id,
      message: "Mine",
      author: { userId: w.owner.id, kind: "user" as const },
    };
    // The same file changes on the host after Kaiju planned the commit: refused, nothing written.
    const same = await commitToRepo(
      repoDeps({
        afterPlan: async () => {
          commitOnHost(git.root, r.full, { "README.md": "# Raced\n" }, "Race");
        },
      }),
      req,
    );
    expect(same).toMatchObject({ status: "refused", error: "repo_moved" });
    expect(bare(r.full, ["show", "main:README.md"])).toBe("# Raced\n");
    // Another file changes instead (a fresh Repo): the commit builds on it and keeps it.
    const w2 = await world();
    const r2 = await repo(w2);
    await directOn(w2);
    expect(
      (
        await save(
          as(w2.owner, w2.team),
          `${r2.dir}/README.md`,
          sha(Buffer.from("# Hi\n")),
          "# Mine\n",
        )
      ).status,
    ).toBe(200);
    const other = await commitToRepo(
      repoDeps({
        afterPlan: async () => {
          commitOnHost(git.root, r2.full, { "docs/a.md": "raced\n" }, "Race 2");
        },
      }),
      {
        ...req,
        owner: { teamId: w2.team, userId: w2.owner.id },
        author: { userId: w2.owner.id, kind: "user" as const },
        projectId: r2.id,
      },
    );
    expect(other).toMatchObject({ status: "pushed", seq: null });
    expect(bare(r2.full, ["show", "main:docs/a.md"])).toBe("raced\n");
    expect(bare(r2.full, ["show", "main:README.md"])).toBe("# Mine\n");
  });

  it("a push the host took is answered and audited even when a later write fails (M3)", async () => {
    const w = await world();
    const r = await repo(w);
    const b = as(w.owner, w.team);
    expect((await save(b, `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# M3\n")).status).toBe(
      200,
    );
    const res = await commitToRepo(
      repoDeps({
        afterPush: () => Promise.reject(new Error("the database went away")),
      }),
      {
        owner: { teamId: w.team, userId: w.owner.id },
        projectId: r.id,
        message: "Survives",
        author: { userId: w.owner.id, kind: "user" },
      },
    );
    expect(res).toMatchObject({ status: "pull_request", opened: true });
    const attempted = await audits(w.team, "git.repo.commit_attempted");
    const committed = await audits(w.team, "git.repo.committed");
    expect(committed.at(-1)?.commitSha).toBe(attempted.at(-1)?.commitSha);
    // The branch row was not written (the hook failed first): the next commit opens a new PR.
    const { rows } = await fx.admin.query(
      `SELECT 1 FROM git_commit_branches WHERE team_id = $1 AND project_id = $2`,
      [w.team, r.id],
    );
    expect(rows).toHaveLength(0);
  });

  it("an agent's commit honours a connection limited to chosen agents (M1)", async () => {
    const w = await world();
    const r = await repo(w);
    const made = await as(w.owner, w.team).request("POST", "/v1/threads", { project_id: r.id });
    const threadId = made.json.thread_id as string;
    const { rows } = await fx.admin.query<{ id: string }>(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, 'user', 'running', now()) RETURNING id`,
      [w.team, threadId],
    );
    const runId = must(rows[0]).id;
    await fx.admin.query(
      `UPDATE git_connections SET agent_ids = ARRAY[gen_random_uuid()] WHERE team_id = $1`,
      [w.team],
    );
    expect(
      (await save(as(w.owner, w.team), `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# A\n"))
        .status,
    ).toBe(200);
    const res = await commitToRepo(repoDeps(), {
      owner: { teamId: w.team, userId: w.owner.id },
      projectId: r.id,
      message: "By an agent",
      author: { userId: w.owner.id, kind: "agent", threadId, runId },
      via: { kind: "agent", threadId, runId, toolCallId: "call-1" },
      approvedAs: "commit_repo",
    });
    expect(res).toMatchObject({ status: "refused", error: "repo_unavailable" });
    expect(res.status === "refused" && res.detail).toMatch(/limited to chosen agents/);
    // Review R2-L1: an agent's commit approved for Kaiju's own copy never pushes to the host.
    const asKobe = await commitToRepo(repoDeps(), {
      owner: { teamId: w.team, userId: w.owner.id },
      projectId: r.id,
      message: "By an agent",
      author: { userId: w.owner.id, kind: "agent", threadId, runId },
      via: { kind: "agent", threadId, runId, toolCallId: "call-2" },
      approvedAs: "commit_project",
    });
    expect(asKobe).toMatchObject({ status: "refused", error: "repo_unavailable" });
    expect(asKobe.status === "refused" && asKobe.detail).toMatch(/approved for Kaiju's own copy/);
  });

  it("answers 429 with Retry-After past the limit before any host call (L2, N1)", async () => {
    const w = await world();
    const r = await repo(w);
    for (let i = 0; i < GIT_REPO_COMMIT_RATE.max; i += 1) {
      await checkRateLimit(fx.db, `git-repo-commits:${w.owner.id}`, GIT_REPO_COMMIT_RATE);
    }
    const b = as(w.owner, w.team);
    expect((await commit(b, r.id, "Nothing yet")).json).toEqual({ status: "nothing_to_commit" });
    expect((await save(b, `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# L2\n")).status).toBe(
      200,
    );
    // Review N1: an over-limit member makes no host request at all.
    const apiBefore = forgejo.apiHits().length;
    const wireBefore = git.requests.length;
    const res = await commit(b, r.id, "Too many");
    expect(res.status).toBe(429);
    expect(forgejo.apiHits().length).toBe(apiBefore);
    expect(git.requests.length).toBe(wireBefore);
    expect(res.json).toMatchObject({ code: "rate_limited" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a moved pull request branch gets a new branch, never an overwrite (L9)", async () => {
    const w = await world();
    const r = await repo(w);
    const b = as(w.owner, w.team);
    expect(
      (await save(b, `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# One\n")).status,
    ).toBe(200);
    const first = await commit(b, r.id, "One");
    const branch = first.json.branch as string;
    const theirs = bare(r.full, [
      "commit-tree",
      bare(r.full, ["rev-parse", `${branch}^{tree}`]).trim(),
      "-p",
      branch,
      "-m",
      "Someone else",
    ]).trim();
    bare(r.full, ["update-ref", `refs/heads/${branch}`, theirs]);
    expect(
      (await save(b, `${r.dir}/README.md`, sha(Buffer.from("# One\n")), "# Two\n")).status,
    ).toBe(200);
    const second = await commit(b, r.id, "Two");
    expect(second.json).toMatchObject({ status: "pull_request", opened: true, number: 2 });
    expect(second.json.branch).not.toBe(branch);
    expect(bare(r.full, ["rev-parse", branch]).trim()).toBe(theirs);
  });

  it("refuses a Contributor who is only a reader of the project, and other Workspaces' reads", async () => {
    const w = await world();
    const r = await repo(w);
    const reader = w.member;
    await fx.admin.query(
      `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
      [w.team, reader.id],
    );
    const res = await commit(as(reader, w.team), r.id, "Nope");
    expect(res.status, res.text).toBe(403);
    const outsider = await fx.person(`ro${randomUUID().slice(0, 8)}`);
    const other = await fx.team(`other-${randomUUID().slice(0, 8)}`, outsider, []);
    const read = await as(outsider, other).request("GET", `/v1/projects/${r.id}/repo-status`);
    expect(read.status).toBe(404);
  });
});

describe("the Repo mirror and Kaiju's commit flow together (KOBE-766 wiring)", () => {
  it("a refresh that read the host before a direct commit does not write it back", async () => {
    const w = await world();
    const r = await repo(w);
    await directOn(w);
    await waitIdle(w.team, r.id);
    const { rows: repoRows } = await fx.admin.query<{ id: string }>(
      `SELECT id FROM git_repositories WHERE team_id = $1 AND project_id = $2`,
      [w.team, r.id],
    );
    const repositoryId = must(repoRows[0]).id;
    // A refresh claims the Repo and reads the host (the old head and files)...
    const owner = randomUUID();
    const claimed = await claimRefresh(fx.db, w.team, repositoryId, owner);
    if (claimed === "busy") throw new Error("busy");
    const oldTree = await withTeam(fx.db, w.team, async (tx) => {
      const head = await headOf(tx, w.team, r.id);
      return loadTree(tx, w.team, head?.id ?? null);
    });
    // ...then a direct commit lands and Kaiju's copy takes it...
    expect(
      (await save(as(w.owner, w.team), `${r.dir}/README.md`, sha(Buffer.from("# Hi\n")), "# New\n"))
        .status,
    ).toBe(200);
    const res = await commit(as(w.owner, w.team), r.id, "Direct");
    expect(res.json).toMatchObject({ status: "pushed", seq: 2 });
    // ...and the stale refresh finishes: it stops instead of writing the old files back.
    const applied = await applyMirror(fx.db, { teamId: w.team, id: repositoryId, owner }, claimed, {
      head: must(claimed.mirrorHeadSha),
      tree: oldTree,
      commits: [],
      skipped: 0,
    });
    expect(applied).toEqual({ kind: "stale" });
    const { rows } = await fx.admin.query<{ head: string; seq: number }>(
      `SELECT g.mirror_head_sha AS head, c.seq FROM git_repositories g
         JOIN projects p ON p.team_id = g.team_id AND p.id = g.project_id
         JOIN project_commits c ON c.team_id = p.team_id AND c.id = p.head_commit_id
        WHERE g.team_id = $1 AND g.id = $2`,
      [w.team, repositoryId],
    );
    expect(rows[0]).toEqual({ head: res.json.commit_sha, seq: 2 });
  });

  it("sweeps a mirror commit a checkout kept alive once the checkout moved on (review L1)", async () => {
    const w = await world();
    const r = await repo(w);
    await waitIdle(w.team, r.id);
    const { rows: repoRows } = await fx.admin.query<{ id: string }>(
      `SELECT id FROM git_repositories WHERE team_id = $1 AND project_id = $2`,
      [w.team, r.id],
    );
    const repositoryId = must(repoRows[0]).id;
    const mdeps = mirrorDeps(fx.replica(0).deps);
    const head = async () => {
      const { rows } = await fx.admin.query<{ id: string }>(
        `SELECT head_commit_id AS id FROM projects WHERE team_id = $1 AND id = $2`,
        [w.team, r.id],
      );
      return must(rows[0]).id;
    };
    const exists = async (id: string) =>
      (
        await fx.admin.query(`SELECT 1 FROM project_commits WHERE team_id = $1 AND id = $2`, [
          w.team,
          id,
        ])
      ).rows.length === 1;
    const converted = await head();
    // The owner's checkout (from repo()) is based on the converted head: drop it first.
    await as(w.owner, w.team).request("DELETE", `/v1/projects/${r.id}/checkout`);
    commitOnHost(git.root, r.full, { "docs/b.md": "1\n" }, "One");
    expect(await refreshRepository(mdeps, w.team, repositoryId)).toBe("refreshed");
    const m1 = await head();
    // A checkout keeps m1 alive through the next refresh...
    expect(
      (await as(w.owner, w.team).request("POST", `/v1/projects/${r.id}/checkout`, {})).status,
    ).toBe(200);
    commitOnHost(git.root, r.full, { "docs/b.md": "2\n" }, "Two");
    expect(await refreshRepository(mdeps, w.team, repositoryId)).toBe("refreshed");
    const m2 = await head();
    expect(await exists(m1)).toBe(true);
    // ...and once it is gone, the next pass (even an unchanged one) sweeps it.
    await as(w.owner, w.team).request("DELETE", `/v1/projects/${r.id}/checkout`);
    expect(await refreshRepository(mdeps, w.team, repositoryId)).toBe("unchanged");
    expect(await exists(m1)).toBe(false);
    expect(await exists(m2)).toBe(true);
    // Kaiju's history from before the conversion stays.
    expect(await exists(converted)).toBe(true);
  });
});
