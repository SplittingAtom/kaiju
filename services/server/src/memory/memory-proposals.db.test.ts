import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTeam } from "@kobe/db";
import { buildRunSemantic } from "./items/run-memory.js";
import { statementHash } from "./learn/validate.js";
import { sweepMemoryReminders } from "../notifications/memory.js";
import type { TestBrowser } from "../testing/browser.js";
import { must } from "../testing/event-stream-fixture.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-397 (SMB9; SM22): Workspace proposals over Postgres. A member who doesn't curate proposes a
 * To review candidate (in their own words) to the curators; curators (Team admins + stewards)
 * approve (as the curator, through the item store: in every member's next run), request changes
 * (back in To review, the clock kept) or dismiss with a reason; nobody decides their own; curators
 * save directly (audited). Notices, the 7-day reminder, the digest and one-click re-propose run on
 * KOBE-645's machinery. Nothing crosses Workspaces.
 */
let h: Harness;
const team = randomUUID();
const otherTeam = randomUUID();
const ids = { admin: "", steward: "", member: "", other: "", outsider: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const REVIEW = "/v1/memory/review";
const PROPOSALS = "/v1/memory/proposals";
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
const codeOf = (r: { status: number; json: unknown }) => [
  r.status,
  (r.json as { code?: unknown }).code,
];

beforeAll(async () => {
  h = await openHarness();
  for (const who of Object.keys(ids) as (keyof typeof ids)[])
    ids[who] = await h.createUser(`${who}@mp.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'mp-a', 'A'), ($2, 'mp-b', 'B')`,
    [team, otherTeam],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'),
       ($6, $7, 'team_admin')`,
    [team, ids.admin, ids.steward, ids.member, ids.other, otherTeam, ids.outsider],
  );
  await h.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [team, ids.steward, ids.admin],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@mp.test`);
    const active = who === "outsider" ? otherTeam : team;
    await as[who].put("/v1/me/teams/active", { teamId: active });
    as[who].team = active;
  }
});

afterAll(async () => {
  await h?.close();
});

const msg = (role: string, text: string) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

/** A thread of `owner` with a candidate the pass found in it; returns both ids. */
async function seed(
  owner: string,
  over: { statement?: string; source?: string; destination?: string } = {},
): Promise<{ threadId: string; passId: string; candidateId: string; statement: string }> {
  const threadId = randomUUID();
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    owner,
  ]);
  await h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'u1', NULL, 'message', $3), ($1, $2, 'a1', 'u1', 'message', $4)`,
    [team, threadId, msg("user", "We deploy from main."), msg("assistant", "Noted.")],
  );
  const { rows: p } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at)
     VALUES ($1, $2, $3, 'a1', 'a1', 'learner', 'v1', 'completed', now(), now()) RETURNING id`,
    [team, threadId, owner],
  );
  const passId = must(p[0], "pass").id;
  const statement = over.statement ?? unique("We deploy from main");
  const payload = {
    statement,
    kind: "fact",
    destination: over.destination ?? "team",
    suggested_scope: "team",
    portable: false,
    project_specific: false,
    source: over.source ?? "stated",
    operation: "add",
    target_id: null,
    confidence: 0.9,
    rationale: "The person said so.",
    evidence: [{ entry_id: "u1", quote: "We deploy from main." }],
    statement_hash: statementHash(statement),
    warnings: [],
    policy_conflicts: [],
    near_duplicates: [],
    prompt_version: "v1",
  };
  const { rows: c } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, 0, $3)
     RETURNING id`,
    [team, passId, JSON.stringify(payload)],
  );
  return { threadId, passId, candidateId: must(c[0], "candidate").id, statement };
}

const propose = (who: TestBrowser, candidateId: string, body: object = {}) =>
  who.post(`${REVIEW}/candidates/${candidateId}/propose`, body);
const proposalIdOf = (r: { json: unknown }) => (r.json as { proposal_id: string }).proposal_id;
const row = async (id: string) =>
  must(
    (
      await h.admin.query<{
        state: string;
        statement: string;
        rationale: string | null;
        reason: string | null;
        decided_by: string | null;
        expires_at: Date;
      }>(`SELECT * FROM memory_proposals WHERE id = $1`, [id])
    ).rows[0],
    "proposal",
  );
const notices = async (userId: string, objectId: string) =>
  (
    await h.admin.query<{
      kind: string;
      related_kind: string | null;
      actor_user_id: string | null;
    }>(
      `SELECT kind, related_kind, actor_user_id FROM notifications
        WHERE user_id = $1 AND memory_object_id = $2 ORDER BY created_at`,
      [userId, objectId],
    )
  ).rows;
const reminders = async (objectId: string) =>
  (
    await h.admin.query<{ user_id: string }>(
      `SELECT user_id FROM memory_reminders WHERE object_id = $1 ORDER BY user_id`,
      [objectId],
    )
  ).rows.map((r) => r.user_id);
const auditOf = async (action: string, proposalId: string) =>
  (
    await h.admin.query<{ actor_id: string | null; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log WHERE action = $1 AND target ->> 'proposalId' = $2`,
      [action, proposalId],
    )
  ).rows;

