import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { GIT_SITE_ENABLED_KEY, loadEnvelope, withTeam, type Envelope } from "@kobe/db";
import { gitConversionViewSchema, type GitConversionView } from "@kobe/protocol";
import { rawRequest } from "./connectors/oauth/http.js";
import { conversionDeps } from "./git/conversion/deps.js";
import { sweepGitConversions } from "./git/conversion/job.js";
import { runConversion, type ConversionDeps } from "./git/conversion/runner.js";
import { LeaseLost } from "./git/conversion/store.js";
import { GitHostError } from "./git-hosts/adapter.js";
import type { GitWireSend } from "./git-hosts/git-wire.js";
import { projectBlobKey, writeCommit, type TreeFile } from "./projects/tree.js";
import { EventStreamFixture, type Person } from "./testing/event-stream-fixture.js";
import { FakeGitea } from "./testing/fake-gitea.js";
import { startGitServer, type GitServer } from "./testing/git-http-server.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import type { MemoryMailer } from "./testing/mailer.js";

/**
 * KOBE-765 (GIT-9, spec workspace-git G15-G17, GQ12, GQ13) end to end on a real Postgres: a
 * Forgejo fake answers the API, a real `git http-backend` (with `receive.fsckObjects`) receives
 * the pushes. ac-1: a project with history converts and the host has the same commits with
 * authors and messages; ac-2: refusals name the reason, a crash mid-push resumes, a crash between
 * the host's create and the record adopts only the repository the attempt created, a failure
 * leaves the project an ordinary project with retry and abandon; ac-3: `git.project.converted`.
 */
const must = <T>(v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error("expected a value");
  return v;
};
const short = () => randomUUID().slice(0, 8);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PREFIX = "kobe/";

const fx = new EventStreamFixture();
const forgejo = new FakeGitea("forgejo");
const objects = new MemoryObjects();
let git: GitServer;
let gitPort: number;
let envelope: Envelope;
/** Wire hooks for one test: runs before each smart-HTTP exchange is sent. */
let wireHook: ((url: URL, method: string) => void) | undefined;

/** Smart-HTTP after the checks: to the local git server (the fake host's name stays in the URL). */
const wire: GitWireSend = (exchange) => {
  wireHook?.(exchange.url, exchange.method);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: gitPort,
        method: exchange.method,
        path: `${exchange.url.pathname}${exchange.url.search}`,
        headers: {
          ...exchange.headers,
          "content-length": String(exchange.body.reduce((n, c) => n + c.length, 0)),
        },
      },
      (res) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === "string") headers[k] = v;
        resolve({
          status: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? "",
          headers,
          body: res[Symbol.asyncIterator]() as AsyncIterableIterator<Uint8Array>,
        });
      },
    );
    req.on("error", reject);
    for (const c of exchange.body) req.write(c);
    req.end();
  });
};

beforeAll(async () => {
  await forgejo.start();
  git = await startGitServer({
    credentials: { username: forgejo.login, token: "fake-gitea-token-0123456789abcdef" },
  });
  gitPort = Number(new URL(git.origin).port);
  envelope = must(loadEnvelope({ KOBE_ENVELOPE_KEY: "c".repeat(48) }));
  await fx.setup([{}], () => ({
    envelope,
    blobs: { objects, prefix: PREFIX },
    gitHostRequest: (url, io, init) =>
      rawRequest(new URL(url.href.replace(/^https:/, "http:")), io, init),
    gitWireSend: wire,
    connectors: {
      allowHttp: false,
      allowedPorts: [forgejo.port],
      allowedInternalCidrs: [],
      addresses: withTestLoopback(),
      resolve: () => Promise.resolve(["127.0.0.1"]),
    },
  }));
}, 120_000);

afterAll(async () => {
  await fx.teardown();
  await forgejo.close();
  await git.close();
});

beforeEach(async () => {
  forgejo.reset();
  wireHook = undefined;
  await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [GIT_SITE_ENABLED_KEY]);
});

const unreachable = () =>
  new GitHostError("host_unreachable", "The git host could not be reached.");
