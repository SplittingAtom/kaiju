import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, beforeEach, expect } from "vitest";
import { withTestLoopback } from "@kobe/address-policy/testing";
import { GIT_SITE_ENABLED_KEY, loadEnvelope, withTeam, type Envelope } from "@kobe/db";
import { gitConversionViewSchema, type GitConversionView } from "@kobe/protocol";
import { rawRequest } from "../connectors/oauth/http.js";
import { conversionDeps } from "../git/conversion/deps.js";
import type { ConversionDeps } from "../git/conversion/runner.js";
import { GitHostError } from "../git-hosts/adapter.js";
import type { GitWireSend } from "../git-hosts/git-wire.js";
import { projectBlobKey, writeCommit, type TreeFile } from "../projects/tree.js";
import { EventStreamFixture, type Person } from "./event-stream-fixture.js";
import { FakeGitea } from "./fake-gitea.js";
import { startGitServer, type GitServer } from "./git-http-server.js";
import { MemoryObjects } from "./memory-objects.js";
import type { MemoryMailer } from "./mailer.js";

/**
 * The shared world of the KOBE-765 (Convert to repo) db suites: one throwaway database per
 * importing file, a Forgejo fake for the API, a real `git http-backend` (with
 * `receive.fsckObjects`) for the pushes, an in-memory object store, and helpers for people,
 * connections, projects with commits, attempts and the host's repositories.
 */
export const must = <T>(v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error("expected a value");
  return v;
};
export const short = () => randomUUID().slice(0, 8);
export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const PREFIX = "kobe/";

export const fx = new EventStreamFixture();
export const forgejo = new FakeGitea("forgejo");
export const objects = new MemoryObjects();
export let git: GitServer;
export let gitPort: number;
export let envelope: Envelope;
/** Wire hooks for one test: runs before each smart-HTTP exchange is sent. */
let wireHook: ((url: URL, method: string) => void) | undefined;
/** Sets (or clears) the hook run before each smart-HTTP exchange is sent. */
export function setWireHook(hook: ((url: URL, method: string) => void) | undefined): void {
  wireHook = hook;
}

/** Smart-HTTP after the checks: to the local git server (the fake host's name stays in the URL). */
export const wire: GitWireSend = (exchange) => {
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
          "content-length": String(
            exchange.file?.size ?? exchange.body.reduce((n, c) => n + c.length, 0),
          ),
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
    if (exchange.file) {
      createReadStream(exchange.file.path).pipe(req);
      return;
    }
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

export const unreachable = () =>
  new GitHostError("host_unreachable", "The git host could not be reached.");
export const deps = (): ConversionDeps => ({
  ...conversionDeps(fx.replica(0).deps),
  batchBytes: 1,
});
export const mailer = () => fx.replica(0).deps.mailer as MemoryMailer;

export interface World {
  readonly team: string;
  readonly admin: Person;
  readonly owner: Person;
  readonly member: Person;
  readonly connectionId: string;
}

export async function world(level: "read" | "read_write" = "read_write"): Promise<World> {
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

/** A project owned by `owner` with commits written as Kaiju writes them (blobs in the store). */
export async function project(
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

export const start = (p: Person, projectId: string, body: Record<string, unknown>) =>
  p.browser.request("POST", `/v1/projects/${projectId}/repo-conversion`, body);

export async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
}

export async function settled(p: Person, projectId: string): Promise<GitConversionView> {
  for (let i = 0; i < 200; i += 1) {
    const res = await p.browser.request("GET", `/v1/projects/${projectId}/repo-conversion`);
    expect(res.status, res.text).toBe(200);
    const view = gitConversionViewSchema.parse(res.json.conversion);
    if (view.status !== "running") return view;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("the conversion did not settle");
}

export const bare = (repo: string, args: string[]) => git.git(repo, args, { bare: true });
export function hostRepo(name: string) {
  git.repo(`acme/${name}`);
  bare(`acme/${name}`, ["config", "receive.fsckObjects", "true"]);
}

export async function audit(team: string) {
  const { rows } = await fx.admin.query<{ action: string; target: Record<string, unknown> }>(
    `SELECT action, target FROM audit_log WHERE team_id = $1 AND action LIKE 'git.project.%' ORDER BY seq`,
    [team],
  );
  return rows;
}

/** An active hold on one member of the team (any hold in the team holds its projects). */
export async function placeHold(teamId: string, userId: string): Promise<string> {
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

export async function kind(team: string, projectId: string): Promise<string> {
  const { rows } = await fx.admin.query<{ kind: string }>(
    `SELECT kind FROM projects WHERE team_id = $1 AND id = $2`,
    [team, projectId],
  );
  return must(rows[0]).kind;
}
