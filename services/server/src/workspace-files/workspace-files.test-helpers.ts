// Shared setup for the workspace-files.*.db.test.ts files
// (split from workspace-files.db.test.ts, KOBE-725).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { withTeam } from "@kaiju/db";
import { createApp } from "../app.js";
import { EventStreamFixture, PUBLIC_URL, type Person } from "../testing/event-stream-fixture.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { RawBody, TestBrowser } from "../testing/browser.js";
import {
  createWorkspaceSync,
  workspaceBlobKey,
  type WorkspaceSync,
} from "../workspace-sync/index.js";

/**
 * Workspace file browser API (KOBE-148) against a real Postgres: listing from the synced
 * manifest, downloads, uploads, deletes, the wake, and that everything stays inside the caller's
 * own (team, user) workspace.
 */
export const fx = new EventStreamFixture();
export const objects = new MemoryObjects();
export const silent = { error: () => {}, warn: () => {}, info: () => {} };
export const LIMITS = {
  maxFileBytes: 1024 * 1024,
  maxWorkspaceBytes: 4 * 1024 * 1024,
  maxFiles: 50,
};
export const woken: { teamId: string; userId: string }[] = [];
export let sync: WorkspaceSync;
export let app: ReturnType<typeof createApp>;

export interface World {
  readonly team: string;
  readonly alice: Person;
  readonly bob: Person;
  readonly a: TestBrowser;
  readonly b: TestBrowser;
}

/** A browser on the app with the workspace routes, signed in as `p` (same session cookie). */
export function browserFor(p: Person, team: string): TestBrowser {
  const b = new TestBrowser(app, PUBLIC_URL);
  for (const [k, v] of p.browser.cookies) b.cookies.set(k, v);
  b.team = team;
  return b;
}

export async function world(): Promise<World> {
  const alice = await fx.person("alice");
  const bob = await fx.person("bob");
  const team = await fx.team(`w-${randomBytes(3).toString("hex")}`, alice, [bob]);
  return { team, alice, bob, a: browserFor(alice, team), b: browserFor(bob, team) };
}

export const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** Seeds a synced file the way a sandbox push or a server write would leave it. */
export async function seed(
  w: World,
  who: Person,
  path: string,
  content: string,
  area: "user" | "uploads" | "projects" = "user",
): Promise<void> {
  const data = Buffer.from(content);
  const owner = { teamId: w.team, userId: who.id };
  const hash = sha(data);
  const key =
    area === "user" ? workspaceBlobKey("", owner, hash) : `teams/${w.team}/${area}/${randomUUID()}`;
  objects.objects.set(key, data);
  await withTeam(fx.db, w.team, (tx) =>
    sync.putServerFile(tx, owner, { path, sha256: hash, size: data.length, blobKey: key }, area),
  );
}

export function multipart(fields: Record<string, string>, file?: { name: string; data: string }) {
  const boundary = `----kaiju${randomBytes(6).toString("hex")}`;
  let body = "";
  for (const [k, v] of Object.entries(fields)) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  if (file) {
    body +=
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n${file.data}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  const bytes = Buffer.from(body);
  return {
    raw: new RawBody(bytes, `multipart/form-data; boundary=${boundary}`),
    headers: { "content-length": String(bytes.length) },
  };
}

export function upload(b: TestBrowser, folder: string | undefined, name: string, data: string) {
  const m = multipart(folder === undefined ? {} : { path: folder }, { name, data });
  return b.request("POST", "/v1/workspace/files", m.raw, m.headers);
}

export async function auditRows(team: string, action: string) {
  const { rows } = await fx.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE team_id = $1 AND action = $2 ORDER BY seq`,
    [team, action],
  );
  return rows.map((r) => r.target);
}

/** An app whose listing pages hold two entries, so paging is visible with a few files. */
export function pagedBrowser(w: World): TestBrowser {
  const paged = createApp(fx.replica(0).deps, {
    workspaceFiles: { sync, waker: { wake: () => Promise.resolve() }, listPageSize: 2 },
  });
  const b = new TestBrowser(paged, PUBLIC_URL);
  for (const [k, v] of w.alice.browser.cookies) b.cookies.set(k, v);
  b.team = w.team;
  return b;
}

/**
 * Registers the shared hooks; call once at the top level of each
 * workspace-files.*.db.test.ts file.
 */
export function useWorkspaceFilesWorld(): void {
  beforeAll(async () => {
    await fx.setup([{}]);
    sync = createWorkspaceSync({ db: fx.db, objects, prefix: "", limits: LIMITS, log: silent });
    app = createApp(fx.replica(0).deps, {
      workspaceFiles: {
        sync,
        waker: {
          wake: (target) => {
            woken.push(target);
            return Promise.resolve();
          },
        },
      },
    });
  });

  afterAll(() => fx.teardown());
}