const deps = (): ConversionDeps => ({ ...conversionDeps(fx.replica(0).deps), batchBytes: 1 });
const mailer = () => fx.replica(0).deps.mailer as MemoryMailer;

interface World {
  readonly team: string;
  readonly admin: Person;
  readonly owner: Person;
  readonly member: Person;
  readonly connectionId: string;
}

async function world(level: "read" | "read_write" = "read_write"): Promise<World> {
  const admin = await fx.person(`ca${short()}`);
  const owner = await fx.person(`co${short()}`);
  const member = await fx.person(`cm${short()}`);
  const team = await fx.team(`conv-${short()}`, admin, [owner, member]);
  await fx.admin.query(
    `UPDATE team_members SET role = 'contributor' WHERE team_id = $1 AND user_id = $2`,
    [team, owner.id],
  );
  const res = await admin.browser.request("POST", "/v1/team/git/connections", {
    provider: "forgejo",
    base_url: forgejo.baseUrl.replace(/^http:/, "https:"),
    organization: "acme",
    credential: { kind: "access_token", token: "fake-gitea-token-0123456789abcdef" },
    access_level: level,
  });
  expect(res.status, res.text).toBe(201);
  return { team, admin, owner, member, connectionId: res.json.connection.id as string };
}

/** A project owned by `owner` with commits written as Kobe writes them (blobs in the store). */
async function project(
  w: World,
  commits: readonly { by: Person; message: string; files: Record<string, string> }[],
): Promise<{ id: string; slug: string }> {
  const slug = `p-${short()}`;
  const res = await w.owner.browser.request("POST", "/v1/projects", {
    name: `Project ${slug}`,
    slug,
  });
  expect(res.status, res.text).toBe(201);
  const id = res.json.id as string;
  for (const c of commits) {
    const tree = new Map<string, TreeFile>();
    for (const [path, content] of Object.entries(c.files)) {
      const bytes = Buffer.from(content);
      const digest = sha(bytes);
      const key = projectBlobKey(PREFIX, w.team, id, digest);
      objects.objects.set(key, bytes);
      tree.set(path, {
        path,
        sha256: digest,
        blobRef: key,
        size: bytes.length,
        mime: "text/plain",
        executable: path.endsWith(".sh"),
      });
    }
    await withTeam(fx.db, w.team, (tx) =>
      writeCommit(tx, {
        teamId: w.team,
        projectId: id,
        tree,
        author: { userId: c.by.id, kind: "user" },
        message: c.message,
      }),
    );
  }
  return { id, slug };
}

const start = (p: Person, projectId: string, body: Record<string, unknown>) =>
  p.browser.request("POST", `/v1/projects/${projectId}/repo-conversion`, body);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

async function settled(p: Person, projectId: string): Promise<GitConversionView> {
  for (let i = 0; i < 200; i += 1) {
    const res = await p.browser.request("GET", `/v1/projects/${projectId}/repo-conversion`);
    expect(res.status, res.text).toBe(200);
    const view = gitConversionViewSchema.parse(res.json.conversion);
    if (view.status !== "running") return view;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the conversion did not settle");
}

const bare = (repo: string, args: string[]) => git.git(repo, args, { bare: true });
function hostRepo(name: string) {
  git.repo(`acme/${name}`);
  bare(`acme/${name}`, ["config", "receive.fsckObjects", "true"]);
}

async function audit(team: string) {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE 'git.project.%' ORDER BY seq`,
    [team],
  );
  return rows;
}

/** An active hold on one member of the team (any hold in the team holds its projects). */
async function placeHold(teamId: string, userId: string): Promise<string> {
  const placer = await fx.person(`hp${short()}`);
  const approver = await fx.person(`ha${short()}`);
  for (const p of [placer, approver]) {
    await fx.admin.query(`INSERT INTO site_roles (user_id, role) VALUES ($1, 'admin')`, [p.id]);
  }
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter', $3) RETURNING id`,
    [teamId, userId, placer.id],
  );
  const id = must(rows[0]).id;
  await fx.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    approver.id,
  ]);
  return id;
}

