import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { semanticMemoryErrorSchema } from "@kobe/protocol";
import { withTeam } from "@kobe/db";
import { noticeCandidatesReady } from "./review/notify.js";
import { statementHash } from "./learn/validate.js";
import type { TestBrowser } from "../testing/browser.js";
import { must } from "../testing/event-stream-fixture.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-396 (SMB8; SM16): To review over Postgres. Candidates are seeded as a pass stores them;
 * every decision goes through `/v1/memory/review` and is re-checked at click: author only, open
 * and unexpired, allowed scopes (inferred stays personal; a Workspace save quotes the person),
 * the item store's switches, rights, checks and Policy conflicts. Save all mine is one batch with
 * one Undo; dismissals use the pass's statement hash; expiry adds no dismissal; a later pass
 * adds to the open set; the bell notice and reminder follow the candidates.
 */
let h: Harness;
const team = randomUUID();
const ids = { site: "", admin: "", member: "", other: "" };
const as = {} as Record<keyof typeof ids, TestBrowser>;
const REVIEW = "/v1/memory/review";
const ITEMS = "/v1/memory/semantic/items";
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
/** Status and code; `invalid_request` is the item store's own code beside the contract's. */
const codeOf = (r: { status: number; json: unknown }) => {
  const code = (r.json as { code?: unknown }).code;
  if (code !== "invalid_request") semanticMemoryErrorSchema.parse(r.json);
  return [r.status, code];
};

beforeAll(async () => {
  h = await openHarness();
  ids.site = await h.createUser("site@tr.test", "admin");
  for (const who of ["admin", "member", "other"] as const)
    ids[who] = await h.createUser(`${who}@tr.test`);
  await h.admin.query(`INSERT INTO teams (id, slug, name) VALUES ($1, 'tr-a', 'A')`, [team]);
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'member'), ($1, $3, 'team_admin'), ($1, $4, 'member'), ($1, $5, 'member')`,
    [team, ids.site, ids.admin, ids.member, ids.other],
  );
  for (const who of Object.keys(ids) as (keyof typeof ids)[]) {
    as[who] = await h.signIn(`${who}@tr.test`);
    await as[who].put("/v1/me/teams/active", { teamId: team });
    as[who].team = team;
  }
});

afterAll(async () => {
  await h?.close();
});

const msg = (role: string, text: string) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

/** A thread of `owner`: u1 (person), a1 (assistant), u2 (person, the leaf). */
async function thread(owner: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    id,
    owner,
  ]);
  for (const [entry, parent, role, text] of [
    ["u1", null, "user", "We ship on Tuesdays."],
    ["a1", "u1", "assistant", "Tuesdays it is."],
    ["u2", "a1", "user", "Thanks."],
  ] as const)
    await h.admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
       VALUES ($1, $2, $3, $4, 'message', $5)`,
      [team, id, entry, parent, msg(role, text)],
    );
  return id;
}

