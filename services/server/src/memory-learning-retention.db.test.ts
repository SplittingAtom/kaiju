import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { purgeDeparted } from "./offboarding/purge.js";
import { runRetentionPass } from "./retention/index.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-651 (v1.3 SMB13; SM16, SM22, SM28): Phase B retention. The nightly pass expires open To
 * review candidates after 14 days (never as dismissals), pending Workspace proposals and readers'
 * project suggestions after 30 days (the proposer or reader is told once), and purges finished
 * learning passes with their candidates past the Workspace window. Held owners are skipped (a hold
 * on the person or on the Workspace); a Site-wide hold covers Site memories only. A purged
 * conversation takes its passes, candidates, dismissals, watermarks and suggestions; proposals keep
 * their own words. Offboarding erases what a departed person left in Phase B.
 */
let h: Harness;
const log = pino({ level: "silent" });
const ids = { owner: "", admin: "", alice: "", bob: "", carol: "", curator: "" };
let team = "";
let project = "";
let auditFloor = 0;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const pass = () => runRetentionPass({ db: h.deps.database.db, logger: log });
const offboardingCtx = () => ({
  db: h.deps.database.db,
  provider: () => undefined,
  blobs: undefined,
  log,
});

const msg = (role: string, text: string) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

async function thread(owner: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    id,
    owner,
  ]);
  await h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'u1', NULL, 'message', $3), ($1, $2, 'a1', 'u1', 'message', $4)`,
    [team, id, msg("user", "We deploy from main."), msg("assistant", "Noted.")],
  );
  return id;
}

/** A finished pass of `owner` on `threadId`, `finished` days ago. */
async function learningPass(owner: string, threadId: string, finished = 0): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at, created_at)
     VALUES ($1, $2, $3, 'a1', 'a1', 'learner', 'v1', 'completed', $4, $4, $4) RETURNING id`,
    [team, threadId, owner, ago(finished)],
  );
  return rows[0]?.id ?? "";
}

let ord = 0;
/** A candidate of a pass; `expires` days from now (negative: already past). */
async function candidate(passId: string, expires = 14, state = "open"): Promise<string> {
  const payload = {
    statement: `We deploy from main ${randomUUID().slice(0, 6)}`,
    kind: "fact",
    destination: "team",
    evidence: [{ entry_id: "u1", quote: "We deploy from main." }],
  };
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload, state, decided_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'open' THEN NULL ELSE now() END,
             now() + make_interval(days => $6)) RETURNING id`,
    [team, passId, ord++, JSON.stringify(payload), state, expires],
  );
  return rows[0]?.id ?? "";
}

async function proposal(proposer: string, expires: number, candidateRef?: string): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_proposals (team_id, source, candidate_ref, statement, kind, rationale,
       proposer_id, expires_at)
     VALUES ($1, 'candidate', $2, 'We deploy from main.', 'fact', 'Said so.', $3,
             now() + make_interval(days => $4)) RETURNING id`,
    [team, candidateRef ?? null, proposer, expires],
  );
  return rows[0]?.id ?? "";
}