async function kind(team: string, projectId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ kind: string }>(
    `SELECT kind FROM projects WHERE team_id = $1 AND id = $2`,
    [team, projectId],
  );
  return must(rows[0]).kind;
}

describe("converting a project with history (ac-1, ac-3)", () => {
  it("writes every commit with its author and message, then marks the project a Repo", async () => {
    const w = await world();
    const p = await project(w, [
      { by: w.owner, message: "Start the project", files: { "README.md": "# Hi\n" } },
      {
        by: w.member,
        message: "Add a script\n\nAnd explain it.",
        files: { "README.md": "# Hi\n\nMore.\n", "bin/run.sh": "#!/bin/sh\necho hi\n" },
      },
      { by: w.owner, message: "Drop the readme", files: { "bin/run.sh": "#!/bin/sh\necho hi\n" } },
    ]);
    // The member left since: the history keeps their name, never their mailbox.
    await fx.admin.query(`UPDATE users SET deactivated_at = now() WHERE id = $1`, [w.member.id]);
    hostRepo(p.slug);
    const res = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(res.status, res.text).toBe(202);
    expect(res.json.conversion).toMatchObject({
      status: "running",
      step: "create",
      full_name: `acme/${p.slug}`,
      visibility: "private",
      carry_history: true,
      commits_total: 3,
    });
    const view = await settled(w.owner, p.id);
    expect(view, JSON.stringify(view)).toMatchObject({
      status: "completed",
      step: "done",
      commits_pushed: 3,
      repository_created: true,
      error: null,
    });

    const repo = `acme/${p.slug}`;
    bare(repo, ["fsck", "--strict", "--no-dangling"]);
    const log = bare(repo, ["log", "--reverse", "--format=%an|%ae|%cn|%s", "main"])
      .trim()
      .split("\n");
    const { rows: names } = await fx.admin.query<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM users WHERE id = ANY($1)`,
      [[w.owner.id, w.member.id]],
    );
    const ownerRow = must(names.find((n) => n.id === w.owner.id));
    const memberRow = must(names.find((n) => n.id === w.member.id));
    expect(log[0]).toBe(
      `${ownerRow.name}|${ownerRow.email}|${ownerRow.name} via Kobe|Start the project`,
    );
    expect(log[1]).toMatch(
      new RegExp(
        `^${memberRow.name}\\|[0-9a-f]{10}\\+[a-z0-9-]+@users\\.noreply\\.kobe\\.test\\|${memberRow.name} via Kobe\\|Add a script$`,
      ),
    );
    expect(log[1]).not.toContain(memberRow.email);
    expect(log[2]).toContain("|Drop the readme");
    expect(bare(repo, ["log", "-1", "--format=%B", "main~1"]).trim()).toBe(
      "Add a script\n\nAnd explain it.",
    );
    expect(bare(repo, ["ls-tree", "-r", "--format=%(objectmode) %(path)", "main"]).trim()).toBe(
      "100755 bin/run.sh",
    );
    // The original times.
    const { rows: times } = await fx.admin.query<{ t: string }>(
      `SELECT floor(extract(epoch FROM created_at))::bigint AS t FROM project_commits
        WHERE team_id = $1 AND project_id = $2 ORDER BY seq`,
      [w.team, p.id],
    );
    expect(bare(repo, ["log", "--reverse", "--format=%at", "main"]).trim().split("\n")).toEqual(
      times.map((t) => String(t.t)),
    );

    expect(await kind(w.team, p.id)).toBe("repo");
    const { rows: repos } = await fx.admin.query(
      `SELECT project_id, origin, full_name, mirror_head_sha, connection_id FROM git_repositories
        WHERE team_id = $1`,
      [w.team],
    );
    expect(repos).toEqual([
      {
        project_id: p.id,
        origin: "conversion",
        full_name: repo,
        mirror_head_sha: bare(repo, ["rev-parse", "main"]).trim(),
        connection_id: w.connectionId,
      },
    ]);
    const rows = await audit(w.team);
    expect(rows.map((r) => r.action)).toEqual([
      "git.project.conversion_requested",
      "git.project.converted",
    ]);
    expect(must(rows[1]).target).toMatchObject({
      conversionId: view.id,
      projectId: p.id,
      commits: 3,
      headSha: view.head_sha,
    });
    const isDone = (m: { to: string; subject: string }) =>
      m.to === w.owner.email && m.subject.includes("is now a Repo");
    await until(() => mailer().sent.some(isDone));
    const mail = mailer().sent.find(isDone);
    expect(mail?.text).toContain(repo);

    // After conversion: the Files panel reads it as before; every Kobe write is refused (G17).
    const files = await w.owner.browser.request("GET", `/v1/projects/${p.id}/files`);
    expect(files.status).toBe(200);
    expect(files.json.files.map((f: { path: string }) => f.path)).toEqual(["bin/run.sh"]);
    const revert = await w.owner.browser.request(
      "POST",
      `/v1/projects/${p.id}/commits/1/revert`,
      {},
    );
    expect([revert.status, revert.json.code]).toEqual([409, "project_is_repo"]);
    const commit = await w.owner.browser.request("POST", `/v1/projects/${p.id}/commit`, {
      message: "more",
    });
    expect(commit.status).toBe(409);
    expect(commit.json.code).toBe("project_is_repo");
    const fileId = files.json.files[0].id as string;
    const del = await w.owner.browser.request("DELETE", `/v1/projects/${p.id}/files/${fileId}`);
    expect(del.status).toBe(409);
    expect(del.json.code).toBe("project_is_repo");
    // A second conversion is refused.
    const again = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("already_repo");
  });

  it("without history writes one commit of the current files, authored by the requester", async () => {
    const w = await world();
    const p = await project(w, [
      { by: w.member, message: "one", files: { "a.txt": "a" } },
      { by: w.member, message: "two", files: { "a.txt": "a", "b.txt": "b" } },
    ]);
    hostRepo(`hist-off-${p.slug}`);
    const res = await start(w.admin, p.id, {
      connection_id: w.connectionId,
      repository_name: `hist-off-${p.slug}`,
      carry_history: false,
    });
    expect(res.status, res.text).toBe(202);
    const view = await settled(w.admin, p.id);
    expect(view.status, JSON.stringify(view)).toBe("completed");
    const repo = `acme/hist-off-${p.slug}`;
    expect(bare(repo, ["rev-list", "--count", "main"]).trim()).toBe("1");
    expect(bare(repo, ["log", "-1", "--format=%ae|%s", "main"]).trim()).toBe(
      `${w.admin.email}|Project ${p.slug}: files from Kobe`,
    );
    expect(bare(repo, ["ls-tree", "-r", "--name-only", "main"]).trim()).toBe("a.txt\nb.txt");
  });
});

describe("refusals name the reason (ac-2)", () => {
  it("refuses readers, read-only connections, holds, host-rejected files, bad names", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "x", files: { "a.txt": "a" } }]);
    const member = await start(w.member, p.id, { connection_id: w.connectionId });
    expect(member.status).toBe(403);
    const unknown = await start(w.owner, p.id, { connection_id: randomUUID() });
    expect(unknown.json.code).toBe("connection_not_found");
    const badName = await start(w.owner, p.id, {
      connection_id: w.connectionId,
      repository_name: "evil.git",
    });
    expect([badName.status, badName.json.code]).toEqual([422, "invalid_repository_name"]);
    const internal = await start(w.owner, p.id, {
      connection_id: w.connectionId,
      visibility: "internal",
    });
    expect(internal.json.code).toBe("internal_not_offered");

    await fx.admin.query(
      `INSERT INTO site_settings (key, value) VALUES ($1, 'false'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [GIT_SITE_ENABLED_KEY],
    );
    const off = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect([off.status, off.json.code]).toEqual([403, "git_disabled"]);
    await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [GIT_SITE_ENABLED_KEY]);

    const dotgit = await project(w, [
      { by: w.owner, message: "oops", files: { "src/.GIT/config": "[core]\n" } },
    ]);
    const rejected = await start(w.owner, dotgit.id, { connection_id: w.connectionId });
    expect(rejected.json).toMatchObject({
      code: "file_rejected_by_host",
      path: "src/.GIT/config",
    });
    expect(rejected.json.message).toContain("src/.GIT/config");
    // Any active hold in the Workspace holds its projects (left in place: the test ends here).
    await placeHold(w.team, w.member.id);
    const held = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect([held.status, held.json.code]).toEqual([409, "legal_hold"]);
    expect(await audit(w.team)).toEqual([]);

    const ro = await world("read");
    const q = await project(ro, [{ by: ro.owner, message: "x", files: { "a.txt": "a" } }]);
    const readOnly = await start(ro.owner, q.id, { connection_id: ro.connectionId });
    expect([readOnly.status, readOnly.json.code]).toEqual([409, "connection_read_only"]);
  });
});

