import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-411 (SMD4; SM22, SM30): memory quality computed on read. Per item: runs received, last
 * received, thumbs-down runs; flags "check this" (> 30% down over ≥ 10 runs) and unused (not
 * received for the Site's `unused_after_days`, default 90). Queue health (pending, oldest, median
 * time to decision) and Learn's pass signals for curators; the Site sees sums across Workspaces,
 * numbers only. Nothing is archived by a flag.
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const ids = { admin: "", member: "", siteAdmin: "", adminB: "" };
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const item = { check: "", fine: "", never: "", old: "", mine: "", site: "" };
const threads: Record<string, string> = {};

const q = (text: string, params: unknown[] = []) => h.admin.query(text, params);

/** Runs `fn` in one transaction (an item and its first version: the version key is deferred). */
async function tx<T>(fn: () => Promise<T>): Promise<T> {
  await q("BEGIN");
  try {
    const out = await fn();
    await q("COMMIT");
    return out;
  } catch (err) {
    await q("ROLLBACK");
    throw err;
  }
}

const teamItem = (team: string, statement: string, ageDays: number, owner?: string) =>
  tx(() => insertTeamItem(team, statement, ageDays, owner));

async function insertTeamItem(team: string, statement: string, ageDays: number, owner?: string) {
  const { rows } = await q(
    `INSERT INTO semantic_memory_items (team_id, scope, owner_user_id, kind, created_at, updated_at)
     VALUES ($1, $2, $3, 'fact', now() - make_interval(days => $4::int), now() - make_interval(days => $4::int))
     RETURNING id`,
    [team, owner ? "user" : "team", owner ?? null, ageDays],
  );
  const id = (rows[0] as { id: string }).id;
  await q(
    `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
     VALUES ($1, $2, 1, $3, $4, 'user')`,
    [team, id, statement, ids.admin],
  );
  return id;
}