async function suggestion(
  reader: string,
  threadId: string,
  expires: number,
  candidateRef?: string,
): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_project_suggestions (team_id, project_id, thread_id, candidate_ref,
       statement, kind, evidence, suggested_by, expires_at)
     VALUES ($1, $2, $3, $4, 'Use pnpm here.', 'convention',
             '[{"entry_id":"u1","quote":"We deploy from main."}]', $5,
             now() + make_interval(days => $6)) RETURNING id`,
    [team, project, threadId, candidateRef ?? null, reader, expires],
  );
  return rows[0]?.id ?? "";
}

const stateOf = async (table: string, id: string) =>
  (await h.admin.query<{ state: string }>(`SELECT state FROM ${table} WHERE id = $1`, [id])).rows[0]
    ?.state;
const exists = async (table: string, id: string) =>
  (await h.admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;
const countWhere = async (table: string, where: string, params: unknown[]) =>
  Number(
    (
      await h.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
        params,
      )
    ).rows[0]?.n,
  );
const notices = async (userId: string, objectId: string) =>
  (
    await h.admin.query<{ kind: string; project_id: string | null }>(
      `SELECT kind, project_id FROM notifications WHERE user_id = $1 AND memory_object_id = $2`,
      [userId, objectId],
    )
  ).rows;

async function audits(action: string) {
  const { rows } = await h.admin.query<{ target: Record<string, unknown> }>(
    `SELECT target FROM audit_log WHERE action = $1 AND seq > $2 ORDER BY seq`,
    [action, auditFloor],
  );
  return rows.map((r) => r.target);
}

async function setPeriod(period: string | null): Promise<void> {
  if (period === null) return void (await h.admin.query(`DELETE FROM team_retention`));
  await h.admin.query(
    `INSERT INTO team_retention (team_id, period, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (team_id) DO UPDATE SET period = EXCLUDED.period`,
    [team, period, ids.owner],
  );
}

async function placeHold(userId: string | null): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO legal_holds (team_id, user_id, reason, placed_by) VALUES ($1, $2, 'matter 651', $3)
     RETURNING id`,
    [team, userId, ids.admin],
  );
  await h.admin.query(`UPDATE legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`, [
    rows[0]?.id,
    ids.owner,
  ]);
}

async function placeSiteHold(): Promise<void> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO site_legal_holds (reason, placed_by) VALUES ('Site matter 651', $1) RETURNING id`,
    [ids.admin],
  );
  await h.admin.query(
    `UPDATE site_legal_holds SET status = 'active', approved_by = $2 WHERE id = $1`,
    [rows[0]?.id, ids.owner],
  );
}

async function clearHolds(): Promise<void> {
  for (const table of ["legal_holds", "site_legal_holds"]) {
    const { rows } = await h.admin.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE status = 'active'`,
    );
    for (const { id } of rows) {
      await h.admin.query(
        `UPDATE ${table} SET release_requested_by = $2, release_requested_at = now(),
           release_reason = 'matter closed' WHERE id = $1`,
        [id, ids.admin],
      );
      await h.admin.query(
        `UPDATE ${table} SET status = 'released', released_by = $2 WHERE id = $1`,
        [id, ids.owner],
      );
    }
  }
}

