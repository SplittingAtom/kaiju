import { createHash } from "node:crypto";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sweepGitConversions } from "./git/conversion/job.js";
import { runConversion } from "./git/conversion/runner.js";
import { repoReadRules, repoReadable, repoRefusal } from "./git/transport.js";
import { startConversion } from "./git/conversion/start.js";
import { LeaseLost } from "./git/conversion/store.js";
import {
  audit,
  bare,
  deps,
  forgejo,
  fx,
  git,
  hostRepo,
  kind,
  must,
  project,
  setWireHook,
  settled,
  start,
  world,
  type World,
} from "./testing/git-conversion-fixture.js";

/**
 * KOBE-765 review (g104): the guards. H1: private history never goes to a public repository
 * (checked on create, adopt, every read of the recorded repository, before every batch and at
 * the finish). M1: names git's fsck refuses are refused before anything is created. M2: only a
 * Workspace admin chooses an existing repository, and one with any conversion's mark is refused.
 * M3: one conversion per replica; the poison guard. L3: no delete or archive while a conversion
 * holds the project. Unsaved working copies are refused.
 */

/** An attempt started without the route's own run (the test drives the job). */
async function begin(w: World, projectId: string, body: Record<string, unknown> = {}) {
  const started = await startConversion(deps(), { teamId: w.team, userId: w.owner.id }, projectId, {
    connection_id: w.connectionId,
    ...body,
  });
  if (!started.ok) throw new Error(JSON.stringify(started.body));
  return started.value.id;
}

const threeCommits = (w: World) =>
  project(w, [
    { by: w.owner, message: "one", files: { "a.txt": "1" } },
    { by: w.owner, message: "two", files: { "a.txt": "2" } },
    { by: w.owner, message: "three", files: { "a.txt": "3" } },
  ]);

const count = (repo: string) => {
  try {
    return bare(repo, ["rev-list", "--count", "main"]).trim();
  } catch {
    return "0";
  }
};