/** `n` runs in `team` that received `itemId` `daysAgo` ago; the first `down` get a thumbs down. */
async function received(
  team: string,
  table: "run_memory_items" | "run_site_memory_items",
  itemId: string,
  n: number,
  down: number,
  daysAgo: number,
  rater: string,
) {
  for (let k = 0; k < n; k++) {
    const { rows } = await q(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
       VALUES ($1, $2, 'user', 'completed', now(), now()) RETURNING id`,
      [team, threads[team]],
    );
    const runId = (rows[0] as { id: string }).id;
    await q(
      `INSERT INTO ${table} (team_id, run_id, item_id, version, created_at)
       VALUES ($1, $2, $3, 1, now() - make_interval(days => $4::int))`,
      [team, runId, itemId, daysAgo],
    );
    if (k < down)
      await q(
        `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating)
         VALUES ($1, $2, $3, $4, 'down')`,
        [team, threads[team], runId, rater],
      );
  }
}

beforeAll(async () => {
  h = await openHarness();
  for (const who of Object.keys(ids) as Who[])
    ids[who] = await h.createUser(`${who}@q.test`, who === "siteAdmin" ? "admin" : undefined);
  await q(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'qa', 'Quality A'), ($2, 'qb', 'Quality B')`,
    [teamA, teamB],
  );
  await q(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'member'), ($4, $5, 'team_admin')`,
    [teamA, ids.admin, ids.member, teamB, ids.adminB],
  );
  for (const [team, owner] of [
    [teamA, ids.member],
    [teamB, ids.adminB],
  ] as const) {
    const { rows } = await q(
      `INSERT INTO threads (team_id, owner_user_id) VALUES ($1, $2) RETURNING id`,
      [team, owner],
    );
    threads[team] = (rows[0] as { id: string }).id;
  }
  item.check = await teamItem(teamA, "Check me", 200);
  item.fine = await teamItem(teamA, "Fine", 200);
  item.never = await teamItem(teamA, "Never received", 100);
  item.old = await teamItem(teamA, "Old", 200);
  item.mine = await teamItem(teamA, "Mine", 5, ids.member);
  await teamItem(teamB, "Other workspace", 200);
  await received(teamA, "run_memory_items", item.check, 10, 4, 1, ids.member);
  await received(teamA, "run_memory_items", item.fine, 10, 3, 2, ids.member);
  await received(teamA, "run_memory_items", item.old, 2, 0, 95, ids.member);
  await received(teamA, "run_memory_items", item.mine, 2, 1, 3, ids.member);
  // A second thumbs down on a run already rated down counts the run once.
  await q(
    `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating)
     SELECT f.team_id, f.thread_id, f.run_id, $2, 'down' FROM answer_feedback f
       JOIN run_memory_items r ON r.team_id = f.team_id AND r.run_id = f.run_id
      WHERE r.item_id = $1 LIMIT 1`,
    [item.check, ids.admin],
  );
  // A Site item: 6 runs with 3 down in A, 6 with 2 down in B: only the sum (12, 5) flags it.
  await tx(async () => {
    const { rows: s } = await q(
      `INSERT INTO site_memory_items (kind, created_at) VALUES ('fact', now() - interval '200 days') RETURNING id`,
    );
    item.site = (s[0] as { id: string }).id;
    await q(
      `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
       VALUES ($1, 1, 'Site fact', $2, 'user')`,
      [item.site, ids.siteAdmin],
    );
  });
  await received(teamA, "run_site_memory_items", item.site, 6, 3, 4, ids.member);
  await received(teamB, "run_site_memory_items", item.site, 6, 2, 50, ids.adminB);

  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(`${who}@q.test`);
    if (who === "siteAdmin") continue;
    const team = who === "adminB" ? teamB : teamA;
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

type Signals = {
  id: string;
  runs: number;
  down_runs: number;
  last_received_at: string | null;
  flags: { check_this: boolean; unused: boolean };
};
type ItemsBody = {
  counts: { all: number; check_this: number; unused: number };
  thresholds: { unused_after_days: number; check_min_runs: number };
  items: Signals[];
};
const byId = (body: ItemsBody, id: string) => body.items.find((i) => i.id === id);

describe("item signals and flags (ac-1)", () => {
  it("counts runs, thumbs-down runs and last received per Workspace item", async () => {
    const r = await as.admin.get("/v1/memory/quality/items?scope=team");
    expect(r.status).toBe(200);
    const body = r.json as ItemsBody;
    expect(body.thresholds).toMatchObject({ unused_after_days: 90, check_min_runs: 10 });
    expect(body.counts).toEqual({ all: 4, check_this: 1, unused: 2 });
    expect(byId(body, item.check)).toMatchObject({
      runs: 10,
      down_runs: 4,
      flags: { check_this: true, unused: false },
    });
    expect(byId(body, item.fine)).toMatchObject({
      runs: 10,
      down_runs: 3,
      flags: { check_this: false, unused: false },
    });
    expect(byId(body, item.never)).toMatchObject({
      runs: 0,
      last_received_at: null,
      flags: { unused: true },
    });
    expect(byId(body, item.old)).toMatchObject({
      runs: 2,
      flags: { unused: true, check_this: false },
    });
    // Flagged first; the other Workspace's and personal items never appear.
    expect(body.items[0]?.id).toBe(item.check);
    expect(byId(body, item.mine)).toBeUndefined();
  });

  it("filters by flag", async () => {
    const check = (await as.admin.get("/v1/memory/quality/items?scope=team&filter=check_this"))
      .json as ItemsBody;
    expect(check.items.map((i) => i.id)).toEqual([item.check]);
    const unused = (await as.admin.get("/v1/memory/quality/items?scope=team&filter=unused"))
      .json as ItemsBody;
    expect(unused.items.map((i) => i.id).sort()).toEqual([item.never, item.old].sort());
    expect((await as.admin.get("/v1/memory/quality/items?filter=nope")).status).toBe(400);
  });

  it("a member sees their own items only, never the Workspace's", async () => {
    const own = (await as.member.get("/v1/memory/quality/items?scope=user")).json as ItemsBody;
    expect(own.items.map((i) => i.id)).toEqual([item.mine]);
    expect(own.items[0]).toMatchObject({ runs: 2, down_runs: 1 });
    expect((await as.member.get("/v1/memory/quality/items?scope=team")).status).toBe(403);
  });

  it("sums a Site item's runs over every Workspace, for Site curators only", async () => {
    const r = await as.siteAdmin.get("/v1/site/memory/quality/items");
    expect(r.status).toBe(200);
    const s = byId(r.json as ItemsBody, item.site);
    expect(s).toMatchObject({ runs: 12, down_runs: 5, flags: { check_this: true, unused: false } });
    expect(Object.keys(s ?? {}).sort()).toEqual(
      [
        "down_runs",
        "flags",
        "id",
        "kind",
        "last_received_at",
        "pinned",
        "policy",
        "runs",
        "statement",
      ].sort(),
    );
    expect((await as.admin.get("/v1/site/memory/quality/items")).status).toBe(403);
  });

  it("follows the Site's unused_after_days and archives nothing", async () => {
    const put = await as.siteAdmin.put("/v1/memory/settings?level=site", {
      settings: { unused_after_days: 120 },
    });
    expect(put.status).toBe(200);
    const body = (await as.admin.get("/v1/memory/quality/items?scope=team")).json as ItemsBody;
    expect(body.thresholds.unused_after_days).toBe(120);
    expect(byId(body, item.old)?.flags.unused).toBe(false);
    expect(byId(body, item.never)?.flags.unused).toBe(false);
    const { rows } = await q(
      `SELECT target FROM audit_log WHERE action = 'memory.site_settings_changed' ORDER BY seq DESC LIMIT 1`,
    );
    expect((rows[0] as { target: { settings?: string[] } }).target.settings).toEqual([
      "unused_after_days",
    ]);
    await as.siteAdmin.put("/v1/memory/settings?level=site", {
      settings: { unused_after_days: 90 },
    });
    const { rows: st } = await q(
      `SELECT count(*)::int AS n FROM semantic_memory_items WHERE team_id = $1 AND status <> 'active'`,
      [teamA],
    );
    expect((st[0] as { n: number }).n).toBe(0);
  });
});

describe("queue health (ac-2)", () => {
  it("Workspace: pending, oldest pending and median time to decision", async () => {
    const ins = (
      state: string,
      createdH: number,
      decidedH: number | null,
      decider: string | null,
    ) =>
      q(
        `INSERT INTO memory_proposals (team_id, source, statement, kind, state, proposer_id,
           decided_by, decided_at, created_at)
         VALUES ($1, 'item', 'S', 'fact', $2, $3, $4,
           CASE WHEN $5::int IS NULL THEN NULL ELSE now() - make_interval(hours => $5::int) END,
           now() - make_interval(hours => $6::int))`,
        [teamA, state, ids.member, decider, decidedH, createdH],
      );
    await ins("pending", 72, null, null);
    await ins("pending", 24, null, null);
    await ins("approved", 34, 24, ids.admin); // 10 h
    await ins("rejected", 54, 24, ids.admin); // 30 h
    await ins("expired", 800, 24, null); // expiry: not a decision
    await ins("approved", 1100, 1000, ids.admin); // outside the 30 days
    const r = await as.admin.get("/v1/memory/quality/queues");
    expect(r.status).toBe(200);
    const body = r.json as {
      window_days: number;
      queues: {
        queue: string;
        pending: number;
        oldest_pending_at: string;
        decided: number;
        median_decision_seconds: number;
      }[];
    };
    expect(body.window_days).toBe(30);
    const wp = body.queues.find((x) => x.queue === "workspace_proposals");
    expect(wp).toMatchObject({ pending: 2, decided: 2, median_decision_seconds: 20 * 3600 });
    const ageH = (Date.now() - new Date(wp?.oldest_pending_at ?? 0).getTime()) / 3_600_000;
    expect(Math.round(ageH)).toBe(72);
    expect(body.queues.find((x) => x.queue === "project_suggestions")).toMatchObject({
      pending: 0,
      decided: 0,
      median_decision_seconds: null,
    });
    expect((await as.member.get("/v1/memory/quality/queues")).status).toBe(403);
  });

  it("Site: confirmed proposals waiting, timed from the confirmation", async () => {
    const ins = (state: string, confirmedH: number | null, decidedH: number | null) =>
      q(
        `INSERT INTO site_memory_proposals (from_team_id, statement, kind, justification, state,
           proposer_id, team_confirmed_by, team_confirmed_at, decided_by, decided_at, created_at)
         VALUES ($1, 'S', 'fact', 'J', $2, $3, CASE WHEN $4::int IS NULL THEN NULL ELSE $5::uuid END,
           CASE WHEN $4::int IS NULL THEN NULL ELSE now() - make_interval(hours => $4::int) END,
           CASE WHEN $6::int IS NULL THEN NULL ELSE $7::uuid END,
           CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(hours => $6::int) END,
           now() - interval '10 days')`,
        [teamA, state, ids.member, confirmedH, ids.admin, decidedH, ids.siteAdmin],
      );
    await ins("awaiting_site", 48, null);
    await ins("awaiting_team", null, null);
    await ins("approved", 5, 4); // 1 h
    await ins("rejected", 7, 4); // 3 h
    const r = await as.siteAdmin.get("/v1/site/memory/quality/queues");
    expect(r.status).toBe(200);
    const sq = (r.json as { queues: Record<string, unknown>[] }).queues[0];
    expect(sq).toMatchObject({
      queue: "site_proposals",
      pending: 1,
      decided: 2,
      median_decision_seconds: 7200,
    });
    expect((await as.admin.get("/v1/site/memory/quality/queues")).status).toBe(403);
  });
});

describe("pass signals (ac-3)", () => {
  async function pass(
    team: string,
    owner: string,
    status: "completed" | "failed",
    finishedDays: number,
  ) {
    const { rows } = await q(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, NULL, 'message', '{"message":{"role":"user","content":[]}}')
       RETURNING entry_id`,
      [team, threads[team], `e-${randomUUID().slice(0, 8)}`],
    );
    const entry = (rows[0] as { entry_id: string }).entry_id;
    const { rows: p } = await q(
      `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
         to_entry_id, model_alias, prompt_version, status, error, started_at, finished_at, created_at)
       VALUES ($1, $2, $3, $4, CASE WHEN $5 = 'completed' THEN $4 END, 'learner', 'v1', $5,
         CASE WHEN $5 = 'failed' THEN 'x: failed' END,
         now() - make_interval(days => $6::int), now() - make_interval(days => $6::int),
         now() - make_interval(days => $6::int))
       RETURNING id`,
      [team, threads[team], owner, entry, status, finishedDays],
    );
    return (p[0] as { id: string }).id;
  }
  async function candidates(team: string, passId: string, states: string[]) {
    for (const [ord, state] of states.entries())
      await q(
        `INSERT INTO memory_candidates (team_id, pass_id, ord, payload, state, decided_at)
         VALUES ($1, $2, $3, '{"statement":"secret thread text"}', $4, CASE WHEN $4 = 'open' THEN NULL ELSE now() END)`,
        [team, passId, ord, state],
      );
  }

  it("Workspace curators see shown, saved, proposed, dismissed and edited before save", async () => {
    const p1 = await pass(teamA, ids.member, "completed", 2);
    await candidates(teamA, p1, ["saved", "saved", "proposed", "dismissed", "open"]);
    await pass(teamA, ids.member, "failed", 3);
    const old = await pass(teamA, ids.member, "completed", 40);
    await candidates(teamA, old, ["saved"]);
    for (const edited of [true, false])
      await q(
        `INSERT INTO audit_log (actor_kind, actor_id, action, team_id, target)
         VALUES ('user', $1, 'memory.candidate.accepted', $2, $3)`,
        [ids.member, teamA, JSON.stringify({ candidateId: randomUUID(), passId: p1, edited })],
      );
    const r = await as.admin.get("/v1/memory/quality/passes");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      window_days: 30,
      signals: {
        passes: 2,
        failed: 1,
        shown: 5,
        saved: 2,
        proposed: 1,
        suggested: 0,
        dismissed: 1,
        expired: 0,
        open: 1,
        edited_before_save: 1,
      },
    });
    expect((await as.member.get("/v1/memory/quality/passes")).status).toBe(403);
  });

  it("the Site sees numbers per Workspace and their sum, no thread text", async () => {
    const pb = await pass(teamB, ids.adminB, "completed", 1);
    await candidates(teamB, pb, ["dismissed", "saved"]);
    const r = await as.siteAdmin.get("/v1/site/memory/quality/passes");
    expect(r.status).toBe(200);
    const body = r.json as {
      totals: Record<string, number>;
      workspaces: ({ team_id: string; name: string } & Record<string, number>)[];
    };
    expect(body.totals).toMatchObject({ passes: 3, shown: 7, saved: 3, dismissed: 2 });
    expect(body.workspaces.map((w) => w.team_id)).toEqual([teamA, teamB]);
    expect(JSON.stringify(body)).not.toContain("secret thread text");
    expect((await as.admin.get("/v1/site/memory/quality/passes")).status).toBe(403);
  });
});