describe("propose (a member who doesn't curate)", () => {
  it("sends an edited candidate with a note to the curators, who are told and owed a reminder", async () => {
    const s = await seed(ids.member);
    const edited = unique("We deploy from the main branch");
    const r = await propose(as.member, s.candidateId, {
      statement: edited,
      rationale: "Everyone asks this.",
    });
    expect(r.status).toBe(201);
    const id = proposalIdOf(r);
    expect(await row(id)).toMatchObject({
      state: "pending",
      statement: edited,
      rationale: "Everyone asks this.",
    });
    const cand = await h.admin.query<{ state: string; payload: { proposal_id?: string } }>(
      `SELECT state, payload FROM memory_candidates WHERE id = $1`,
      [s.candidateId],
    );
    expect(cand.rows[0]).toMatchObject({ state: "proposed", payload: { proposal_id: id } });
    for (const curator of [ids.admin, ids.steward])
      expect(await notices(curator, id)).toEqual([
        { kind: "memory.proposal.received", related_kind: null, actor_user_id: ids.member },
      ]);
    expect(await notices(ids.member, id)).toEqual([]);
    expect(await reminders(id)).toEqual([ids.admin, ids.steward].sort());
    expect((await auditOf("memory.proposal.created", id))[0]?.target).toMatchObject({
      candidateId: s.candidateId,
      edited: true,
      repropose: false,
    });
    // Gone from To review.
    const list = await as.member.get(`${REVIEW}?thread_id=${s.threadId}`);
    expect((list.json as { candidates: unknown[] }).candidates).toEqual([]);
  });

  it("refuses what isn't in the person's own words, secrets, and other people's candidates", async () => {
    const inferred = await seed(ids.member, { source: "inferred", destination: "user" });
    expect(codeOf(await propose(as.member, inferred.candidateId))).toEqual([
      400,
      "invalid_request",
    ]);
    const s = await seed(ids.member);
    expect(
      codeOf(
        await propose(as.member, s.candidateId, {
          statement: "The deploy key is AKIAIOSFODNN7EXAMPLE",
        }),
      ),
    ).toEqual([422, "memory_secret"]);
    expect(codeOf(await propose(as.other, s.candidateId))).toEqual([404, "memory_item_not_found"]);
  });

  it("curators save their own candidates directly, audited with the author; they don't propose", async () => {
    const s = await seed(ids.steward);
    expect(codeOf(await propose(as.steward, s.candidateId))).toEqual([400, "invalid_request"]);
    const saved = await as.steward.post(`${REVIEW}/candidates/${s.candidateId}/save`, {});
    expect(saved.status).toBe(200);
    const { rows } = await h.admin.query<{ actor_id: string; target: Record<string, unknown> }>(
      `SELECT actor_id, target FROM audit_log
        WHERE action = 'memory.candidate.accepted' AND target ->> 'candidateId' = $1`,
      [s.candidateId],
    );
    expect(rows[0]).toMatchObject({ actor_id: ids.steward, target: { scope: "team" } });
  });
});

