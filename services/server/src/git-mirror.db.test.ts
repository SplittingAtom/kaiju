import { randomUUID } from "node:crypto";
import { renameSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { gitRepoAnswerSchema, type GitRepoView } from "@kobe/protocol";
import { mirrorDeps } from "./git/mirror/deps.js";
import { dueRepositories } from "./git/mirror/job.js";
import { GIT_MIRROR_GONE_CONFIRMATIONS } from "./git/mirror/limits.js";
import { refreshRepository, type MirrorDeps } from "./git/mirror/refresh.js";
import { claimRefresh } from "./git/mirror/store.js";
import { projectWriteBlock } from "./projects/repo-state.js";
import {
  forgejo,
  fx,
  git,
  hostRepo,
  kind,
  must,
  project,
  settled,
  start,
  world,
  type World,
} from "./testing/git-conversion-fixture.js";
import { commitOnHost } from "./testing/git-host-commits.js";
import type { Person } from "./testing/event-stream-fixture.js";

/**
 * KOBE-766 (GIT-10, spec workspace-git G17, G20) end to end on a real Postgres, with the Forgejo
 * fake for the API and a real `git http-backend` as the host (`git-conversion-fixture.ts`).
 * ac-1: a commit made on the host appears in the project's files after a refresh; ac-2: a refresh
 * is bounded, backs off on host errors and never blocks reads; ac-3: archived, deleted and
 * disconnected Repos are read-only from their last mirror, and relink and detach work and are
 * audited.
 */
const deps = (): MirrorDeps => mirrorDeps(fx.replica(0).deps);

interface Converted {
  readonly w: World;
  readonly projectId: string;
  readonly slug: string;
  readonly repositoryId: string;
}

async function converted(): Promise<Converted> {
  const w = await world();
  const p = await project(w, [
    { by: w.owner, message: "Start", files: { "README.md": "# Hi\n", "notes.txt": "one\n" } },
  ]);
  hostRepo(p.slug);
  const res = await start(w.owner, p.id, { connection_id: w.connectionId });
  expect(res.status, res.text).toBe(202);
  expect((await settled(w.owner, p.id)).status).toBe("completed");
  const { rows } = await fx.admin.query<{ id: string }>(
    `SELECT id FROM git_repositories WHERE team_id = $1 AND project_id = $2`,
    [w.team, p.id],
  );
  return { w, projectId: p.id, slug: p.slug, repositoryId: must(rows[0]).id };
}

async function repoView(p: Person, projectId: string): Promise<GitRepoView> {
  const res = await p.browser.request("GET", `/v1/projects/${projectId}/repo`);
  expect(res.status, res.text).toBe(200);
  return gitRepoAnswerSchema.parse(res.json).repo;
}

async function files(p: Person, projectId: string): Promise<Record<string, string>> {
  const res = await p.browser.request("GET", `/v1/projects/${projectId}/files`);
  expect(res.status, res.text).toBe(200);
  const out: Record<string, string> = {};
  for (const f of res.json.files as { path: string; sha256: string }[]) out[f.path] = f.sha256;
  return out;
}

/** Waits until no refresh holds the Repo (an open may have started one in the background). */
async function idle(c: Converted): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await fx.admin.query<{ busy: boolean }>(
      `SELECT mirror_lease_until IS NOT NULL AND mirror_lease_until > now() AS busy
         FROM git_repositories WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    if (rows[0]?.busy !== true) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the refresh did not finish");
}

async function repoRow(c: Converted) {
  const { rows } = await fx.admin.query<{
    host_state: string;
    full_name: string;
    mirror_head_sha: string | null;
    mirror_error: string | null;
    mirror_failures: number;
    mirror_next_at: Date | null;
    mirror_commit_id: string | null;
    project_id: string | null;
  }>(
    `SELECT host_state, full_name, mirror_head_sha, mirror_error, mirror_failures, mirror_next_at,
            mirror_commit_id, project_id
       FROM git_repositories WHERE team_id = $1 AND id = $2`,
    [c.w.team, c.repositoryId],
  );
  return must(rows[0]);
}

async function repoAudit(team: string) {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE 'git.repo.%' ORDER BY seq`,
    [team],
  );
  return rows;
}

const hostName = (c: Converted) => `acme/${c.slug}`;