async function pass(threadId: string, owner: string, minutesAgo = 0): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at, created_at, usage)
     VALUES ($1, $2, $3, 'u2', 'u2', 'learner', 'v1', 'completed',
             now() - make_interval(mins => $4), now() - make_interval(mins => $4),
             now() - make_interval(mins => $4), $5)
     RETURNING id`,
    [
      team,
      threadId,
      owner,
      minutesAgo,
      JSON.stringify({ skill_hints: [{ title: "Release checklist", summary: "Steps." }] }),
    ],
  );
  return must(rows[0], "pass").id;
}

interface Seed {
  statement?: string;
  kind?: string;
  destination?: string;
  source?: string;
  operation?: string;
  target_id?: string | null;
  target_version?: number;
  evidence?: { entry_id: string; quote: string }[];
  near_duplicates?: { id: string; version: number }[];
}

let ord = 0;
async function candidate(passId: string, seed: Seed = {}): Promise<string> {
  const statement = seed.statement ?? unique("We ship on Tuesdays");
  const destination = seed.destination ?? "user";
  const payload = {
    statement,
    kind: seed.kind ?? "fact",
    destination,
    suggested_scope: destination === "team" || destination === "project_notes" ? "team" : "user",
    portable: destination === "portable",
    project_specific: destination === "project_notes",
    source: seed.source ?? "stated",
    operation: seed.operation ?? "add",
    target_id: seed.target_id ?? null,
    ...(seed.target_version === undefined ? {} : { target_version: seed.target_version }),
    confidence: 0.9,
    rationale: "The person said so.",
    evidence: seed.evidence ?? [{ entry_id: "u1", quote: "We ship on Tuesdays." }],
    statement_hash: statementHash(statement),
    warnings: [],
    policy_conflicts: [],
    near_duplicates: seed.near_duplicates ?? [],
    prompt_version: "v1",
  };
  ord += 1;
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [team, passId, ord, JSON.stringify(payload)],
  );
  return must(rows[0], "candidate").id;
}

const list = async (who: TestBrowser, threadId: string) =>
  who.get(`${REVIEW}?thread_id=${threadId}`);
const cards = async (who: TestBrowser, threadId: string) =>
  ((await list(who, threadId)).json as { candidates: { id: string; statement: string }[] })
    .candidates;
const save = (who: TestBrowser, id: string, body: object = {}) =>
  who.post(`${REVIEW}/candidates/${id}/save`, body);
const stateOf = async (id: string) =>
  (
    await h.admin.query<{ state: string; payload: Record<string, unknown> }>(
      `SELECT state, payload FROM memory_candidates WHERE id = $1`,
      [id],
    )
  ).rows[0];
const audits = async (action: string) =>
  (
    await h.admin.query<{ target: Record<string, unknown> }>(
      `SELECT target FROM audit_log WHERE action = $1 ORDER BY seq`,
      [action],
    )
  ).rows.map((r) => r.target);

describe("the list (ac-3: merge and expiry)", () => {
  it("shows the author's open candidates, newest pass first, merged once by statement", async () => {
    const t = await thread(ids.member);
    const older = await pass(t, ids.member, 10);
    const newer = await pass(t, ids.member, 1);
    const same = unique("Coffee at nine");
    const a = await candidate(older, { statement: same });
    const b = await candidate(newer, { source: "inferred" });
    // A later pass that raced the same statement in: shown once (the newest copy).
    const dup = await candidate(newer, { statement: same.toUpperCase() });
    const expired = await candidate(older);
    await h.admin.query(
      `UPDATE memory_candidates SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [expired],
    );
    const r = await list(as.member, t);
    expect(r.status).toBe(200);
    const body = r.json as {
      can_curate_workspace: boolean;
      candidates: { id: string; allowed_scopes: string[]; scope_locked: boolean }[];
      skill_hints: unknown[];
    };
    expect(body.candidates.map((c) => c.id)).toEqual([b, dup]);
    expect(body.candidates.map((c) => c.id)).not.toContain(a);
    expect(body.candidates[0]).toMatchObject({ allowed_scopes: ["user"], scope_locked: true });
    expect(body.can_curate_workspace).toBe(false);
    expect(body.skill_hints).toEqual([{ title: "Release checklist", summary: "Steps." }]);
  });

  it("is the author's alone: another member gets 404 and cannot decide", async () => {
    const t = await thread(ids.member);
    const c = await candidate(await pass(t, ids.member));
    expect((await list(as.other, t)).status).toBe(404);
    expect(codeOf(await save(as.other, c))).toEqual([404, "memory_item_not_found"]);
    expect(codeOf(await as.other.post(`${REVIEW}/candidates/${c}/dismiss`, {}))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    expect((await stateOf(c))?.state).toBe("open");
  });

  it("an expired candidate can't be saved or dismissed and is not a dismissal", async () => {
    const t = await thread(ids.member);
    const c = await candidate(await pass(t, ids.member));
    await h.admin.query(
      `UPDATE memory_candidates SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [c],
    );
    expect(codeOf(await save(as.member, c))).toEqual([409, "memory_item_inactive"]);
    expect(codeOf(await as.member.post(`${REVIEW}/candidates/${c}/dismiss`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
    const d = await h.admin.query(`SELECT 1 FROM memory_dismissals WHERE thread_id = $1`, [t]);
    expect(d.rows).toHaveLength(0);
  });
});

describe("card actions (ac-2)", () => {
  it("saves through the item store with the thread link, once, audited", async () => {
    const t = await thread(ids.member);
    const c = await candidate(await pass(t, ids.member), { statement: unique("Ship Tuesdays") });
    const r = await save(as.member, c);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const item = (r.json as { item: { id: string; scope: string; versions: unknown[] } }).item;
    expect(item.scope).toBe("user");
    const got = await as.member.get(`${ITEMS}/user/${item.id}`);
    expect(got.json).toMatchObject({
      versions: [{ source_thread_id: t, source_entry_ids: ["u1"], actor_kind: "user" }],
    });
    expect((await stateOf(c))?.state).toBe("saved");
    expect(codeOf(await save(as.member, c))).toEqual([409, "memory_item_inactive"]);
    expect(await audits("memory.candidate.accepted")).toContainEqual(
      expect.objectContaining({ candidateId: c, itemId: item.id, edited: false, batch: false }),
    );
  });

  it("saves an edited statement and kind; portable needs a preference and a confirmation", async () => {
    const t = await thread(ids.member);
    const c = await candidate(await pass(t, ids.member));
    expect(codeOf(await save(as.member, c, { scope: "portable", confirm_portable: true }))).toEqual(
      [400, "invalid_request"],
    );
    expect(codeOf(await save(as.member, c, { scope: "portable", kind: "preference" }))).toEqual([
      400,
      "invalid_request",
    ]);
    const statement = unique("I like short answers");
    const r = await save(as.member, c, {
      statement,
      kind: "preference",
      scope: "portable",
      confirm_portable: true,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { item: object }).item).toMatchObject({ scope: "portable", statement });
    expect(await audits("memory.candidate.accepted")).toContainEqual(
      expect.objectContaining({ candidateId: c, scope: "portable", edited: true }),
    );
  });

  it("keeps inferred candidates personal and Workspace saves to quoted, curated ones", async () => {
    const t = await thread(ids.admin);
    const p = await pass(t, ids.admin);
    const inferred = await candidate(p, { source: "inferred" });
    expect(codeOf(await save(as.admin, inferred, { scope: "team" }))).toEqual([
      400,
      "invalid_request",
    ]);
    const assistantOnly = await candidate(p, {
      destination: "team",
      evidence: [{ entry_id: "a1", quote: "Tuesdays it is." }],
    });
    expect(codeOf(await save(as.admin, assistantOnly))).toEqual([403, "memory_not_allowed"]);
    const quoted = await candidate(p, { destination: "team" });
    const r = await save(as.admin, quoted);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { item: object }).item).toMatchObject({ scope: "team" });
    // A member who doesn't curate: the store refuses the Workspace save (Propose is KOBE-397).
    const mt = await thread(ids.member);
    const mine = await candidate(await pass(mt, ids.member), { destination: "team" });
    expect(codeOf(await save(as.member, mine))).toEqual([403, "memory_not_allowed"]);
    expect((await stateOf(mine))?.state).toBe("open");
  });

  it("blocks a Policy conflict until Save anyway, and an update adds a version", async () => {
    const policy = await as.site.post(ITEMS, {
      scope: "site",
      kind: "fact",
      statement: "Never deploy to production on Fridays.",
      policy: true,
    });
    expect(policy.status, JSON.stringify(policy.json)).toBe(201);
    const t = await thread(ids.member);
    const p = await pass(t, ids.member);
    const c = await candidate(p, { statement: "We deploy to production on Fridays after lunch." });
    const shown = (await list(as.member, t)).json as {
      candidates: { id: string; policy_conflicts: unknown[] }[];
    };
    expect(shown.candidates.find((x) => x.id === c)).toBeDefined();
    expect(codeOf(await save(as.member, c))).toEqual([409, "memory_policy_conflict"]);
    expect((await stateOf(c))?.state).toBe("open");
    const r = await save(as.member, c, { overrides: { policy_conflict: true } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);

    const existing = await as.member.post(ITEMS, {
      scope: "user",
      kind: "fact",
      statement: unique("Standup at ten"),
    });
    const target = (existing.json as { id: string }).id;
    const upd = await candidate(p, {
      operation: "update",
      target_id: target,
      statement: unique("Standup at half past ten"),
    });
    const card = (
      (await list(as.member, t)).json as {
        candidates: { id: string; target: { id: string } | null; scope_locked: boolean }[];
      }
    ).candidates.find((x) => x.id === upd);
    expect(card).toMatchObject({ target: { id: target }, scope_locked: true });
    const u = await save(as.member, upd);
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect((u.json as { item: object }).item).toMatchObject({ id: target, version: 2 });
    // Undo of an update reverts to the version before it.
    const undo = await as.member.post(`${REVIEW}/undo`, { candidate_ids: [upd] });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    const after = await as.member.get(`${ITEMS}/user/${target}`);
    expect(after.json).toMatchObject({ version: 3 });
    expect((await stateOf(upd))?.state).toBe("open");
  });

  it("dismisses with the pass's statement hash, once", async () => {
    const t = await thread(ids.member);
    const statement = unique("Lunch at noon");
    const c = await candidate(await pass(t, ids.member), { statement });
    const r = await as.member.post(`${REVIEW}/candidates/${c}/dismiss`, {});
    expect(r.status).toBe(200);
    expect((await stateOf(c))?.state).toBe("dismissed");
    const d = await h.admin.query<{ statement_hash: string }>(
      `SELECT statement_hash FROM memory_dismissals WHERE thread_id = $1 AND user_id = $2`,
      [t, ids.member],
    );
    expect(d.rows).toEqual([{ statement_hash: statementHash(statement) }]);
    expect(await audits("memory.candidate.dismissed")).toContainEqual({
      candidateId: c,
      passId: expect.any(String),
      threadId: t,
    });
    expect(codeOf(await as.member.post(`${REVIEW}/candidates/${c}/dismiss`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
  });
});

describe("an update whose target changed since the pass (KOBE-779, P2-46)", () => {
  it("is refused with a reason, stays open, and saves once the person reviewed the change", async () => {
    const existing = await as.member.post(ITEMS, {
      scope: "user",
      kind: "fact",
      statement: unique("Retro on Fridays"),
    });
    const target = (existing.json as { id: string }).id;
    const t = await thread(ids.member);
    const upd = await candidate(await pass(t, ids.member), {
      operation: "update",
      target_id: target,
      target_version: 1,
      statement: unique("Retro on Friday afternoons"),
    });
    const card = async () =>
      (
        (await list(as.member, t)).json as {
          candidates: { id: string; target: { version: number } | null; target_changed: boolean }[];
        }
      ).candidates.find((x) => x.id === upd);
    expect(await card()).toMatchObject({ target: { version: 1 }, target_changed: false });
    // Someone edits the memory after the pass suggested the change.
    const edited = await as.member.patch(`${ITEMS}/user/${target}`, {
      expected_version: 1,
      statement: unique("Retro on Thursdays"),
    });
    expect(edited.status).toBe(200);
    const refused = await save(as.member, upd);
    expect(codeOf(refused)).toEqual([409, "memory_version_conflict"]);
    expect((refused.json as { message: string }).message).toMatch(/changed since Kaiju suggested/);
    expect((await stateOf(upd))?.state).toBe("open");
    expect((await as.member.get(`${ITEMS}/user/${target}`)).json).toMatchObject({ version: 2 });
    expect(await card()).toMatchObject({ target: { version: 2 }, target_changed: true });
    // An older version than the current one is refused too.
    expect(codeOf(await save(as.member, upd, { target_version: 1 }))).toEqual([
      409,
      "memory_version_conflict",
    ]);
    // Reviewed against the current version: saved on top of it.
    const ok = await save(as.member, upd, { target_version: 2 });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((ok.json as { item: object }).item).toMatchObject({ id: target, version: 3 });
  });

  it("a targeted Workspace candidate saves into the Workspace item (P2-6)", async () => {
    const existing = await as.admin.post(ITEMS, {
      scope: "team",
      kind: "fact",
      statement: unique("We ship on Tuesdays"),
    });
    expect(existing.status, JSON.stringify(existing.json)).toBe(201);
    const target = (existing.json as { id: string }).id;
    const t = await thread(ids.admin);
    const upd = await candidate(await pass(t, ids.admin), {
      operation: "update",
      destination: "team",
      target_id: target,
      target_version: 1,
      statement: unique("We ship on Tuesdays and Thursdays"),
    });
    const r = await save(as.admin, upd);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { item: object }).item).toMatchObject({
      id: target,
      version: 2,
      scope: "team",
    });
  });
});

describe("Save all mine and batch Undo (ac-2)", () => {
  it("saves the batch atomically and one Undo reopens all of it", async () => {
    const t = await thread(ids.member);
    const p = await pass(t, ids.member);
    const one = await candidate(p);
    const two = await candidate(p, { kind: "preference", destination: "portable" });
    const shared = await candidate(p, { destination: "team" });
    // A Workspace candidate in the batch: nothing is saved.
    const refused = await as.member.post(`${REVIEW}/save-all`, {
      candidate_ids: [one, two, shared],
    });
    expect(codeOf(refused)).toEqual([400, "invalid_request"]);
    expect((await stateOf(one))?.state).toBe("open");

    const r = await as.member.post(`${REVIEW}/save-all`, { candidate_ids: [one, two] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const saved = (
      r.json as { saved: { candidate_id: string; item: { id: string; scope: string } }[] }
    ).saved;
    expect(saved.map((s) => [s.candidate_id, s.item.scope])).toEqual([
      [one, "user"],
      [two, "portable"],
    ]);
    expect((await cards(as.member, t)).map((c) => c.id)).toEqual([shared]);

    const undo = await as.member.post(`${REVIEW}/undo`, { candidate_ids: [one, two] });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect((await cards(as.member, t)).map((c) => c.id).sort()).toEqual([one, two, shared].sort());
    for (const s of saved) {
      const item = await as.member.get(`${ITEMS}/${s.item.scope}/${s.item.id}`);
      expect(item.json).toMatchObject({ status: "archived" });
    }
  });

  it("refuses Undo when a saved memory changed since, and changes nothing", async () => {
    const t = await thread(ids.member);
    const p = await pass(t, ids.member);
    const one = await candidate(p);
    const two = await candidate(p);
    const r = await as.member.post(`${REVIEW}/save-all`, { candidate_ids: [one, two] });
    const saved = (r.json as { saved: { item: { id: string } }[] }).saved;
    const edited = await as.member.patch(`${ITEMS}/user/${must(saved[1], "second").item.id}`, {
      expected_version: 1,
      statement: unique("Changed"),
    });
    expect(edited.status).toBe(200);
    const undo = await as.member.post(`${REVIEW}/undo`, { candidate_ids: [one, two] });
    expect(codeOf(undo)).toEqual([409, "memory_version_conflict"]);
    expect((await stateOf(one))?.state).toBe("saved");
    const first = await as.member.get(`${ITEMS}/user/${must(saved[0], "first").item.id}`);
    expect(first.json).toMatchObject({ status: "active" });
  });
});

describe("notices (ac-1 fallback)", () => {
  it("tells the person in the bell, marks it read when seen, and settles the reminder", async () => {
    const t = await thread(ids.member);
    const p = await pass(t, ids.member);
    const c = await candidate(p);
    await withTeam(h.deps.database.db, team, (tx) =>
      noticeCandidatesReady(tx, { teamId: team, userId: ids.member, threadId: t, passId: p }, 1),
    );
    const notes = async () =>
      (
        await h.admin.query<{ read_at: Date | null; item_count: number }>(
          `SELECT read_at, item_count FROM notifications
            WHERE user_id = $1 AND thread_id = $2 AND kind = 'memory.review.candidates_ready'`,
          [ids.member, t],
        )
      ).rows;
    expect(await notes()).toEqual([{ read_at: null, item_count: 1 }]);
    const reminders = async () =>
      (await h.admin.query(`SELECT 1 FROM memory_reminders WHERE object_id = $1`, [p])).rows.length;
    expect(await reminders()).toBe(1);
    const seen = await as.member.post(`${REVIEW}/seen`, { thread_id: t });
    expect(seen.json).toEqual({ read: 1 });
    expect((await notes())[0]?.read_at).not.toBeNull();
    await as.member.post(`${REVIEW}/candidates/${c}/dismiss`, {});
    expect(await reminders()).toBe(0);
  });
});