describe("the curators' queue and decisions", () => {
  it("shows curators the statement, proposer, note, quotes and conversation; members get 403", async () => {
    const s = await seed(ids.member);
    const id = proposalIdOf(await propose(as.member, s.candidateId, { rationale: "Why." }));
    const r = await as.admin.get(PROPOSALS);
    expect(r.status).toBe(200);
    const card = (r.json as { proposals: Record<string, unknown>[] }).proposals.find(
      (p) => p.id === id,
    );
    expect(card).toMatchObject({
      statement: s.statement,
      kind: "fact",
      rationale: "Why.",
      state: "pending",
      proposer: { id: ids.member, name: expect.any(String) as string },
      thread_id: s.threadId,
      evidence: [{ entry_id: "u1", quote: "We deploy from main." }],
      policy_conflicts: [],
    });
    expect(codeOf(await as.member.get(PROPOSALS))).toEqual([403, "memory_not_allowed"]);
  });

  it("stays inside its Workspace: another Workspace's admin neither sees nor decides it", async () => {
    const s = await seed(ids.member);
    const id = proposalIdOf(await propose(as.member, s.candidateId));
    const r = await as.outsider.get(PROPOSALS);
    expect((r.json as { proposals: { id: string }[] }).proposals.map((p) => p.id)).not.toContain(
      id,
    );
    expect(codeOf(await as.outsider.post(`${PROPOSALS}/${id}/approve`, {}))).toEqual([
      404,
      "memory_item_not_found",
    ]);
  });

  it("refuses self-approval, even once the proposer curates (ac-2)", async () => {
    const s = await seed(ids.other);
    const id = proposalIdOf(await propose(as.other, s.candidateId));
    expect(codeOf(await as.other.post(`${PROPOSALS}/${id}/approve`, {}))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    await h.admin.query(
      `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
      [team, ids.other, ids.admin],
    );
    try {
      expect(codeOf(await as.other.post(`${PROPOSALS}/${id}/approve`, {}))).toEqual([
        403,
        "memory_not_allowed",
      ]);
      expect(
        codeOf(await as.other.post(`${PROPOSALS}/${id}/dismiss`, { reason: "Mine." })),
      ).toEqual([403, "memory_not_allowed"]);
    } finally {
      await h.admin.query(`DELETE FROM memory_stewards WHERE team_id = $1 AND user_id = $2`, [
        team,
        ids.other,
      ]);
    }
    expect((await row(id)).state).toBe("pending");
  });

  it("approves (edited) as the curator: in every member's next run; the proposer hears (ac-1)", async () => {
    const word = `quokka${randomUUID().slice(0, 6)}`;
    const s = await seed(ids.member, { statement: `Releases are named ${word} style` });
    const id = proposalIdOf(await propose(as.member, s.candidateId));
    const edited = `Releases are named in ${word} style`;
    const r = await as.steward.post(`${PROPOSALS}/${id}/approve`, { statement: edited });
    expect(r.status).toBe(200);
    const item = (r.json as { item: { id: string; scope: string; statement: string } }).item;
    expect(item).toMatchObject({ scope: "team", statement: edited });
    expect(await row(id)).toMatchObject({ state: "approved", decided_by: ids.steward });
    const v = await h.admin.query<{ actor_kind: string }>(
      `SELECT actor_kind FROM semantic_memory_item_versions WHERE item_id = $1`,
      [item.id],
    );
    expect(v.rows[0]?.actor_kind).toBe("user");
    expect(await notices(ids.member, id)).toEqual([
      { kind: "memory.proposal.accepted", related_kind: null, actor_user_id: ids.steward },
    ]);
    expect(await reminders(id)).toEqual([]);
    expect((await auditOf("memory.proposal.accepted", id))[0]).toMatchObject({
      actor_id: ids.steward,
      target: { itemId: item.id, edited: true, proposerId: ids.member },
    });
    // Every member's next run: another member's run picks it.
    const t = await seed(ids.other);
    const semantic = await withTeam(h.deps.database.db, team, (tx) =>
      buildRunSemantic(tx, {
        teamId: team,
        userId: ids.other,
        threadId: t.threadId,
        runId: randomUUID(),
        message: `What style are releases named in? ${word}`,
      }),
    );
    expect(semantic?.semantic.items.map((i) => i.id)).toContain(item.id);
    // Decided: no second decision.
    expect(codeOf(await as.admin.post(`${PROPOSALS}/${id}/approve`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
  });

  it("dismisses with a reason (required); the proposer reads it in their proposals", async () => {
    const s = await seed(ids.member);
    const id = proposalIdOf(await propose(as.member, s.candidateId));
    expect(codeOf(await as.admin.post(`${PROPOSALS}/${id}/dismiss`, {}))).toEqual([
      400,
      "invalid_request",
    ]);
    const r = await as.admin.post(`${PROPOSALS}/${id}/dismiss`, { reason: "Not true here." });
    expect(r.status).toBe(200);
    expect(await row(id)).toMatchObject({ state: "rejected", reason: "Not true here." });
    expect(await notices(ids.member, id)).toEqual([
      { kind: "memory.proposal.dismissed", related_kind: null, actor_user_id: ids.admin },
    ]);
    const mine = (await as.member.get(`${PROPOSALS}/mine`)).json as {
      proposals: Record<string, unknown>[];
    };
    expect(mine.proposals.find((p) => p.id === id)).toMatchObject({
      state: "rejected",
      reason: "Not true here.",
      back_in_review: false,
      may_repropose: false,
    });
  });

  it("request changes: back in To review; proposing again keeps the clock", async () => {
    const s = await seed(ids.member);
    const first = proposalIdOf(await propose(as.member, s.candidateId));
    await h.admin.query(
      `UPDATE memory_proposals SET expires_at = now() + interval '20 days' WHERE id = $1`,
      [first],
    );
    const clock = (await row(first)).expires_at;
    const r = await as.admin.post(`${PROPOSALS}/${first}/request-changes`, {
      reason: "Say which repository.",
    });
    expect(r.json).toMatchObject({ back_in_review: true });
    expect(await notices(ids.member, first)).toEqual([
      { kind: "memory.proposal.changes_requested", related_kind: null, actor_user_id: ids.admin },
    ]);
    const list = await as.member.get(`${REVIEW}?thread_id=${s.threadId}`);
    expect((list.json as { candidates: { id: string }[] }).candidates.map((c) => c.id)).toEqual([
      s.candidateId,
    ]);
    const mine = (await as.member.get(`${PROPOSALS}/mine`)).json as {
      proposals: Record<string, unknown>[];
    };
    expect(mine.proposals.find((p) => p.id === first)).toMatchObject({ back_in_review: true });
    const again = await propose(as.member, s.candidateId, {
      statement: `${s.statement} (the kobe repository)`,
    });
    expect(again.status).toBe(201);
    const second = proposalIdOf(again);
    expect((await row(second)).expires_at.toISOString()).toBe(clock.toISOString());
    expect((await auditOf("memory.proposal.created", second))[0]?.target).toMatchObject({
      repropose: true,
      previousId: first,
    });
  });
});

describe("expiry, reminder and digest on the shared machinery (ac-3)", () => {
  it("an expired proposal can't be decided and is proposed again with one click, on a new clock", async () => {
    const s = await seed(ids.member);
    const id = proposalIdOf(await propose(as.member, s.candidateId));
    await h.admin.query(
      `UPDATE memory_proposals SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect(codeOf(await as.admin.post(`${PROPOSALS}/${id}/approve`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
    const mine = (await as.member.get(`${PROPOSALS}/mine`)).json as {
      proposals: Record<string, unknown>[];
    };
    expect(mine.proposals.find((p) => p.id === id)).toMatchObject({
      state: "expired",
      may_repropose: true,
    });
    expect(codeOf(await as.other.post(`${PROPOSALS}/${id}/repropose`, {}))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    const r = await as.member.post(`${PROPOSALS}/${id}/repropose`, {});
    expect(r.status).toBe(201);
    const next = proposalIdOf(r);
    expect((await row(id)).state).toBe("expired");
    const fresh = await row(next);
    expect(fresh.state).toBe("pending");
    expect(fresh.expires_at.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    expect(await reminders(next)).toEqual([ids.admin, ids.steward].sort());
    expect(codeOf(await as.member.post(`${PROPOSALS}/${next}/repropose`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
  });

  it("reminds each curator after 7 days, and drops a reminder whose curator lost the right", async () => {
    await h.admin.query(
      `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
      [team, ids.other, ids.admin],
    );
    const s = await seed(ids.member);
    const id = proposalIdOf(await propose(as.member, s.candidateId));
    expect(await reminders(id)).toEqual([ids.admin, ids.other, ids.steward].sort());
    await h.admin.query(`DELETE FROM memory_stewards WHERE team_id = $1 AND user_id = $2`, [
      team,
      ids.other,
    ]);
    await h.admin.query(
      `UPDATE memory_reminders SET due_at = now() - interval '1 minute' WHERE object_id = $1`,
      [id],
    );
    await sweepMemoryReminders(h.deps.database.db);
    for (const curator of [ids.admin, ids.steward])
      expect(
        (await notices(curator, id)).filter((n) => n.kind === "memory.review.reminder"),
      ).toEqual([
        {
          kind: "memory.review.reminder",
          related_kind: "memory.proposal.received",
          actor_user_id: null,
        },
      ]);
    expect((await notices(ids.other, id)).map((n) => n.kind)).not.toContain(
      "memory.review.reminder",
    );
    expect(await reminders(id)).not.toContain(ids.other);
  });

  it("rolls a curator's sixth proposal notice within the hour into the digest", async () => {
    await h.admin.query(
      `DELETE FROM notifications WHERE user_id = $1 AND kind IN ('memory.proposal.received', 'memory.review.digest')`,
      [ids.admin],
    );
    for (let i = 0; i < 6; i += 1) {
      const s = await seed(ids.member);
      expect((await propose(as.member, s.candidateId)).status).toBe(201);
    }
    const { rows } = await h.admin.query<{ kind: string; item_count: number | null }>(
      `SELECT kind, item_count FROM notifications
        WHERE user_id = $1 AND kind IN ('memory.proposal.received', 'memory.review.digest')`,
      [ids.admin],
    );
    expect(rows.filter((r) => r.kind === "memory.proposal.received")).toHaveLength(5);
    expect(rows.filter((r) => r.kind === "memory.review.digest")).toEqual([
      { kind: "memory.review.digest", item_count: 1 },
    ]);
  });
});