async function member(userId: string, on: boolean): Promise<void> {
  if (on)
    await h.admin.query(
      `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member') ON CONFLICT DO NOTHING`,
      [team, userId],
    );
  else
    await h.admin.query(`DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      team,
      userId,
    ]);
}

beforeAll(async () => {
  h = await openHarness();
  ids.owner = await h.createUser("owner@smlr.test", "owner");
  ids.admin = await h.createUser("admin@smlr.test", "admin");
  for (const who of ["alice", "bob", "carol", "curator"] as const)
    ids[who] = await h.createUser(`${who}@smlr.test`);
  team = randomUUID();
  project = randomUUID();
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'smlr', 'SMLR')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'team_admin'), ($1, $3, 'team_admin')`,
    [team, ids.owner, ids.curator],
  );
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'p651', 'P', $3)`,
    [team, project, ids.owner],
  );
}, 120_000);

afterAll(() => h?.close());

beforeEach(async () => {
  await clearHolds();
  await setPeriod(null);
  for (const who of ["alice", "bob", "carol"] as const) await member(ids[who], true);
  await h.admin.query(`DELETE FROM memory_proposals WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM memory_project_suggestions WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM threads WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM memory_reminders WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM notifications WHERE team_id = $1`, [team]);
  await h.admin.query(`DELETE FROM sandboxes WHERE team_id = $1`, [team]);
  auditFloor = Number(
    (await h.admin.query<{ n: string }>(`SELECT coalesce(max(seq), 0) AS n FROM audit_log`)).rows[0]
      ?.n,
  );
});

describe("candidate expiry (ac-1, ac-2)", () => {
  it("expires open candidates past 14 days, never as dismissals, and settles the pass reminder", async () => {
    const t = await thread(ids.alice);
    const p = await learningPass(ids.alice, t, 15);
    const due = await candidate(p, -1);
    const fresh = await candidate(p, 3);
    const saved = await candidate(p, -1, "saved");
    const p2 = await learningPass(ids.alice, t, 15);
    const lone = await candidate(p2, -1);
    for (const object of [p, p2])
      await h.admin.query(
        `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at)
         VALUES ($1, $2, NULL, $3, now() + interval '1 day')`,
        [team, object, ids.alice],
      );
    await pass();
    expect(await stateOf("memory_candidates", due)).toBe("expired");
    expect(await stateOf("memory_candidates", lone)).toBe("expired");
    expect(await stateOf("memory_candidates", fresh)).toBe("open");
    expect(await stateOf("memory_candidates", saved)).toBe("saved");
    expect(await countWhere("memory_dismissals", "team_id = $1", [team])).toBe(0);
    // p still has an open candidate: its reminder stays; p2 has none left.
    expect(await countWhere("memory_reminders", "object_id = $1", [p])).toBe(1);
    expect(await countWhere("memory_reminders", "object_id = $1", [p2])).toBe(0);
    const decided = await h.admin.query<{ decided_at: Date | null }>(
      `SELECT decided_at FROM memory_candidates WHERE id = $1`,
      [due],
    );
    expect(decided.rows[0]?.decided_at).not.toBeNull();
    expect(await audits("retention.memory_learning_purged")).toEqual([
      expect.objectContaining({ reason: "retention", candidatesExpired: 2 }),
    ]);
    // A second pass finds nothing more to do.
    await pass();
    expect(await audits("retention.memory_learning_purged")).toHaveLength(1);
  });

  it("skips a held person's candidates (a hold on them or on the Workspace), not under a Site-wide hold", async () => {
    const ta = await thread(ids.alice);
    const tb = await thread(ids.bob);
    const a = await candidate(await learningPass(ids.alice, ta), -1);
    const b = await candidate(await learningPass(ids.bob, tb), -1);
    await placeHold(ids.alice);
    await pass();
    expect(await stateOf("memory_candidates", a)).toBe("open");
    expect(await stateOf("memory_candidates", b)).toBe("expired");
    await clearHolds();
    const c = await candidate(await learningPass(ids.bob, tb), -1);
    await placeHold(null);
    await pass();
    expect(await stateOf("memory_candidates", a)).toBe("open");
    expect(await stateOf("memory_candidates", c)).toBe("open");
    await clearHolds();
    await placeSiteHold();
    await pass();
    expect(await stateOf("memory_candidates", a)).toBe("expired");
    expect(await stateOf("memory_candidates", c)).toBe("expired");
  });
});

describe("proposal expiry (ac-1, ac-2)", () => {
  it("expires pending proposals after 30 days, tells the proposer once and settles curators' reminders", async () => {
    const due = await proposal(ids.alice, -1);
    const fresh = await proposal(ids.alice, 5);
    await h.admin.query(
      `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, due_at)
       VALUES ($1, $2, 'memory.proposal.received', $3, now() + interval '1 day')`,
      [team, due, ids.curator],
    );
    await pass();
    expect(await stateOf("memory_proposals", due)).toBe("expired");
    expect(await stateOf("memory_proposals", fresh)).toBe("pending");
    const row = await h.admin.query<{ decided_at: Date | null; decided_by: string | null }>(
      `SELECT decided_at, decided_by FROM memory_proposals WHERE id = $1`,
      [due],
    );
    expect(row.rows[0]?.decided_at).not.toBeNull();
    expect(row.rows[0]?.decided_by).toBeNull();
    expect(await notices(ids.alice, due)).toEqual([
      { kind: "memory.proposal.expired", project_id: null },
    ]);
    expect(await countWhere("memory_reminders", "object_id = $1", [due])).toBe(0);
    await pass();
    expect(await notices(ids.alice, due)).toHaveLength(1);
  });

  it("keeps a held proposer's proposal pending until the hold is released", async () => {
    const held = await proposal(ids.alice, -1);
    await placeHold(ids.alice);
    await pass();
    expect(await stateOf("memory_proposals", held)).toBe("pending");
    expect(await notices(ids.alice, held)).toEqual([]);
    await clearHolds();
    await pass();
    expect(await stateOf("memory_proposals", held)).toBe("expired");
    expect(await notices(ids.alice, held)).toHaveLength(1);
  });
});

describe("suggestion expiry (ac-1, ac-2)", () => {
  it("expires readers' suggestions after 30 days and tells the reader once, with the project", async () => {
    const t = await thread(ids.bob);
    const due = await suggestion(ids.bob, t, -1);
    const fresh = await suggestion(ids.bob, t, 10);
    await h.admin.query(
      `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, project_id, due_at)
       VALUES ($1, $2, 'memory.suggestion.received', $3, $4, now() + interval '1 day')`,
      [team, due, ids.owner, project],
    );
    // Staled when its thread moved (KOBE-668): already closed, the sweep leaves it alone.
    const stale = await suggestion(ids.bob, t, -1);
    await h.admin.query(
      `UPDATE memory_project_suggestions SET state = 'stale', decided_at = $2 WHERE id = $1`,
      [stale, ago(5)],
    );
    await pass();
    expect(await stateOf("memory_project_suggestions", due)).toBe("expired");
    expect(await stateOf("memory_project_suggestions", fresh)).toBe("pending");
    expect(await stateOf("memory_project_suggestions", stale)).toBe("stale");
    expect(await notices(ids.bob, stale)).toEqual([]);
    expect(await notices(ids.bob, due)).toEqual([
      { kind: "memory.suggestion.expired", project_id: project },
    ]);
    expect(await countWhere("memory_reminders", "object_id = $1", [due])).toBe(0);
    await pass();
    expect(await notices(ids.bob, due)).toHaveLength(1);
  });

  it("skips a held reader's suggestion", async () => {
    const t = await thread(ids.bob);
    const held = await suggestion(ids.bob, t, -1);
    await placeHold(null);
    await pass();
    expect(await stateOf("memory_project_suggestions", held)).toBe("pending");
  });
});

describe("pass purge (ac-1)", () => {
  it("purges finished passes and their candidates past the Workspace window, nothing while forever", async () => {
    const t = await thread(ids.alice);
    const old = await learningPass(ids.alice, t, 40);
    const oldCandidate = await candidate(old, -26, "dismissed");
    const recent = await learningPass(ids.alice, t, 10);
    await pass();
    expect(await exists("memory_learning_passes", old)).toBe(true);
    await setPeriod("30d");
    await pass();
    expect(await exists("memory_learning_passes", old)).toBe(false);
    expect(await exists("memory_candidates", oldCandidate)).toBe(false);
    expect(await exists("memory_learning_passes", recent)).toBe(true);
    expect(await audits("retention.memory_learning_purged")).toEqual([
      expect.objectContaining({ reason: "retention", passes: 1, candidates: 1 }),
    ]);
  });

  it("keeps a pass whose candidate a pending proposal or suggestion still shows, and held people's passes", async () => {
    await setPeriod("30d");
    const t = await thread(ids.alice);
    const proposed = await learningPass(ids.alice, t, 40);
    const c1 = await candidate(proposed, -26, "proposed");
    await proposal(ids.alice, 5, c1);
    const suggested = await learningPass(ids.alice, t, 40);
    const c2 = await candidate(suggested, -26, "suggested");
    await suggestion(ids.alice, t, 5, c2);
    const tb = await thread(ids.bob);
    const held = await learningPass(ids.bob, tb, 40);
    await placeHold(ids.bob);
    await pass();
    for (const kept of [proposed, suggested, held])
      expect(await exists("memory_learning_passes", kept)).toBe(true);
  });
});

describe("decided proposals and suggestions (KOBE-671)", () => {
  /** Decide a pending row `days` ago; approved/rejected/dismissed carry a decider, expired none. */
  async function decide(
    table: "memory_proposals" | "memory_project_suggestions",
    id: string,
    state: string,
    decider: string | null,
    days: number,
  ): Promise<void> {
    await h.admin.query(
      `UPDATE ${table} SET state = $2, decided_by = $3, decided_at = $4 WHERE id = $1`,
      [id, state, decider, ago(days)],
    );
  }

  /** A proposal of an existing item (not from a pass). */
  async function itemProposal(proposer: string): Promise<string> {
    const { rows } = await h.admin.query<{ id: string }>(
      `INSERT INTO memory_proposals (team_id, source, statement, kind, proposer_id)
       VALUES ($1, 'item', 'Use pnpm.', 'convention', $2) RETURNING id`,
      [team, proposer],
    );
    return rows[0]?.id ?? "";
  }

  async function bell(object: string, kind: string, projectId: string | null): Promise<void> {
    await h.admin.query(
      `INSERT INTO notifications (team_id, user_id, kind, memory_object_id, project_id, actor_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [team, ids.alice, kind, object, projectId, ids.curator],
    );
  }

  const summed = async () => {
    const rows = await audits("retention.memory_learning_purged");
    const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    return { passes: sum("passes"), proposals: sum("proposals"), suggestions: sum("suggestions") };
  };

  it("purges decided ones with their pass past the window, and pass-less ones by decision date (ac-1)", async () => {
    await setPeriod("30d");
    const t = await thread(ids.alice);
    const old = await learningPass(ids.alice, t, 40);
    const approved = await proposal(ids.alice, 5, await candidate(old, -26, "proposed"));
    await decide("memory_proposals", approved, "approved", ids.curator, 5);
    const expired = await proposal(ids.alice, 5, await candidate(old, -26, "proposed"));
    await decide("memory_proposals", expired, "expired", null, 2);
    const dismissed = await suggestion(ids.alice, t, 5, await candidate(old, -26, "suggested"));
    await decide("memory_project_suggestions", dismissed, "dismissed", ids.owner, 3);
    await bell(approved, "memory.proposal.accepted", null);
    await bell(dismissed, "memory.suggestion.dismissed", project);
    // A recent pass keeps its decided proposal, however old the decision.
    const recent = await learningPass(ids.alice, t, 10);
    const keptWithPass = await proposal(ids.alice, 5, await candidate(recent, -1, "proposed"));
    await decide("memory_proposals", keptWithPass, "rejected", ids.curator, 9);
    // Not from a pass: counted from the decision date.
    const oldItem = await itemProposal(ids.alice);
    await decide("memory_proposals", oldItem, "rejected", ids.curator, 31);
    const newItem = await itemProposal(ids.alice);
    await decide("memory_proposals", newItem, "approved", ids.curator, 29);
    const pendingItem = await itemProposal(ids.alice);
    await h.admin.query(`UPDATE memory_proposals SET created_at = $2 WHERE id = $1`, [
      pendingItem,
      ago(40),
    ]);
    const oldLoose = await suggestion(ids.alice, t, 5);
    await decide("memory_project_suggestions", oldLoose, "approved", ids.owner, 45);
    const newLoose = await suggestion(ids.alice, t, 5);
    await decide("memory_project_suggestions", newLoose, "expired", null, 20);
    const pendingLoose = await suggestion(ids.alice, t, 5);
    // Staled ones (KOBE-668) are decided too: with their pass, or by decision date.
    const staleWithPass = await suggestion(ids.alice, t, 5, await candidate(old, -26, "suggested"));
    await decide("memory_project_suggestions", staleWithPass, "stale", null, 3);
    const oldStale = await suggestion(ids.alice, t, 5);
    await decide("memory_project_suggestions", oldStale, "stale", null, 45);
    const newStale = await suggestion(ids.alice, t, 5);
    await decide("memory_project_suggestions", newStale, "stale", null, 20);

    await pass();
    expect(await exists("memory_learning_passes", old)).toBe(false);
    for (const gone of [approved, expired, oldItem])
      expect(await exists("memory_proposals", gone)).toBe(false);
    for (const gone of [dismissed, oldLoose, staleWithPass, oldStale])
      expect(await exists("memory_project_suggestions", gone)).toBe(false);
    expect(
      await countWhere("notifications", "memory_object_id = ANY($1)", [[approved, dismissed]]),
    ).toBe(0);
    expect(await exists("memory_learning_passes", recent)).toBe(true);
    for (const kept of [keptWithPass, newItem, pendingItem])
      expect(await exists("memory_proposals", kept)).toBe(true);
    for (const kept of [newLoose, pendingLoose, newStale])
      expect(await exists("memory_project_suggestions", kept)).toBe(true);
    expect(await summed()).toEqual({ passes: 1, proposals: 3, suggestions: 4 });
    // Nothing more on a second run.
    const before = (await audits("retention.memory_learning_purged")).length;
    await pass();
    expect(await audits("retention.memory_learning_purged")).toHaveLength(before);
  });

  it("purges nothing while the Workspace keeps forever (ac-2)", async () => {
    const t = await thread(ids.alice);
    const old = await learningPass(ids.alice, t, 400);
    const prop = await proposal(ids.alice, 5, await candidate(old, -26, "proposed"));
    await decide("memory_proposals", prop, "approved", ids.curator, 390);
    const item = await itemProposal(ids.alice);
    await decide("memory_proposals", item, "rejected", ids.curator, 390);
    const loose = await suggestion(ids.alice, t, 5);
    await decide("memory_project_suggestions", loose, "dismissed", ids.owner, 390);
    await pass();
    expect(await exists("memory_learning_passes", old)).toBe(true);
    expect(await exists("memory_proposals", prop)).toBe(true);
    expect(await exists("memory_proposals", item)).toBe(true);
    expect(await exists("memory_project_suggestions", loose)).toBe(true);
  });

  it("keeps everything a held proposer, decider or reader is part of, with its pass (ac-2)", async () => {
    await setPeriod("30d");
    const ta = await thread(ids.alice);
    // Held proposer (Bob) on Alice's pass: the pass and the proposal stay.
    const byBob = await learningPass(ids.alice, ta, 40);
    const bobProp = await proposal(ids.bob, 5, await candidate(byBob, -26, "proposed"));
    await decide("memory_proposals", bobProp, "rejected", ids.curator, 35);
    const bobItem = await itemProposal(ids.bob);
    await decide("memory_proposals", bobItem, "approved", ids.curator, 35);
    // Held reader (Bob) on Alice's pass.
    const byReader = await learningPass(ids.alice, ta, 40);
    const bobSugg = await suggestion(ids.bob, ta, 5, await candidate(byReader, -26, "suggested"));
    await decide("memory_project_suggestions", bobSugg, "dismissed", ids.owner, 35);
    // Held decider (Carol) on Alice's proposals and suggestion.
    const byCarol = await learningPass(ids.alice, ta, 40);
    const carolProp = await proposal(ids.alice, 5, await candidate(byCarol, -26, "proposed"));
    await decide("memory_proposals", carolProp, "approved", ids.carol, 35);
    const carolItem = await itemProposal(ids.alice);
    await decide("memory_proposals", carolItem, "rejected", ids.carol, 35);
    const carolLoose = await suggestion(ids.alice, ta, 5);
    await decide("memory_project_suggestions", carolLoose, "approved", ids.carol, 35);
    // Nobody held: goes.
    const free = await itemProposal(ids.alice);
    await decide("memory_proposals", free, "rejected", ids.curator, 35);
    await placeHold(ids.bob);
    await placeHold(ids.carol);
    await pass();
    for (const kept of [byBob, byReader, byCarol])
      expect(await exists("memory_learning_passes", kept)).toBe(true);
    for (const kept of [bobProp, bobItem, carolProp, carolItem])
      expect(await exists("memory_proposals", kept)).toBe(true);
    for (const kept of [bobSugg, carolLoose])
      expect(await exists("memory_project_suggestions", kept)).toBe(true);
    expect(await exists("memory_proposals", free)).toBe(false);
    // A Workspace-wide hold keeps the rest; released, everything goes.
    await clearHolds();
    await placeHold(null);
    await pass();
    expect(await exists("memory_proposals", bobItem)).toBe(true);
    expect(await exists("memory_learning_passes", byBob)).toBe(true);
    await clearHolds();
    await pass();
    for (const gone of [byBob, byReader, byCarol])
      expect(await exists("memory_learning_passes", gone)).toBe(false);
    for (const gone of [bobProp, bobItem, carolProp, carolItem])
      expect(await exists("memory_proposals", gone)).toBe(false);
    for (const gone of [bobSugg, carolLoose])
      expect(await exists("memory_project_suggestions", gone)).toBe(false);
  });
});