describe("a commit made on the host appears after a refresh (ac-1)", () => {
  it("mirrors the host's files and newest commits, then reads unchanged", async () => {
    const c = await converted();
    const before = await files(c.w.owner, c.projectId);
    expect(Object.keys(before).sort()).toEqual(["README.md", "notes.txt"]);

    const head = commitOnHost(
      git.root,
      hostName(c),
      { "src/app.py": "print('hi')\n", "notes.txt": null, "run.sh": "#!/bin/sh\n" },
      "Work on the host",
    );
    await idle(c);
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("refreshed");
    expect(Object.keys(await files(c.w.owner, c.projectId)).sort()).toEqual([
      "README.md",
      "run.sh",
      "src/app.py",
    ]);
    const view = await repoView(c.w.member, c.projectId);
    expect(view).toMatchObject({
      repository_id: c.repositoryId,
      full_name: hostName(c),
      host_state: "active",
      read_only: false,
      read_only_reason: null,
      can_manage: false,
      mirror: { head_sha: head, failures: 0, error: null },
    });
    expect(view.mirror.refreshed_at).not.toBeNull();
    expect(view.commits[0]).toMatchObject({
      sha: head,
      author_name: "Hana Host",
      message: "Work on the host",
    });
    expect(view.commits.map((m) => m.message)).toContain("Start");
    expect(view.web_url).toBe(`${view.base_url}/${hostName(c)}`);
    // The executable bit is kept.
    const { rows: exec } = await fx.admin.query<{ executable: boolean }>(
      `SELECT e.executable FROM project_tree_entries e
         JOIN projects p ON p.team_id = e.team_id AND p.head_commit_id = e.commit_id
        WHERE p.team_id = $1 AND p.id = $2 AND e.path = 'run.sh'`,
      [c.w.team, c.projectId],
    );
    expect(exec[0]?.executable).toBe(true);

    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("unchanged");

    // A second host change: the previous mirror commit is dropped (the history is on the host).
    const first = must((await repoRow(c)).mirror_commit_id);
    const second = commitOnHost(git.root, hostName(c), { "src/app.py": "print(2)\n" }, "Again");
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("refreshed");
    const row = await repoRow(c);
    expect(row.mirror_head_sha).toBe(second);
    const { rows: gone } = await fx.admin.query(
      `SELECT 1 FROM project_commits WHERE team_id = $1 AND id = $2`,
      [c.w.team, first],
    );
    expect(gone).toHaveLength(0);
    // The project's own (converted) history stays.
    const { rows: seqs } = await fx.admin.query<{ message: string }>(
      `SELECT message FROM project_commits WHERE team_id = $1 AND project_id = $2 ORDER BY seq`,
      [c.w.team, c.projectId],
    );
    expect(seqs.map((s) => s.message)).toEqual([
      "Start",
      `Mirror of ${hostName(c)} at ${second.slice(0, 12)}`,
    ]);
    const audit = await repoAudit(c.w.team);
    expect(audit.map((a) => a.action)).toEqual([
      "git.repo.mirror_updated",
      "git.repo.mirror_updated",
    ]);
    expect(must(audit[0]).target).toMatchObject({
      repositoryId: c.repositoryId,
      projectId: c.projectId,
      headSha: head,
      added: 2,
      deleted: 1,
      modified: 0,
      fileCount: 3,
      skipped: 0,
    });
    // Kobe's own writes still refuse a Repo.
    const revert = await c.w.owner.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/commits/1/revert`,
      {},
    );
    expect([revert.status, revert.json.code]).toEqual([409, "project_is_repo"]);
  });

  it("a push through the egress proxy asks for a refresh; the timer takes due Repos", async () => {
    const c = await converted();
    await idle(c);
    await fx.admin.query(
      `UPDATE git_repositories SET mirror_attempted_at = now() WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    const due = async () => (await dueRepositories(deps())).some((r) => r.id === c.repositoryId);
    expect(await due()).toBe(false);
    const { requestPushRefresh } = await import("./git/mirror/store.js");
    const { rows } = await fx.admin.query<{ base_url: string; host_repo_id: string }>(
      `SELECT base_url, host_repo_id FROM git_repositories WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    const r = must(rows[0]);
    expect(await requestPushRefresh(fx.db, c.w.team, r.base_url, r.host_repo_id)).toBe(true);
    // Due 30 s later (the push follows its decision); then the timer takes it.
    expect(await due()).toBe(false);
    await fx.admin.query(
      `UPDATE git_repositories SET mirror_requested_at = now() - interval '1 second'
        WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    expect(await due()).toBe(true);
    // An interval-old attempt is due too.
    expect((await dueRepositories(deps(), 0)).some((x) => x.id === c.repositoryId)).toBe(true);
  });
});

describe("refreshes back off and never block reads (ac-2)", () => {
  it("records the failure, doubles the back-off and keeps serving the last mirror", async () => {
    const c = await converted();
    await idle(c);
    const before = await files(c.w.owner, c.projectId);
    commitOnHost(git.root, hostName(c), { "later.txt": "x" }, "Later");
    forgejo.fail("server_error");
    const t0 = Date.now();
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("failed");
    let row = await repoRow(c);
    expect(row.mirror_error).toBe("host_unreachable");
    expect(row.mirror_failures).toBe(1);
    const wait1 = must(row.mirror_next_at).getTime() - t0;
    expect(wait1).toBeGreaterThan(4 * 60_000);
    expect(wait1).toBeLessThan(6 * 60_000);
    expect((await dueRepositories(deps(), 0)).some((r) => r.id === c.repositoryId)).toBe(false);

    // Reads answer at once from the last mirror, with the failure.
    const view = await repoView(c.w.member, c.projectId);
    expect(view.mirror.error?.code).toBe("host_unreachable");
    expect(view.mirror.failures).toBe(1);
    expect(await files(c.w.member, c.projectId)).toEqual(before);

    // Refresh (a person) goes past the back-off; failing again doubles it.
    await idle(c);
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("failed");
    row = await repoRow(c);
    expect(row.mirror_failures).toBe(2);
    expect(must(row.mirror_next_at).getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    forgejo.fail(null);
    const res = await c.w.member.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/refresh`,
    );
    expect(res.status, res.text).toBe(202);
    await idle(c);
    for (let i = 0; i < 200 && (await repoRow(c)).mirror_failures > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    row = await repoRow(c);
    expect([row.mirror_error, row.mirror_failures, row.mirror_next_at]).toEqual([null, 0, null]);
    expect(Object.keys(await files(c.w.member, c.projectId))).toContain("later.txt");
  });

  it("a refresh that dies still backs off: the claim counts it first (M1)", async () => {
    const c = await converted();
    await idle(c);
    const claimed = await claimRefresh(fx.db, c.w.team, c.repositoryId, randomUUID());
    expect(claimed).not.toBe("busy");
    // The process "dies" here: nothing settles the attempt. The lease lapses.
    await fx.admin.query(
      `UPDATE git_repositories SET mirror_lease_until = now() - interval '1 second'
        WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    const row = await repoRow(c);
    expect([row.mirror_failures, row.mirror_error]).toEqual([1, "interrupted"]);
    expect(must(row.mirror_next_at).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
    expect((await dueRepositories(deps(), 0)).some((r) => r.id === c.repositoryId)).toBe(false);
    expect((await repoView(c.w.owner, c.projectId)).mirror.error?.code).toBe("interrupted");
    // The next run settles it.
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("unchanged");
    expect(await repoRow(c)).toMatchObject({ mirror_failures: 0, mirror_error: null });
  });

  it("Refresh waits for the host's rate-limit reset and between not-found answers (L2, R2-L2)", async () => {
    const c = await converted();
    await idle(c);
    for (const code of ["host_rate_limited", "repository_not_found"]) {
      await fx.admin.query(
        `UPDATE git_repositories SET mirror_error = $3, mirror_failures = 1,
                mirror_next_at = now() + interval '20 minutes'
          WHERE team_id = $1 AND id = $2`,
        [c.w.team, c.repositoryId, code],
      );
      const res = await c.w.member.browser.request(
        "POST",
        `/v1/projects/${c.projectId}/repo/refresh`,
      );
      expect([res.status, res.json.code]).toEqual([429, code]);
      expect(res.json.retry_after_seconds).toBeGreaterThan(1100);
    }
  });

  it("one refresh per Repo at a time", async () => {
    const c = await converted();
    await idle(c);
    commitOnHost(git.root, hostName(c), { "a.txt": "a" }, "A");
    const [one, two] = await Promise.all([
      refreshRepository(deps(), c.w.team, c.repositoryId),
      refreshRepository(deps(), c.w.team, c.repositoryId),
    ]);
    expect([one, two].sort()).toEqual(["busy", "refreshed"]);
  });

  it("refuses a repository larger than a project may be and keeps the last mirror", async () => {
    const c = await converted();
    await idle(c);
    const many: Record<string, string> = {};
    for (let i = 0; i < 501; i += 1) many[`f/${i}.txt`] = String(i);
    commitOnHost(git.root, hostName(c), many, "Too many");
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("failed");
    expect((await repoRow(c)).mirror_error).toBe("too_many_files");
    expect(Object.keys(await files(c.w.owner, c.projectId)).sort()).toEqual([
      "README.md",
      "notes.txt",
    ]);
  });
});

describe("read-only Repos, relink and detach (ac-3)", () => {
  it("follows a rename, then marks an archived and a deleted repository read-only", async () => {
    const c = await converted();
    await idle(c);
    // Renamed on the host: Kobe follows the host's id.
    forgejo.editRepository(c.slug, { name: `${c.slug}-renamed` });
    renameSync(
      path.join(git.root, `${hostName(c)}.git`),
      path.join(git.root, `${hostName(c)}-renamed.git`),
    );
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("unchanged");
    expect((await repoRow(c)).full_name).toBe(`${hostName(c)}-renamed`);

    forgejo.editRepository(`${c.slug}-renamed`, { archived: true });
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("unchanged");
    let view = await repoView(c.w.owner, c.projectId);
    expect([view.host_state, view.read_only, view.read_only_reason]).toEqual([
      "archived",
      true,
      "archived",
    ]);

    forgejo.deleteRepository(`${c.slug}-renamed`);
    await idle(c);
    // Review M2: one "not found" is a failure, not a deletion (the credential may only have
    // lost sight of it); only several in a row mark the Repo deleted.
    for (let i = 1; i < GIT_MIRROR_GONE_CONFIRMATIONS; i += 1) {
      expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("failed");
      expect(await repoRow(c)).toMatchObject({
        host_state: "archived",
        mirror_error: "repository_not_found",
        mirror_failures: i,
      });
    }
    expect((await repoView(c.w.owner, c.projectId)).read_only_reason).toBe("archived");
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("deleted");
    view = await repoView(c.w.owner, c.projectId);
    expect([view.host_state, view.read_only_reason]).toEqual(["deleted", "deleted"]);
    expect(Object.keys(await files(c.w.owner, c.projectId)).sort()).toEqual([
      "README.md",
      "notes.txt",
    ]);
    expect((await dueRepositories(deps(), 0)).some((r) => r.id === c.repositoryId)).toBe(false);
    expect((await repoAudit(c.w.team)).map((a) => [a.target.from, a.target.to])).toEqual([
      ["active", "archived"],
      ["archived", "deleted"],
    ]);
  });

  it("re-checks a deleted Repo slowly and brings it back when the host shows it again (M2)", async () => {
    const c = await converted();
    await idle(c);
    // As if the credential had lost sight of it earlier and it was marked deleted.
    await fx.admin.query(
      `UPDATE git_repositories SET host_state = 'deleted', mirror_attempted_at = now() - interval '1 hour'
        WHERE team_id = $1 AND id = $2`,
      [c.w.team, c.repositoryId],
    );
    const due = async (goneMs?: number) =>
      (await dueRepositories(deps(), 5 * 60_000, goneMs)).some((r) => r.id === c.repositoryId);
    expect(await due()).toBe(false);
    expect(await due(30 * 60_000)).toBe(true);
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("unchanged");
    expect((await repoRow(c)).host_state).toBe("active");
    expect((await repoAudit(c.w.team)).map((a) => a.target.to)).toEqual(["active"]);
  });

  it("a removed connection makes the Repo read-only; an admin relinks it to another repository", async () => {
    const c = await converted();
    await idle(c);
    // A host change since conversion: its last mirror is the only copy once the host is gone.
    commitOnHost(git.root, hostName(c), { "only-here.txt": "precious\n" }, "Precious");
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("refreshed");
    const lastMirror = must((await repoRow(c)).mirror_commit_id);
    const removed = await c.w.admin.browser.request(
      "DELETE",
      `/v1/team/git/connections/${c.w.connectionId}`,
    );
    expect(removed.status, removed.text).toBeLessThan(300);
    let view = await repoView(c.w.owner, c.projectId);
    expect([view.read_only, view.read_only_reason, view.connection_id]).toEqual([
      true,
      "connection_removed",
      null,
    ]);
    const refresh = await c.w.owner.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/refresh`,
    );
    expect([refresh.status, refresh.json.code]).toEqual([409, "connection_removed"]);

    // A new connection and another repository on the host with its own files.
    const connected = await c.w.admin.browser.request("POST", "/v1/team/git/connections", {
      provider: "forgejo",
      base_url: forgejo.baseUrl.replace(/^http:/, "https:"),
      organization: "acme",
      credential: { kind: "access_token", token: "fake-gitea-token-0123456789abcdef" },
      access_level: "read",
    });
    expect(connected.status, connected.text).toBe(201);
    const connectionId = connected.json.connection.id as string;
    const other = `other-${c.slug}`;
    forgejo.seedRepositories([other]);
    git.repo(`acme/${other}`);
    const otherHead = commitOnHost(
      git.root,
      `acme/${other}`,
      { "OTHER.md": "elsewhere\n" },
      "Other",
    );

    const body = { connection_id: connectionId, repository: other };
    const byOwner = await c.w.owner.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/relink`,
      body,
    );
    expect([byOwner.status, byOwner.json.code]).toEqual([403, "forbidden"]);
    const missing = await c.w.admin.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/relink`,
      { ...body, repository: "no-such-repo" },
    );
    expect([missing.status, missing.json.code]).toEqual([404, "repository_not_found"]);
    forgejo.editRepository(other, { private: false });
    const pub = await c.w.admin.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/relink`,
      body,
    );
    expect([pub.status, pub.json.code]).toEqual([422, "repository_public"]);
    forgejo.editRepository(other, { private: true });

    const relinked = await c.w.admin.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/relink`,
      body,
    );
    expect(relinked.status, relinked.text).toBe(200);
    view = gitRepoAnswerSchema.parse(relinked.json).repo;
    expect(view).toMatchObject({
      full_name: `acme/${other}`,
      connection_id: connectionId,
      read_only: false,
      can_manage: true,
    });
    // The new repository is mirrored right away (in the background).
    for (let i = 0; i < 400; i += 1) {
      if (Object.keys(await files(c.w.owner, c.projectId)).includes("OTHER.md")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(Object.keys(await files(c.w.owner, c.projectId))).toEqual(["OTHER.md"]);
    expect((await repoView(c.w.owner, c.projectId)).mirror.head_sha).toBe(otherHead);
    const old = await repoRow(c);
    expect(old.project_id).toBeNull();
    // Review M3: the old repository's last mirror stays in the project's history.
    const { rows: kept } = await fx.admin.query<{ id: string }>(
      `SELECT c.id FROM project_commits c
         JOIN project_tree_entries e ON e.team_id = c.team_id AND e.commit_id = c.id
        WHERE c.team_id = $1 AND c.id = $2 AND e.path = 'only-here.txt'`,
      [c.w.team, lastMirror],
    );
    expect(kept).toHaveLength(1);
    const relinkAudit = (await repoAudit(c.w.team)).find((a) => a.action === "git.repo.relinked");
    expect(relinkAudit?.target).toMatchObject({
      projectId: c.projectId,
      previousRepositoryId: c.repositoryId,
      connectionId,
      repositoryId: view.repository_id,
    });
  });

  it("an admin detaches a Repo into an ordinary project with one commit of its files", async () => {
    const c = await converted();
    await idle(c);
    forgejo.deleteRepository(c.slug);
    for (let i = 1; i < GIT_MIRROR_GONE_CONFIRMATIONS; i += 1) {
      expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("failed");
    }
    expect(await refreshRepository(deps(), c.w.team, c.repositoryId)).toBe("deleted");
    const byOwner = await c.w.owner.browser.request(
      "POST",
      `/v1/projects/${c.projectId}/repo/detach`,
    );
    expect([byOwner.status, byOwner.json.code]).toEqual([403, "forbidden"]);
    const before = await files(c.w.owner, c.projectId);
    const res = await c.w.admin.browser.request("POST", `/v1/projects/${c.projectId}/repo/detach`);
    expect(res.status, res.text).toBe(200);
    expect(res.json).toMatchObject({ project_id: c.projectId, seq: 2 });
    expect(await kind(c.w.team, c.projectId)).toBe("project");
    expect(await files(c.w.owner, c.projectId)).toEqual(before);
    expect(
      await withTeam(fx.db, c.w.team, (tx) => projectWriteBlock(tx, c.w.team, c.projectId)),
    ).toBeNull();
    const gone = await c.w.owner.browser.request("GET", `/v1/projects/${c.projectId}/repo`);
    expect([gone.status, gone.json.code]).toEqual([404, "not_a_repo"]);
    expect((await repoRow(c)).project_id).toBeNull();
    const audit = (await repoAudit(c.w.team)).find((a) => a.action === "git.repo.detached");
    expect(audit?.target).toMatchObject({
      repositoryId: c.repositoryId,
      projectId: c.projectId,
      commitId: res.json.commit_id,
    });
  });
});