describe("never a public repository (H1)", () => {
  it("stops before the next batch when the repository turned public, and on every retry", async () => {
    const w = await world();
    const p = await threeCommits(w);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    let posts = 0;
    setWireHook((url, method) => {
      if (method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        posts += 1;
        // An org owner makes the repository public while the first batch is on its way.
        if (posts === 1) forgejo.editRepository(p.slug, { private: false });
      }
    });
    expect(await runConversion(deps(), w.team, id)).toBe("failed");
    setWireHook(undefined);
    const repo = `acme/${p.slug}`;
    expect(count(repo)).toBe("1");
    expect(await settled(w.owner, p.id)).toMatchObject({
      status: "failed",
      step: "push",
      error: { code: "repository_public" },
    });
    expect(await kind(w.team, p.id)).toBe("project");
    // A retry while it is still public pushes nothing.
    const retry = await w.owner.browser.request(
      "POST",
      `/v1/projects/${p.id}/repo-conversion/retry`,
    );
    expect(retry.status).toBe(202);
    expect((await settled(w.owner, p.id)).error?.code).toBe("repository_public");
    expect(count(repo)).toBe("1");
    // Private again: the retry resumes after the batch the host has.
    forgejo.editRepository(p.slug, { private: true });
    await w.owner.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/retry`);
    expect((await settled(w.owner, p.id)).status).toBe("completed");
    expect(count(repo)).toBe("3");
  });

  it("never adopts a public repository after an interrupted create", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    let first = true;
    const lose = {
      ...deps(),
      beforeStep: (row: { step: string }) => {
        if (row.step === "push" && first) {
          first = false;
          throw new LeaseLost();
        }
      },
    };
    expect(await runConversion(lose, w.team, id)).toBe("lost");
    await fx.admin.query(
      `UPDATE git_conversions SET host_repo_id = NULL, repository_id = NULL, step = 'create',
              lease_until = now() - interval '1 second' WHERE id = $1`,
      [id],
    );
    forgejo.editRepository(p.slug, { private: false });
    expect(await runConversion(deps(), w.team, id)).toBe("failed");
    expect((await settled(w.owner, p.id)).error?.code).toBe("repository_public");
    expect(count(`acme/${p.slug}`)).toBe("0");
  });
});

describe("files the host refuses (M1)", () => {
  it("a push the host refuses part-way fails with the host's reason; retry finishes it", async () => {
    const w = await world();
    const p = await threeCommits(w);
    hostRepo(p.slug);
    const hook = path.join(git.root, "acme", `${p.slug}.git`, "hooks", "pre-receive");
    const id = await begin(w, p.id);
    let posts = 0;
    setWireHook((url, method) => {
      if (method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        posts += 1;
        // A host rule starts refusing after the first batch.
        if (posts === 2) {
          writeFileSync(hook, "#!/bin/sh\necho 'size rule' >&2\nexit 1\n");
          chmodSync(hook, 0o755);
        }
      }
    });
    expect(await runConversion(deps(), w.team, id)).toBe("failed");
    setWireHook(undefined);
    const view = await settled(w.owner, p.id);
    expect(view).toMatchObject({
      status: "failed",
      step: "push",
      error: { code: "push_rejected" },
    });
    expect(view.error?.detail).toMatch(/hook declined/);
    expect(count(`acme/${p.slug}`)).toBe("1");
    rmSync(hook);
    await w.owner.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/retry`);
    expect((await settled(w.owner, p.id)).status).toBe("completed");
    expect(count(`acme/${p.slug}`)).toBe("3");
  });

  it("lists every name git's fsck refuses, with its commit, before anything is created", async () => {
    const w = await world();
    const p = await project(w, [
      { by: w.owner, message: "ok", files: { "a.txt": "a" } },
      {
        by: w.owner,
        message: "bad",
        files: {
          "a.txt": "a",
          "x/.git:stream": "1",
          "y/git~1./z": "2",
          "GIT~1 /w": "3",
          ".gitmodules": "[submodule]\n",
          "sub/GITMOD~1": "4",
        },
      },
      { by: w.owner, message: "clean again", files: { "a.txt": "b" } },
    ]);
    const res = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("file_rejected_by_host");
    const paths = (res.json.paths as { path: string; seq: number }[]).map((x) => x.path).sort();
    expect(paths).toEqual([
      ".gitmodules",
      "GIT~1 /w",
      "sub/GITMOD~1",
      "x/.git:stream",
      "y/git~1./z",
    ]);
    expect((res.json.paths as { seq: number }[]).every((x) => x.seq === 2)).toBe(true);
    expect(res.json.message).toContain("x/.git:stream (from commit #2)");
    // Without history only the current files count: those are fine.
    hostRepo(`clean-${p.slug}`);
    const without = await start(w.owner, p.id, {
      connection_id: w.connectionId,
      carry_history: false,
      repository_name: `clean-${p.slug}`,
    });
    expect(without.status, without.text).toBe(202);
    expect((await settled(w.owner, p.id)).status).toBe("completed");
  });

  it("stops on a .gitattributes line the host refuses before creating the repository", async () => {
    const w = await world();
    const p = await project(w, [
      { by: w.owner, message: "attrs", files: { ".gitattributes": `${"x".repeat(2100)} text\n` } },
    ]);
    const id = await begin(w, p.id);
    expect(await runConversion(deps(), w.team, id)).toBe("failed");
    const view = await settled(w.owner, p.id);
    expect(view).toMatchObject({
      status: "failed",
      step: "create",
      repository_created: false,
      error: { code: "file_rejected_by_host" },
    });
    expect(view.error?.detail).toContain(".gitattributes");
    expect(forgejo.apiHits().some((h) => h.method === "POST" && h.path.endsWith("/repos"))).toBe(
      false,
    );
  });
});