describe("crashes and failures (ac-2)", () => {
  it("resumes a push a crash interrupted, after the last batch the host took", async () => {
    const w = await world();
    const p = await project(w, [
      { by: w.owner, message: "one", files: { "a.txt": "1" } },
      { by: w.owner, message: "two", files: { "a.txt": "2" } },
      { by: w.owner, message: "three", files: { "a.txt": "3" } },
    ]);
    hostRepo(p.slug);
    // Started without the route's own run: this test drives the job.
    const started = await import("./git/conversion/start.js").then((m) =>
      m.startConversion(deps(), { teamId: w.team, userId: w.owner.id }, p.id, {
        connection_id: w.connectionId,
      }),
    );
    if (!started.ok) throw new Error(JSON.stringify(started.body));
    let pushes = 0;
    wireHook = (url, method) => {
      if (method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
        pushes += 1;
        // The replica dies while sending the second batch.
        if (pushes === 2) throw new LeaseLost();
      }
    };
    expect(await runConversion(deps(), w.team, started.value.id)).toBe("lost");
    const repo = `acme/${p.slug}`;
    expect(bare(repo, ["rev-list", "--count", "main"]).trim()).toBe("1");
    // Commits stay refused while it is held.
    const commit = await w.owner.browser.request("POST", `/v1/projects/${p.id}/commit`, {
      message: "m",
    });
    expect(commit.json.code).toBe("conversion_in_progress");
    // The lease lapses; another replica's sweep picks it up and finishes it.
    wireHook = undefined;
    await fx.admin.query(
      `UPDATE git_conversions SET lease_until = now() - interval '1 second' WHERE id = $1`,
      [started.value.id],
    );
    expect(await sweepGitConversions(deps())).toBeGreaterThanOrEqual(1);
    const view = await settled(w.owner, p.id);
    expect(view).toMatchObject({ status: "completed", commits_pushed: 3, attempts: 2 });
    expect(bare(repo, ["log", "--reverse", "--format=%s", "main"]).trim()).toBe("one\ntwo\nthree");
    bare(repo, ["fsck", "--strict", "--no-dangling"]);
    expect(await kind(w.team, p.id)).toBe("repo");
  });

  it("adopts after an interrupted create only the repository this attempt created", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    const m = await import("./git/conversion/start.js");
    const started = await m.startConversion(deps(), { teamId: w.team, userId: w.owner.id }, p.id, {
      connection_id: w.connectionId,
    });
    if (!started.ok) throw new Error(JSON.stringify(started.body));
    // The host created the repository, but the answer never reached the record.
    let first = true;
    const lose: ConversionDeps = {
      ...deps(),
      beforeStep: (row) => {
        if (row.step === "push" && first) {
          first = false;
          throw new LeaseLost();
        }
      },
    };
    // Simulate "answered but not recorded": run the create, then erase the recorded id.
    expect(await runConversion(lose, w.team, started.value.id)).toBe("lost");
    await fx.admin.query(
      `UPDATE git_conversions SET host_repo_id = NULL, repository_id = NULL, step = 'create',
              lease_until = now() - interval '1 second' WHERE id = $1`,
      [started.value.id],
    );
    expect(await runConversion(deps(), w.team, started.value.id)).toBe("completed");
    expect(await kind(w.team, p.id)).toBe("repo");

    // Another project asking for a name that exists without this attempt's marker: refused.
    const q = await project(w, [{ by: w.owner, message: "one", files: { "b.txt": "1" } }]);
    forgejo.seedRepositories([q.slug]);
    const other = await m.startConversion(deps(), { teamId: w.team, userId: w.owner.id }, q.id, {
      connection_id: w.connectionId,
    });
    if (!other.ok) throw new Error(JSON.stringify(other.body));
    expect(await runConversion(deps(), w.team, other.value.id)).toBe("failed");
    const failed = await settled(w.owner, q.id);
    expect(failed).toMatchObject({
      status: "failed",
      step: "create",
      repository_created: false,
      error: { code: "repository_exists" },
    });
    // Abandon: nothing was created, the project takes commits again.
    const ab = await w.owner.browser.request(
      "POST",
      `/v1/projects/${q.id}/repo-conversion/abandon`,
    );
    expect(ab.status, ab.text).toBe(200);
    expect(ab.json).toMatchObject({ conversion: { status: "abandoned" }, left_on_host: null });
    expect(await kind(w.team, q.id)).toBe("project");
    expect((await audit(w.team)).map((r) => r.action)).toContain(
      "git.project.conversion_abandoned",
    );
  });

  it("a failed push leaves an ordinary project with retry, and abandon reports the repository", async () => {
    const w = await world();
    const p = await project(w, [{ by: w.owner, message: "one", files: { "a.txt": "1" } }]);
    hostRepo(p.slug);
    // The host stops answering at the push.
    wireHook = (url) => {
      if (url.pathname.includes("/info/refs")) throw unreachable();
    };
    const res = await start(w.owner, p.id, { connection_id: w.connectionId });
    expect(res.status).toBe(202);
    const failed = await settled(w.owner, p.id);
    expect(failed).toMatchObject({
      status: "failed",
      step: "push",
      repository_created: true,
      error: { code: "host_unreachable" },
    });
    expect(await kind(w.team, p.id)).toBe("project");
    // The email goes out after the outcome committed.
    await until(() =>
      mailer().sent.some((m) => m.to === w.owner.email && m.subject.includes("failed")),
    );
    const rows = await audit(w.team);
    expect(rows.at(-1)).toMatchObject({
      action: "git.project.conversion_failed",
      target: { step: "push", repositoryCreated: true },
    });
    // Retry resumes at the push and completes.
    wireHook = undefined;
    const retry = await w.owner.browser.request(
      "POST",
      `/v1/projects/${p.id}/repo-conversion/retry`,
    );
    expect(retry.status, retry.text).toBe(202);
    const done = await settled(w.owner, p.id);
    expect(done).toMatchObject({ status: "completed", attempts: 2 });

    // Abandoning another failed attempt reports the repository it leaves on the host.
    const q = await project(w, [{ by: w.owner, message: "one", files: { "c.txt": "1" } }]);
    hostRepo(q.slug);
    wireHook = (url) => {
      if (url.pathname.includes("/info/refs")) throw unreachable();
    };
    await start(w.owner, q.id, { connection_id: w.connectionId });
    await settled(w.owner, q.id);
    const ab = await w.owner.browser.request(
      "POST",
      `/v1/projects/${q.id}/repo-conversion/abandon`,
    );
    expect(ab.json.left_on_host).toMatchObject({ full_name: `acme/${q.slug}` });
    const { rows: kept } = await fx.admin.query(
      `SELECT project_id, origin FROM git_repositories WHERE team_id = $1 AND full_name = $2`,
      [w.team, `acme/${q.slug}`],
    );
    expect(kept).toEqual([{ project_id: null, origin: "conversion" }]);
    // The project takes commits again: a new attempt may start.
    wireHook = undefined;
    hostRepo(`${q.slug}-2`);
    const fresh = await start(w.owner, q.id, {
      connection_id: w.connectionId,
      repository_name: `${q.slug}-2`,
    });
    expect(fresh.status).toBe(202);
    expect((await settled(w.owner, q.id)).status).toBe("completed");
  });
});