describe("thread purge (ac-3, SM28)", () => {
  it("takes the conversation's passes, candidates, dismissals, watermarks and suggestions; proposals stay", async () => {
    const t = await thread(ids.alice);
    const other = await thread(ids.alice);
    const p = await learningPass(ids.alice, t);
    const c = await candidate(p, -1);
    const keptPass = await learningPass(ids.alice, other);
    const prop = await proposal(ids.alice, 5, c);
    const sugg = await suggestion(ids.alice, t, 5);
    await h.admin.query(
      `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash)
       VALUES ($1, $2, $3, repeat('a', 64)), ($1, $4, $3, repeat('b', 64))`,
      [team, t, ids.alice, other],
    );
    await h.admin.query(
      `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id)
       VALUES ($1, $2, $3, 'a1')`,
      [team, t, ids.alice],
    );
    await h.admin.query(
      `UPDATE threads SET deleted_at = now() - interval '31 days' WHERE team_id = $1 AND id = $2`,
      [team, t],
    );
    await pass();
    expect(await exists("threads", t)).toBe(false);
    expect(await exists("memory_learning_passes", p)).toBe(false);
    expect(await exists("memory_candidates", c)).toBe(false);
    expect(await exists("memory_project_suggestions", sugg)).toBe(false);
    expect(await countWhere("memory_dismissals", "thread_id = $1", [t])).toBe(0);
    expect(await countWhere("memory_learning_watermarks", "thread_id = $1", [t])).toBe(0);
    expect(await countWhere("memory_dismissals", "thread_id = $1", [other])).toBe(1);
    expect(await exists("memory_learning_passes", keptPass)).toBe(true);
    const kept = await h.admin.query<{ candidate_ref: string | null; statement: string }>(
      `SELECT candidate_ref, statement FROM memory_proposals WHERE id = $1`,
      [prop],
    );
    expect(kept.rows[0]).toEqual({ candidate_ref: null, statement: "We deploy from main." });
  });
});

