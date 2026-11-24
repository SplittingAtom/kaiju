// Shared setup for the retention.*.db.test.ts files (split from retention.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { runWithAuditContext } from "../audit/context.js";
import { runRetentionPass, type BlobStore } from "./index.js";
import { createTeamWithAdmin } from "../teams/members.js";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";
import { MemoryObjects } from "../testing/memory-objects.js";

/**
 * KOBE-18 end to end: team retention settings within the site maximum, the nightly pass
 * (Trash purge, retention purge, run_events compaction, released blobs), legal hold suspending
 * every purge, "Delete forever", the user's export, and the offboarding entry point for KOBE-28.
 */
export let h: Harness;
export const objects = new MemoryObjects();
export const PREFIX = "kaiju/";
export const blobs: BlobStore = { objects, prefix: PREFIX };
export const log = pino({ level: "silent" });
export const ids = { owner: "", admin: "", alice: "", bob: "", carol: "" };
export let as: Record<"owner" | "alice" | "bob" | "carol", TestBrowser>;
export let team = "";
export let other = "";

export const DAY = 86_400_000;
export const ago = (days: number) => new Date(Date.now() - days * DAY);

export async function makeTeam(slug: string, adminId: string): Promise<string> {
  return (
    await runWithAuditContext(
      { actor: { kind: "user", id: adminId }, ip: null, userAgent: null },
      () => createTeamWithAdmin(h.deps.database.db, { slug, name: slug }, adminId),
    )
  ).id;
}

export async function member(teamId: string, userId: string, role = "member"): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [teamId, userId, role],
  );
}

export interface ThreadSpec {
  readonly teamId?: string;
  readonly owner: string;
  readonly title?: string;
  readonly activity?: Date;
  readonly deletedAt?: Date | null;
  /** Object keys stored as entry blob refs (and put into the bucket). */
  readonly blobKeys?: readonly string[];
  readonly entries?: number;
  /** Created as a fork of this thread at entry e1 (KOBE-215: the link is set at INSERT only). */
  readonly forkOf?: string;
}

/** A thread with a chain of user/assistant message entries (superuser fixture). */
export async function thread(spec: ThreadSpec): Promise<string> {
  const teamId = spec.teamId ?? team;
  const id = randomUUID();
  const keys = (spec.blobKeys ?? []).map((k) => {
    if (!k.startsWith("@")) return k;
    const real = `${PREFIX}teams/${teamId}/threads/${id}/${k.slice(1)}`;
    resolved.set(k.slice(1), real);
    return real;
  });
  await h.admin.query(
    `INSERT INTO threads (team_id, id, owner_user_id, title, forked_from_thread_id, forked_at_entry_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      teamId,
      id,
      spec.owner,
      spec.title ?? `t-${id.slice(0, 4)}`,
      spec.forkOf ?? null,
      spec.forkOf ? "e1" : null,
    ],
  );
  let parent: string | null = null;
  const n = spec.entries ?? 2;
  for (let i = 1; i <= n; i++) {
    const entryId = `e${i}`;
    const role = i % 2 === 1 ? "user" : "assistant";
    const content =
      role === "user"
        ? `question ${i} from ${spec.title ?? id}`
        : [{ type: "text", text: `answer ${i}` }];
    const payload = {
      type: "message",
      id: entryId,
      parentId: parent,
      timestamp: new Date().toISOString(),
      message: { role, content },
    };
    const blobKey = keys[i - 1] ?? null;
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, $3, $4, 'message', $5, $6)`,
      [teamId, id, entryId, parent, blobKey === null ? payload : {}, blobKey],
    );
    if (blobKey !== null) objects.objects.set(blobKey, Buffer.from(JSON.stringify(payload)));
    parent = entryId;
  }
  for (const k of keys.slice(n)) objects.objects.set(k, Buffer.from("x"));
  await h.admin.query(
    `UPDATE threads SET leaf_entry_id = $3, last_activity_at = $4, deleted_at = $5
      WHERE team_id = $1 AND id = $2`,
    [teamId, id, parent, spec.activity ?? new Date(), spec.deletedAt ?? null],
  );
  return id;
}

/** An ended run with `events` run events, ended `endedDaysAgo` ago. */
export async function endedRun(threadId: string, endedDaysAgo: number, events = 3, teamId = team) {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
     VALUES ($1, $2, 'user', 'completed', $3, $3) RETURNING id`,
    [teamId, threadId, ago(endedDaysAgo)],
  );
  const runId = rows[0]?.id ?? "";
  for (let i = 0; i < events; i++) {
    await h.admin.query(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1, $2, 'run.started', '{}')`,
      [teamId, runId],
    );
  }
  return runId;
}