describe("existing repositories (M2, L6)", () => {
  it("only a Workspace admin may choose one; marked, mismatched or non-empty ones are refused", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    const owner = await start(w.owner, p.id, { connection_id: w.connectionId, use_existing: true });
    expect([owner.status, owner.json.code]).toEqual([403, "existing_repository_admin_only"]);

    const run = async (name: string) => {
      const res = await start(w.admin, p.id, {
        connection_id: w.connectionId,
        use_existing: true,
        repository_name: name,
      });
      expect(res.status, res.text).toBe(202);
      return settled(w.admin, p.id);
    };
    const abandon = () =>
      w.admin.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/abandon`);

    forgejo.seedRepositories([`marked-${p.slug}`]);
    hostRepo(`marked-${p.slug}`);
    forgejo.editRepository(`marked-${p.slug}`, {
      description:
        "Converted from a Kobe project. kobe-conversion:00000000-0000-4000-8000-000000000000",
    });
    expect((await run(`marked-${p.slug}`)).error?.code).toBe("repository_in_use");
    await abandon();

    forgejo.seedRepositories([`branch-${p.slug}`]);
    hostRepo(`branch-${p.slug}`);
    forgejo.editRepository(`branch-${p.slug}`, { defaultBranch: "trunk" });
    const mismatch = await run(`branch-${p.slug}`);
    expect(mismatch.error).toMatchObject({ code: "default_branch_mismatch", detail: "trunk" });
    expect(count(`acme/branch-${p.slug}`)).toBe("0");
    await abandon();

    forgejo.seedRepositories([`full-${p.slug}`]);
    hostRepo(`full-${p.slug}`);
    const empty = bare(`acme/full-${p.slug}`, [
      "hash-object",
      "-t",
      "tree",
      "-w",
      "--stdin",
    ]).trim();
    const c = bare(`acme/full-${p.slug}`, ["commit-tree", empty, "-m", "theirs"]).trim();
    bare(`acme/full-${p.slug}`, ["update-ref", "refs/heads/main", c]);
    expect((await run(`full-${p.slug}`)).error?.code).toBe("repository_not_empty");
    await abandon();

    forgejo.seedRepositories([`free-${p.slug}`]);
    hostRepo(`free-${p.slug}`);
    const done = await run(`free-${p.slug}`);
    expect(done).toMatchObject({
      status: "completed",
      use_existing: true,
      repository_created: false,
    });
  });
});

describe("resource guards (M3)", () => {
  it("a replica runs one conversion at a time; the rest wait for the sweep", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    expect(await runConversion({ ...deps(), slots: 0 }, w.team, id)).toBe("busy");
    const { rows } = await fx.admin.query<{ lease_until: Date | null; attempts: number }>(
      `SELECT lease_until, attempts FROM git_conversions WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ lease_until: null, attempts: 0 });
    expect(await sweepGitConversions(deps())).toBeGreaterThanOrEqual(1);
    expect((await settled(w.owner, p.id)).status).toBe("completed");
  });

  it("fails an attempt whose runs keep dying without progress instead of claiming it again", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    const id = await begin(w, p.id);
    // Every run of this attempt dies before it does anything (an out-of-memory kill, say).
    const die = {
      ...deps(),
      beforeStep: () => {
        throw new LeaseLost();
      },
    };
    expect(await runConversion(die, w.team, id)).toBe("lost");
    await fx.admin.query(
      `UPDATE git_conversions SET progress_at = NULL, lease_until = now() - interval '1 second'
        WHERE id = $1`,
      [id],
    );
    expect(await runConversion(die, w.team, id)).toBe("lost");
    // That resume died without progress too: the next claim gives up.
    await fx.admin.query(
      `UPDATE git_conversions SET progress_at = NULL, lease_until = now() - interval '1 second'
        WHERE id = $1`,
      [id],
    );
    expect(await sweepGitConversions(deps())).toBeGreaterThanOrEqual(1);
    const view = await settled(w.owner, p.id);
    expect(view).toMatchObject({ status: "failed", error: { code: "interrupted" } });
    expect((await audit(w.team)).at(-1)).toMatchObject({
      action: "git.project.conversion_failed",
      target: { failure: "interrupted" },
    });
    const { rows } = await fx.admin.query<{ stalls: number }>(
      `SELECT stalls FROM git_conversions WHERE id = $1`,
      [id],
    );
    expect(must(rows[0]).stalls).toBe(2);
    // A person's retry starts afresh.
    await w.owner.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/retry`);
    const after = await fx.admin.query<{ stalls: number; resumes: number }>(
      `SELECT stalls, resumes FROM git_conversions WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]).toEqual({ stalls: 0, resumes: 0 });
  });
});