describe("performance (seeded)", () => {
  it("answers the Workspace item signals at 1,000 items and 20,000 run records", async () => {
    const perf = randomUUID();
    await q(`INSERT INTO teams (id, slug, name) VALUES ($1, 'qperf', 'Perf')`, [perf]);
    await q(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin')`, [
      perf,
      ids.admin,
    ]);
    const { rows: t } = await q(
      `INSERT INTO threads (team_id, owner_user_id) VALUES ($1, $2) RETURNING id`,
      [perf, ids.admin],
    );
    const thread = (t[0] as { id: string }).id;
    await q("BEGIN");
    await q(
      `INSERT INTO semantic_memory_items (team_id, scope, kind)
       SELECT $1, 'team', 'fact' FROM generate_series(1, 1000)`,
      [perf],
    );
    await q(
      `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
       SELECT team_id, id, 1, 'Item ' || id, $2, 'user' FROM semantic_memory_items WHERE team_id = $1`,
      [perf, ids.admin],
    );
    await q("COMMIT");
    await q(
      `INSERT INTO runs (team_id, thread_id, trigger, status, started_at, ended_at)
       SELECT $1, $2, 'user', 'completed', now(), now() FROM generate_series(1, 2000)`,
      [perf, thread],
    );
    // Each run received 10 items (20,000 records); every fifth run got a thumbs down.
    await q(
      `INSERT INTO run_memory_items (team_id, run_id, item_id, version, created_at)
       SELECT $1, r.id, i.id, 1, now() - (r.n % 120) * interval '1 day'
         FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM runs WHERE team_id = $1) r
         JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM semantic_memory_items WHERE team_id = $1) i
           ON i.n BETWEEN ((r.n * 10) % 1000) + 1 AND ((r.n * 10) % 1000) + 10`,
      [perf],
    );
    await q(
      `INSERT INTO answer_feedback (team_id, thread_id, run_id, user_id, rating)
       SELECT $1, $2, id, $3, 'down' FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM runs WHERE team_id = $1) r
        WHERE r.n % 5 = 0`,
      [perf, thread, ids.admin],
    );
    await q("ANALYZE");
    const admin = await h.signIn("admin@q.test");
    await admin.put("/v1/me/teams/active", { teamId: perf });
    admin.team = perf;
    const times: number[] = [];
    for (let k = 0; k < 20; k++) {
      const t0 = performance.now();
      const r = await admin.get("/v1/memory/quality/items?scope=team");
      times.push(performance.now() - t0);
      expect(r.status).toBe(200);
      expect((r.json as ItemsBody).counts.all).toBe(1000);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1] ?? 0;
    console.log(`KOBE-411 item signals p95 ${p95.toFixed(1)} ms (1,000 items, 20,000 records)`);
    // ~65 ms on the shared dev VM (KOBE-411 ledger); generous for loaded CI.
    expect(p95).toBeLessThan(500);
  });
});