/** `@name`: a key in the thread's own tree, resolved by `thread()`; `named(name)` reads it back. */
export const key = (name: string) => `@${name}`;
export const resolved = new Map<string, string>();
export const named = (name: string): string => {
  const k = resolved.get(name);
  if (k === undefined) throw new Error(`no blob named ${name}`);
  return k;
};

/** The fork links of `team`'s threads, by id. */
export async function forkLinks() {
  const { rows } = await h.admin.query(
    `SELECT team_id, forked_from_thread_id, forked_at_entry_id FROM threads
      WHERE team_id = $1 ORDER BY id`,
    [team],
  );
  return rows;
}

export async function threadIds(teamId = team): Promise<string[]> {
  const { rows } = await h.admin.query<{ id: string }>(
    `SELECT id FROM threads WHERE team_id = $1 ORDER BY id`,
    [teamId],
  );
  return rows.map((r) => r.id);
}

export async function audits(action: string, teamId: string | null = team) {
  const { rows } = await h.admin.query<{
    actor_kind: string;
    actor_id: string | null;
    target: Record<string, unknown>;
  }>(
    `SELECT actor_kind, actor_id, target FROM audit_log
      WHERE action = $1 AND team_id IS NOT DISTINCT FROM $2 ORDER BY seq`,
    [action, teamId],
  );
  return rows;
}

export async function placeHold(teamId: string, userId: string | null): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 18', $3)
     RETURNING id`,
    [teamId, userId, ids.admin],
  );
  const id = rows[0]?.id ?? "";
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    id,
    ids.owner,
  ]);
  return id;
}

export async function releaseHold(id: string): Promise<void> {
  await h.admin.query(
    `UPDATE legal_holds SET release_requested_by = $2, release_requested_at = now(),
       release_reason = 'matter closed' WHERE id = $1`,
    [id, ids.admin],
  );
  await h.admin.query(
    `UPDATE legal_holds SET status = 'released', released_by = $2 WHERE id = $1`,
    [id, ids.owner],
  );
}

/** A download with the browser's cookies, as raw bytes (the zip is binary). */
export async function download(b: TestBrowser, path: string) {
  const res = await h.app.request(`http://kaiju.test${path}`, {
    headers: {
      origin: "http://kaiju.test",
      "x-forwarded-for": b.ip,
      cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

export const pass = () => runRetentionPass({ db: h.deps.database.db, blobs, logger: log });

export async function setPeriod(teamId: string, period: string): Promise<void> {
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [teamId, period, ids.alice],
  );
}

/** Registers the shared hooks; call once at the top level of each retention.*.db.test.ts file. */
export function useRetentionHarness(): void {
  beforeAll(async () => {
    h = await openHarness({ blobs });
    ids.owner = await h.createUser("owner@ret.test", "owner");
    ids.admin = await h.createUser("admin@ret.test", "admin");
    ids.alice = await h.createUser("alice@ret.test");
    ids.bob = await h.createUser("bob@ret.test");
    ids.carol = await h.createUser("carol@ret.test");
    team = await makeTeam("finance", ids.alice);
    other = await makeTeam("legal", ids.alice);
    await member(team, ids.bob);
    await member(team, ids.carol);
    await member(other, ids.bob);
    as = {
      owner: await h.signIn("owner@ret.test"),
      alice: await h.signIn("alice@ret.test"),
      bob: await h.signIn("bob@ret.test"),
      carol: await h.signIn("carol@ret.test"),
    };
    for (const who of ["alice", "bob", "carol"] as const) {
      expect((await as[who].put("/v1/me/teams/active", { teamId: team })).status).toBe(200);
      as[who].team = team;
    }
  }, 120_000);

  afterAll(() => h?.close());

  /** Every test starts from empty teams (fixtures are created per test). */
  beforeEach(async () => {
    await h.admin.query(`DELETE FROM threads WHERE team_id IN ($1, $2)`, [team, other]);
    await h.admin.query(`DELETE FROM retention_blob_deletions`);
    await h.admin.query(`DELETE FROM team_retention`);
    await h.admin.query(`DELETE FROM site_settings WHERE key LIKE 'retention.%'`);
    objects.objects.clear();
    objects.deleted.length = 0;
    h.mailer.sent.length = 0;
  });

  /**
   * A tick whose lock connection failed releases it as broken: the pool closes the socket without
   * waiting, so the backend (and its session advisory lock) can outlive the tick by a moment. Wait
   * until none is held, so the next test never sees "busy" from a predecessor.
   */
  afterEach(async () => {
    await expect
      .poll(
        async () =>
          (
            await h.admin.query<{ n: string }>(
              `SELECT count(*) AS n FROM pg_locks
               WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`,
            )
          ).rows[0]?.n,
        { timeout: 10_000 },
      )
      .toBe("0");
  });
}