describe("progress is a real advance (round 2)", () => {
  it("stops an attempt whose runs keep dying mid-push before the host takes a batch", async () => {
    const w = await world();
    const p = await threeCommits(w);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    // The replica dies as it sends the first batch (each run writes its head first: bookkeeping,
    // not progress).
    setWireHook((url, method) => {
      if (method === "POST" && url.pathname.endsWith("/git-receive-pack")) throw new LeaseLost();
    });
    expect(await runConversion(deps(), w.team, id)).toBe("lost");
    // The resume after the step change (create -> push) is real progress; the next two are not.
    for (let i = 0; i < 3; i += 1) {
      await fx.admin.query(
        `UPDATE git_conversions SET lease_until = now() - interval '1 second' WHERE id = $1`,
        [id],
      );
      const outcome = await runConversion(deps(), w.team, id);
      expect(outcome).toBe(i < 2 ? "lost" : "failed");
    }
    setWireHook(undefined);
    const view = await settled(w.owner, p.id);
    expect(view).toMatchObject({ status: "failed", step: "push", error: { code: "interrupted" } });
    const { rows } = await fx.admin.query<{ resumes: number; stalls: number }>(
      `SELECT resumes, stalls FROM git_conversions WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ resumes: 3, stalls: 2 });
  });
});

describe("the project while a conversion holds it (L3) and unsaved working copies", () => {
  it("refuses delete and archive until the attempt is abandoned", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    // Fails at once: the name is taken on the host by a repository this attempt did not create.
    forgejo.seedRepositories([p.slug]);
    const res = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(res.status).toBe(202);
    expect((await settled(w.owner, p.id)).status).toBe("failed");
    const archive = await w.owner.browser.request("PATCH", `/v1/projects/${p.id}`, {
      archived: true,
    });
    expect([archive.status, archive.json.code]).toEqual([409, "conversion_in_progress"]);
    const del = await w.owner.browser.request("DELETE", `/v1/projects/${p.id}`);
    expect([del.status, del.json.code]).toEqual([409, "conversion_in_progress"]);
    await w.owner.browser.request("POST", `/v1/projects/${p.id}/repo-conversion/abandon`);
    const archived = await w.owner.browser.request("PATCH", `/v1/projects/${p.id}`, {
      archived: true,
    });
    expect(archived.status).toBe(200);
  });

  it("refuses while a working copy holds changes, and says how many", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    const { rows } = await fx.admin.query<{ head_commit_id: string }>(
      `SELECT head_commit_id FROM projects WHERE id = $1`,
      [p.id],
    );
    await fx.admin.query(
      `INSERT INTO project_checkouts (team_id, project_id, user_id, base_commit_id) VALUES ($1, $2, $3, $4)`,
      [w.team, p.id, w.member.id, must(rows[0]).head_commit_id],
    );
    const digest = createHash("sha256").update("changed").digest("hex");
    await fx.admin.query(
      `INSERT INTO workspace_files (team_id, user_id, path, rev, sha256, blob_key, size, mtime_ms, origin)
       VALUES ($1, $2, $3, 1, $4, $5, 7, 0, 'sandbox')`,
      [
        w.team,
        w.member.id,
        `projects/${p.slug}/new.txt`,
        digest,
        `kobe/teams/${w.team}/users/${w.member.id}/workspace/${digest}`,
      ],
    );
    const res = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(res.json).toMatchObject({ code: "unsaved_checkouts", checkouts: 1 });
    expect(res.status).toBe(409);
  });
});

describe("a converted Repo under the Repo read rule (KOBE-762)", () => {
  it("is matched by its host id: project readers read it, pushes need editor, Kobe writes are refused", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const id = await begin(w, p.id);
    expect(await runConversion(deps(), w.team, id)).toBe("completed");
    const { rows } = await fx.admin.query<{
      host_repo_id: string;
      full_name: string;
      base_url: string;
    }>(
      `SELECT host_repo_id, full_name, base_url FROM git_repositories
        WHERE team_id = $1 AND project_id = $2`,
      [w.team, p.id],
    );
    const record = must(rows[0]);
    // The host's own view of the repository, as git_get_repository resolves it.
    const repo = { id: record.host_repo_id, fullName: `acme/${p.slug}` };
    const asMember = { teamId: w.team, userId: w.member.id };
    const rules = await repoReadRules(fx.db, asMember, record.base_url, [repo]);
    expect(rules).toEqual([
      { hostRepoId: record.host_repo_id, fullName: record.full_name, projectRole: undefined },
    ]);
    // Every Workspace member reads every project (RV1), so a reader reads the Repo.
    expect(repoReadable("member", rules, repo)).toBe(true);
    // A push needs editor or owner on the project: a contributor who only reads it is refused.
    expect(repoRefusal("contributor", rules)).toMatchObject({ code: "project_reader" });
    const ownerRules = await repoReadRules(
      fx.db,
      { teamId: w.team, userId: w.owner.id },
      record.base_url,
      [repo],
    );
    expect(repoRefusal("contributor", ownerRules)).toBeUndefined();
    // Kobe's own writes are refused; a commit goes to the host (KOBE-767) and needs a checkout.
    const upload = await w.owner.browser.request("POST", `/v1/projects/${p.id}/commit`, {
      message: "more",
    });
    expect([upload.status, upload.json.code]).toEqual([409, "checkout_required"]);
  });
});