describe("erasure on offboarding", () => {
  async function departed(userId: string): Promise<void> {
    await member(userId, false);
    await h.admin.query(
      `INSERT INTO sandboxes (team_id, user_id, sandbox_id, state, pvc, retain_until)
       VALUES ($1, $2, $3, 'destroyed', NULL, now() - interval '1 day')`,
      [team, userId, randomUUID()],
    );
  }

  async function seedPerson(userId: string) {
    const t = await thread(userId);
    const p = await learningPass(userId, t);
    const c = await candidate(p);
    const prop = await proposal(userId, 5, c);
    const approved = await proposal(userId, 5);
    await h.admin.query(
      `UPDATE memory_proposals SET state = 'approved', decided_by = $2, decided_at = now()
        WHERE id = $1`,
      [approved, ids.curator],
    );
    const sugg = await suggestion(userId, t, 5);
    await h.admin.query(
      `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash)
       VALUES ($1, $2, $3, repeat('c', 64))`,
      [team, t, userId],
    );
    await h.admin.query(
      `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id)
       VALUES ($1, $2, $3, 'a1')`,
      [team, t, userId],
    );
    for (const [object, kind] of [
      [prop, "memory.proposal.received"],
      [sugg, "memory.suggestion.received"],
    ] as const) {
      await h.admin.query(
        `INSERT INTO memory_reminders (team_id, object_id, related_kind, user_id, project_id, due_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '1 day')`,
        [team, object, kind, ids.curator, kind.includes("suggestion") ? project : null],
      );
      await h.admin.query(
        `INSERT INTO notifications (team_id, user_id, kind, memory_object_id, project_id, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [team, ids.curator, kind, object, kind.includes("suggestion") ? project : null, userId],
      );
    }
    return { t, p, c, prop, approved, sugg };
  }

  it("erases a departed person's passes, candidates, dismissals, watermarks, proposals and suggestions", async () => {
    const bob = await seedPerson(ids.bob);
    const alice = await seedPerson(ids.alice);
    // A Workspace memory a curator approved from Bob's proposal stays ("former member").
    const item = randomUUID();
    await h.admin.query(
      `WITH i AS (INSERT INTO semantic_memory_items (team_id, id, scope, kind, current_version)
                  VALUES ($1, $2, 'team', 'fact', 1))
       INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
       VALUES ($1, $2, 1, 'We deploy from main.', $3, 'user')`,
      [team, item, ids.curator],
    );
    await departed(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "deleted",
    );
    expect(await exists("memory_learning_passes", bob.p)).toBe(false);
    expect(await exists("memory_candidates", bob.c)).toBe(false);
    expect(await exists("memory_proposals", bob.prop)).toBe(false);
    expect(await exists("memory_proposals", bob.approved)).toBe(false);
    expect(await exists("memory_project_suggestions", bob.sugg)).toBe(false);
    expect(await countWhere("memory_dismissals", "user_id = $1", [ids.bob])).toBe(0);
    expect(await countWhere("memory_learning_watermarks", "user_id = $1", [ids.bob])).toBe(0);
    for (const object of [bob.prop, bob.sugg]) {
      expect(await countWhere("memory_reminders", "object_id = $1", [object])).toBe(0);
      expect(await countWhere("notifications", "memory_object_id = $1", [object])).toBe(0);
    }
    // The conversation is Workspace data (thread retention decides), and Alice's rows stay.
    expect(await exists("threads", bob.t)).toBe(true);
    expect(await exists("semantic_memory_items", item)).toBe(true);
    for (const [table, id] of [
      ["memory_learning_passes", alice.p],
      ["memory_candidates", alice.c],
      ["memory_proposals", alice.prop],
      ["memory_project_suggestions", alice.sugg],
    ] as const)
      expect(await exists(table, id)).toBe(true);
    expect(await countWhere("notifications", "memory_object_id = $1", [alice.prop])).toBe(1);
    expect(await audits("retention.memory_learning_purged")).toEqual([
      {
        reason: "offboarding",
        userId: ids.bob,
        candidatesExpired: 0,
        proposalsExpired: 0,
        suggestionsExpired: 0,
        passes: 1,
        candidates: 1,
        dismissals: 1,
        watermarks: 1,
        proposals: 2,
        suggestions: 1,
      },
    ]);
  });

  it("keeps everything under a hold and when the person came back", async () => {
    const bob = await seedPerson(ids.bob);
    await departed(ids.bob);
    await placeHold(ids.bob);
    await expect(purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob })).resolves.toBe(
      "held",
    );
    await clearHolds();
    await member(ids.bob, true);
    await purgeDeparted(offboardingCtx(), { teamId: team, userId: ids.bob });
    expect(await exists("memory_learning_passes", bob.p)).toBe(true);
    expect(await exists("memory_proposals", bob.prop)).toBe(true);
    expect(await exists("memory_project_suggestions", bob.sugg)).toBe(true);
  });
});
