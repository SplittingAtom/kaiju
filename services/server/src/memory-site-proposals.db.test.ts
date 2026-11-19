import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { statementHash } from "./memory/learn/validate.js";
import type { TestBrowser } from "./testing/browser.js";
import { must } from "./testing/event-stream-fixture.js";
import { openHarness, type Harness } from "./testing/harness.js";

/**
 * KOBE-403 (SMC2; SM19, SM20, SM22): Site proposals over Postgres. A Workspace member proposes a
 * stated candidate (or a curator a Workspace memory) with a justification; step 1: a Team admin
 * confirms (may edit; skipped for a Team admin's own), stewards endorse; step 2: Site admins and
 * Site stewards approve (a Site memory), merge (its next version), reject (reason) or request
 * changes (≤ 3 rounds), never their own. Only the statement and justification cross; provenance
 * names the source Workspace to Site curators only; the Workspace source stays. The table has no
 * RLS: every read is filtered by role in the server (others get 404).
 */
let h: Harness;
const team = randomUUID();
const otherTeam = randomUUID();
const ids = {
  admin: "",
  steward: "",
  member: "",
  member2: "",
  outsider: "",
  siteAdmin: "",
  siteSteward: "",
  siteMember: "",
};
type Who = keyof typeof ids;
const as = {} as Record<Who, TestBrowser>;
const WS = "/v1/memory/site-proposals";
const SITE = "/v1/site/memory/proposals";
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;
const codeOf = (r: { status: number; json: unknown }) => [
  r.status,
  (r.json as { code?: unknown }).code,
];
type View = {
  id: string;
  state: string;
  rounds: number;
  statement: string;
  endorsed: boolean;
  confirmed_by: { id: string } | null;
  from_workspace?: { id: string; name: string };
  merged_into: string | null;
  reason: string | null;
};
const proposalOf = (r: { json: unknown }) => (r.json as { proposal: View }).proposal;

beforeAll(async () => {
  h = await openHarness();
  for (const who of Object.keys(ids) as Who[])
    ids[who] = await h.createUser(
      `${who}@smp.test`,
      who === "siteAdmin" || who === "siteMember" ? "admin" : undefined,
    );
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'smp-a', 'Workspace A'), ($2, 'smp-b', 'B')`,
    [team, otherTeam],
  );
  // siteMember: a Site admin who is also a plain member of Workspace A (gets its bell notices).
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $2, 'team_admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'),
       ($1, $6, 'member'), ($7, $8, 'team_admin')`,
    [
      team,
      ids.admin,
      ids.steward,
      ids.member,
      ids.member2,
      ids.siteMember,
      otherTeam,
      ids.outsider,
    ],
  );
  await h.admin.query(
    `INSERT INTO memory_stewards (team_id, user_id, granted_by) VALUES ($1, $2, $3)`,
    [team, ids.steward, ids.admin],
  );
  await h.admin.query(
    `INSERT INTO site_grants (user_id, "grant", granted_by) VALUES ($1, 'memory_steward', $2)`,
    [ids.siteSteward, ids.siteAdmin],
  );
  for (const who of Object.keys(ids) as Who[]) {
    as[who] = await h.signIn(`${who}@smp.test`);
    if (who === "siteAdmin" || who === "siteSteward") continue; // no Workspace
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

/** A thread of `owner` with a candidate a pass found in it. */
async function seed(owner: string, source = "stated"): Promise<string> {
  const threadId = randomUUID();
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    owner,
  ]);
  await h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'u1', NULL, 'message', $3), ($1, $2, 'a1', 'u1', 'message', $4)`,
    [team, threadId, msg("user", "Invoices go out on the 3rd."), msg("assistant", "Noted.")],
  );
  const { rows: p } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at)
     VALUES ($1, $2, $3, 'a1', 'a1', 'learner', 'v1', 'completed', now(), now()) RETURNING id`,
    [team, threadId, owner],
  );
  const statement = unique("Invoices go out on the 3rd");
  const payload = {
    statement,
    kind: "fact",
    destination: source === "inferred" ? "user" : "team",
    suggested_scope: "team",
    portable: false,
    project_specific: false,
    source,
    operation: "add",
    target_id: null,
    confidence: 0.9,
    rationale: "SECRET-RATIONALE the person said so.",
    evidence: [{ entry_id: "u1", quote: "Invoices go out on the 3rd." }],
    statement_hash: statementHash(statement),
    warnings: [],
    policy_conflicts: [],
    near_duplicates: [],
    prompt_version: "v1",
  };
  const { rows: c } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, 0, $3)
     RETURNING id`,
    [team, must(p[0], "pass").id, JSON.stringify(payload)],
  );
  return must(c[0], "candidate").id;
}

const fromCandidate = (
  who: Who,
  candidateId: string,
  body: object = { justification: "All teams invoice." },
) => as[who].post(`${WS}/candidates/${candidateId}`, body);

async function workspaceItem(statement = unique("We ship on Tuesdays")): Promise<string> {
  const r = await as.admin.post("/v1/memory/semantic/items", {
    scope: "team",
    kind: "fact",
    statement,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return (r.json as { id: string }).id;
}

/** A member's proposal confirmed by the Team admin: awaiting the Site. */
async function confirmed(): Promise<string> {
  const id = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
  expect((await as.admin.post(`${WS}/${id}/confirm`, {})).status).toBe(200);
  return id;
}

const row = async (id: string) =>
  must(
    (await h.admin.query(`SELECT * FROM site_memory_proposals WHERE id = $1`, [id])).rows[0],
    "proposal",
  ) as Record<string, unknown>;
const notices = async (userId: string, objectId: string) =>
  (
    await h.admin.query<{ kind: string }>(
      `SELECT kind FROM notifications WHERE user_id = $1 AND memory_object_id = $2
        ORDER BY created_at`,
      [userId, objectId],
    )
  ).rows.map((r) => r.kind);
const audits = async (action: string, proposalId: string) =>
  (
    await h.admin.query<{ team_id: string | null; target: Record<string, unknown> }>(
      `SELECT team_id, target FROM audit_log WHERE action = $1 AND target ->> 'proposalId' = $2`,
      [action, proposalId],
    )
  ).rows;

describe("propose (step 0)", () => {
  it("sends a stated candidate with its justification only; Team admins are told", async () => {
    const candidateId = await seed(ids.member);
    const r = await fromCandidate("member", candidateId);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const p = proposalOf(r);
    expect(p).toMatchObject({ state: "awaiting_team", rounds: 0, confirmed_by: null });
    // Nothing thread-derived in the answer or the row.
    for (const text of [JSON.stringify(r.json), JSON.stringify(await row(p.id))]) {
      expect(text).not.toContain("SECRET-RATIONALE");
      expect(text).not.toContain(candidateId);
      expect(text).not.toContain('Invoices go out on the 3rd."');
    }
    const cand = await h.admin.query<{ state: string; payload: Record<string, unknown> }>(
      `SELECT state, payload FROM memory_candidates WHERE id = $1`,
      [candidateId],
    );
    expect(cand.rows[0]).toMatchObject({ state: "proposed", payload: { site_proposal_id: p.id } });
    expect(await notices(ids.admin, p.id)).toEqual(["memory.site_proposal.received"]);
    expect(await notices(ids.member, p.id)).toEqual([]);
    expect(await notices(ids.siteMember, p.id)).toEqual([]);
    expect((await audits("memory.site_proposal.created", p.id))[0]).toMatchObject({
      team_id: team,
      target: { source: "candidate", candidateId, confirmed: false },
    });
    // Not on the Site until a Team admin confirms.
    expect(codeOf(await as.siteAdmin.get(`${SITE}/${p.id}`))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    const queue = await as.siteAdmin.get(`${SITE}?state=awaiting_team`);
    expect((queue.json as { proposals: View[] }).proposals.map((x) => x.id)).not.toContain(p.id);
  });

  it("refuses inferred candidates, a missing justification, secrets and others' candidates", async () => {
    expect(codeOf(await fromCandidate("member", await seed(ids.member, "inferred")))).toEqual([
      400,
      "invalid_request",
    ]);
    expect(codeOf(await fromCandidate("member", await seed(ids.member), {}))).toEqual([
      400,
      "invalid_request",
    ]);
    const secret = await fromCandidate("member", await seed(ids.member), {
      justification: "The deploy key is AKIAIOSFODNN7EXAMPLE",
    });
    expect(codeOf(secret)).toEqual([422, "memory_secret"]);
    expect(codeOf(await fromCandidate("member2", await seed(ids.member)))).toEqual([
      404,
      "memory_item_not_found",
    ]);
  });

  it("proposes a Workspace memory (curators only); a Team admin's own skips step 1", async () => {
    const itemId = await workspaceItem();
    const body = { item_id: itemId, justification: "Every team ships on Tuesdays." };
    expect(codeOf(await as.member.post(WS, body))).toEqual([403, "memory_not_allowed"]);
    const byAdmin = proposalOf(await as.admin.post(WS, body));
    expect(byAdmin).toMatchObject({ state: "awaiting_site", confirmed_by: { id: ids.admin } });
    expect(await notices(ids.siteMember, byAdmin.id)).toEqual(["memory.site_proposal.confirmed"]);
    const bySteward = await as.steward.post(WS, body);
    expect(bySteward.status).toBe(201);
    expect(proposalOf(bySteward).state).toBe("awaiting_team");
  });

  it("respects the Workspace's Members may propose to the Site switch", async () => {
    const candidateId = await seed(ids.member);
    await h.admin.query(
      `UPDATE teams SET settings = jsonb_set(coalesce(settings, '{}'), '{memory}',
         coalesce(settings -> 'memory', '{}') || '{"site_proposals_enabled": false}') WHERE id = $1`,
      [team],
    );
    try {
      expect(codeOf(await fromCandidate("member", candidateId))).toEqual([403, "memory_disabled"]);
    } finally {
      await h.admin.query(
        `UPDATE teams SET settings = settings #- '{memory,site_proposals_enabled}' WHERE id = $1`,
        [team],
      );
    }
    expect((await fromCandidate("member", candidateId)).status).toBe(201);
  });
});

describe("step 1 (the Workspace)", () => {
  it("only Team admins confirm (edit audited); stewards endorse; the Site is told", async () => {
    const id = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    expect(codeOf(await as.member.post(`${WS}/${id}/confirm`, {}))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect(codeOf(await as.steward.post(`${WS}/${id}/confirm`, {}))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect(codeOf(await as.member.post(`${WS}/${id}/endorse`))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect(proposalOf(await as.steward.post(`${WS}/${id}/endorse`)).endorsed).toBe(true);
    const edited = unique("Invoices are sent on the 3rd");
    const r = await as.admin.post(`${WS}/${id}/confirm`, { statement: edited });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(proposalOf(r)).toMatchObject({ state: "awaiting_site", statement: edited });
    expect((await audits("memory.site_proposal.confirmed", id))[0]).toMatchObject({
      team_id: team,
      target: { edited: true, round: 0 },
    });
    expect(await notices(ids.siteMember, id)).toEqual(["memory.site_proposal.confirmed"]);
    expect(await notices(ids.member, id)).toEqual(["memory.site_proposal.confirmed"]);
    expect(codeOf(await as.admin.post(`${WS}/${id}/confirm`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
  });

  it("shows proposals by role: curators all, a member their own, other Workspaces none", async () => {
    const id = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    for (const who of ["admin", "steward", "member"] as const)
      expect((await as[who].get(`${WS}/${id}`)).status, who).toBe(200);
    expect(codeOf(await as.member2.get(`${WS}/${id}`))).toEqual([404, "memory_item_not_found"]);
    expect(codeOf(await as.outsider.get(`${WS}/${id}`))).toEqual([404, "memory_item_not_found"]);
    const mine = (await as.member2.get(WS)).json as { proposals: View[] };
    expect(mine.proposals.map((p) => p.id)).not.toContain(id);
    const queue = (await as.admin.get(`${WS}?state=awaiting_team`)).json as {
      proposals: View[];
      counts: Record<string, number>;
    };
    expect(queue.proposals.map((p) => p.id)).toContain(id);
    expect(queue.counts.awaiting_team).toBeGreaterThan(0);
    const other = (await as.outsider.get(WS)).json as { proposals: View[] };
    expect(other.proposals).toEqual([]);
    // The Site's endpoints are for Site curators.
    expect((await as.admin.get(SITE)).status).toBe(403);
  });

  it("the proposer or a Team admin withdraws; nobody else; nothing after", async () => {
    const own = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    expect(codeOf(await as.member2.post(`${WS}/${own}/withdraw`))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    expect(codeOf(await as.steward.post(`${WS}/${own}/withdraw`))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    expect(proposalOf(await as.member.post(`${WS}/${own}/withdraw`)).state).toBe("withdrawn");
    expect(codeOf(await as.admin.post(`${WS}/${own}/confirm`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
    const waiting = await confirmed();
    expect(proposalOf(await as.admin.post(`${WS}/${waiting}/withdraw`)).state).toBe("withdrawn");
    expect((await audits("memory.site_proposal.withdrawn", waiting))[0]?.target).toMatchObject({
      by: "team_admin",
      fromState: "awaiting_site",
    });
    expect(codeOf(await as.siteAdmin.post(`${SITE}/${waiting}/approve`, {}))).toEqual([
      409,
      "memory_item_inactive",
    ]);
    const left = await h.admin.query(`SELECT 1 FROM memory_reminders WHERE object_id = $1`, [
      waiting,
    ]);
    expect(left.rows).toEqual([]);
  });
});

describe("step 2 (the Site)", () => {
  it("approves into a Site memory whose only provenance is the proposal; the source stays", async () => {
    // Its own wording: Site memories are Site-wide, so an approval elsewhere in the suite with the
    // default "We ship on Tuesdays …" statement made this one a near duplicate (409) at random.
    const itemId = await workspaceItem(
      unique("Quarterly offsites are planned by the operations lead"),
    );
    const p = proposalOf(
      await as.admin.post(WS, { item_id: itemId, justification: "All teams ship Tuesdays." }),
    );
    const detail = await as.siteSteward.get(`${SITE}/${p.id}`);
    expect(detail.status).toBe(200);
    expect(detail.json).toMatchObject({
      proposal: { from_workspace: { id: team, name: "Workspace A" } },
      checks: { near_duplicates: [], policy_conflicts: [] },
    });
    const r = await as.siteSteward.post(`${SITE}/${p.id}/approve`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = r.json as { proposal: View; item: { id: string; version: number } };
    expect(out.proposal.state).toBe("approved");
    const versions = await h.admin.query(
      `SELECT actor_kind, proposal_id, actor_user_id FROM site_memory_item_versions WHERE item_id = $1`,
      [out.item.id],
    );
    expect(versions.rows).toEqual([
      { actor_kind: "proposal", proposal_id: p.id, actor_user_id: ids.siteSteward },
    ]);
    // ac-3: the Workspace memory it came from is still there and active.
    const source = await as.admin.get(`/v1/memory/semantic/items/team/${itemId}`);
    expect(source.json).toMatchObject({ status: "active" });
    expect((await audits("memory.site_proposal.accepted", p.id))[0]).toMatchObject({
      team_id: null,
      target: { outcome: "approved", fromTeamId: team, itemId: out.item.id },
    });
    expect(await notices(ids.admin, p.id)).toContain("memory.site_proposal.accepted");

    // ac-2: Site curators see the source Workspace; everyone else "set by the Site".
    const prov = `${SITE}/items/${out.item.id}/provenance`;
    expect((await as.siteAdmin.get(prov)).json).toMatchObject({
      set_by: "workspace",
      from_proposals: [{ version: 1, proposal_id: p.id, from_workspace: { id: team } }],
    });
    for (const who of ["member", "admin", "outsider"] as const) {
      expect((await as[who].get(prov)).json, who).toEqual({ set_by: "site" });
      const item = await as[who].get(`/v1/memory/semantic/items/site/${out.item.id}`);
      expect(item.status, who).toBe(200);
      expect(JSON.stringify(item.json)).not.toContain(team);
      expect(JSON.stringify(item.json)).not.toContain("Workspace A");
    }
  });

  it("merges into an existing Site memory as its next version", async () => {
    const first = await confirmed();
    const approved = (await as.siteAdmin.post(`${SITE}/${first}/approve`, {})).json as {
      item: { id: string };
    };
    const second = await confirmed();
    const merged = unique("Invoices go out on the 3rd and the 17th");
    const r = await as.siteAdmin.post(`${SITE}/${second}/merge`, {
      item_id: approved.item.id,
      statement: merged,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const out = r.json as { proposal: View; item: { version: number; statement: string } };
    expect(out.proposal).toMatchObject({ state: "merged", merged_into: approved.item.id });
    expect(out.item).toMatchObject({ version: 2, statement: merged });
    const v2 = await h.admin.query(
      `SELECT actor_kind, proposal_id FROM site_memory_item_versions WHERE item_id = $1 AND version = 2`,
      [approved.item.id],
    );
    expect(v2.rows[0]).toEqual({ actor_kind: "proposal", proposal_id: second });
  });

  it("nobody decides their own; a reason is required to reject", async () => {
    // A Site admin who is a member of the Workspace proposes; another Team admin confirms.
    const own = proposalOf(await fromCandidate("siteMember", await seed(ids.siteMember))).id;
    expect((await as.admin.post(`${WS}/${own}/confirm`, {})).status).toBe(200);
    expect(codeOf(await as.siteMember.post(`${SITE}/${own}/approve`, {}))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    // Workspace curators are not Site curators.
    expect(codeOf(await as.admin.post(`${SITE}/${own}/approve`, {}))).toEqual([
      404,
      "memory_item_not_found",
    ]);
    expect((await as.siteAdmin.post(`${SITE}/${own}/reject`, {})).status).toBe(400);
    const r = await as.siteAdmin.post(`${SITE}/${own}/reject`, { reason: "Too team-specific." });
    expect(proposalOf(r)).toMatchObject({ state: "rejected", reason: "Too team-specific." });
    expect((await audits("memory.site_proposal.dismissed", own))[0]).toMatchObject({
      team_id: null,
      target: { outcome: "rejected" },
    });
    expect(await notices(ids.siteMember, own)).toContain("memory.site_proposal.dismissed");
  });

  it("request changes sends it back to the Team admins, at most 3 rounds, then decide", async () => {
    const id = await confirmed();
    for (let round = 1; round <= 3; round += 1) {
      const r = await as.siteAdmin.post(`${SITE}/${id}/request-changes`, {
        note: `Round ${round}`,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(proposalOf(r)).toMatchObject({ state: "awaiting_team", rounds: round });
      expect(await notices(ids.admin, id)).toContain("memory.site_proposal.changes_requested");
      const back = proposalOf(await as.admin.post(`${WS}/${id}/confirm`, {}));
      expect(back).toMatchObject({ state: "awaiting_site", rounds: round });
    }
    expect(
      codeOf(await as.siteAdmin.post(`${SITE}/${id}/request-changes`, { note: "Again" })),
    ).toEqual([409, "memory_item_inactive"]);
    expect(
      (await as.siteAdmin.post(`${SITE}/${id}/request-changes`, { note: "x".repeat(501) })).status,
    ).toBe(400);
    expect(
      proposalOf(await as.siteAdmin.post(`${SITE}/${id}/reject`, { reason: "No." })).state,
    ).toBe("rejected");
    // Rounds never reset the clock.
    const r = await row(id);
    expect(new Date(r.expires_at as string).getTime()).toBeGreaterThan(
      Date.now() + 29 * 86_400_000,
    );
  });

  it("lists the queue with filters and counts", async () => {
    const id = await confirmed();
    const r = await as.siteSteward.get(`${SITE}?from_team_id=${team}`);
    const body = r.json as { proposals: View[]; counts: Record<string, number> };
    expect(body.proposals.map((p) => p.id)).toContain(id);
    expect(body.proposals.every((p) => p.state === "awaiting_site")).toBe(true);
    expect(body.counts.awaiting_site).toBeGreaterThan(0);
    const none = await as.siteSteward.get(`${SITE}?from_team_id=${otherTeam}`);
    expect((none.json as { proposals: View[] }).proposals).toEqual([]);
    expect((await as.siteSteward.get(`${SITE}?state=bogus`)).status).toBe(400);
  });
});

/** Earlier tests leave similar Site memories: save over the near-duplicate warning. */
const LINT_OK = { overrides: { lint: true } };

const setSwitch = (on: boolean) =>
  h.admin.query(
    on
      ? `UPDATE teams SET settings = settings #- '{memory,site_proposals_enabled}' WHERE id = $1`
      : `UPDATE teams SET settings = jsonb_set(coalesce(settings, '{}'), '{memory}',
           coalesce(settings -> 'memory', '{}') || '{"site_proposals_enabled": false}') WHERE id = $1`,
    [team],
  );

async function siteItem(body: object): Promise<string> {
  const r = await as.siteAdmin.post("/v1/memory/semantic/items", {
    scope: "site",
    kind: "convention",
    ...body,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return (r.json as { id: string }).id;
}

describe("review follow-ups (walls, races, edges)", () => {
  it("another Workspace's Team admin can't act on a proposal by id", async () => {
    const id = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    for (const path of ["confirm", "withdraw", "endorse"])
      expect(codeOf(await as.outsider.post(`${WS}/${id}/${path}`, {})), path).toEqual([
        404,
        "memory_item_not_found",
      ]);
    expect((await row(id)).state).toBe("awaiting_team");
  });

  it("two concurrent approvals make exactly one Site memory", async () => {
    const id = await confirmed();
    const results = await Promise.all([
      as.siteAdmin.post(`${SITE}/${id}/approve`, LINT_OK),
      as.siteSteward.post(`${SITE}/${id}/approve`, LINT_OK),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const made = await h.admin.query(
      `SELECT DISTINCT item_id FROM site_memory_item_versions WHERE proposal_id = $1`,
      [id],
    );
    expect(made.rows).toHaveLength(1);
  });

  it("confirm racing withdraw: serialised, the withdrawal always wins in the end", async () => {
    const id = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    const [c, w] = await Promise.all([
      as.admin.post(`${WS}/${id}/confirm`, {}),
      as.member.post(`${WS}/${id}/withdraw`),
    ]);
    // Withdraw works in either open state; confirm loses (409) only when withdraw went first.
    expect(w.status).toBe(200);
    expect([200, 409]).toContain(c.status);
    expect((await row(id)).state).toBe("withdrawn");
    expect((await audits("memory.site_proposal.withdrawn", id))[0]?.target).toMatchObject({
      fromState: c.status === 200 ? "awaiting_site" : "awaiting_team",
    });
  });

  it("a Site steward can't approve as Policy, merge into Policy or into an archived memory", async () => {
    const id = await confirmed();
    expect(codeOf(await as.siteSteward.post(`${SITE}/${id}/approve`, { policy: true }))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    const policy = await siteItem({
      statement: unique("All teams follow the handbook"),
      policy: true,
    });
    expect(codeOf(await as.siteSteward.post(`${SITE}/${id}/merge`, { item_id: policy }))).toEqual([
      403,
      "memory_not_allowed",
    ]);
    const archived = await siteItem({ statement: unique("Archive me") });
    expect(
      (await as.siteAdmin.post(`/v1/memory/semantic/items/site/${archived}/archive`, {})).status,
    ).toBe(200);
    expect(codeOf(await as.siteSteward.post(`${SITE}/${id}/merge`, { item_id: archived }))).toEqual(
      [409, "memory_item_inactive"],
    );
    expect((await row(id)).state).toBe("awaiting_site");
  });

  it("an expired proposal reads expired and refuses every action", async () => {
    const waiting = await confirmed();
    const fresh = proposalOf(await fromCandidate("member", await seed(ids.member))).id;
    await h.admin.query(
      `UPDATE site_memory_proposals SET expires_at = now() - interval '1 minute' WHERE id = ANY($1)`,
      [[waiting, fresh]],
    );
    expect(proposalOf(await as.member.get(`${WS}/${fresh}`)).state).toBe("expired");
    expect(proposalOf(await as.siteAdmin.get(`${SITE}/${waiting}`)).state).toBe("expired");
    for (const r of [
      await as.admin.post(`${WS}/${fresh}/confirm`, {}),
      await as.member.post(`${WS}/${fresh}/withdraw`),
      await as.steward.post(`${WS}/${fresh}/endorse`),
      await as.siteAdmin.post(`${SITE}/${waiting}/approve`, LINT_OK),
      await as.siteAdmin.post(`${SITE}/${waiting}/reject`, { reason: "Late." }),
      await as.siteAdmin.post(`${SITE}/${waiting}/request-changes`, { note: "Late." }),
    ])
      expect(codeOf(r)).toEqual([409, "memory_item_inactive"]);
  });

  it("the switch turned off after confirmation stops approve and merge, not reject", async () => {
    const id = await confirmed();
    const target = await siteItem({ statement: unique("Invoices go out monthly") });
    await setSwitch(false);
    try {
      expect(codeOf(await as.siteAdmin.post(`${SITE}/${id}/approve`, LINT_OK))).toEqual([
        403,
        "memory_disabled",
      ]);
      expect(codeOf(await as.siteAdmin.post(`${SITE}/${id}/merge`, { item_id: target }))).toEqual([
        403,
        "memory_disabled",
      ]);
      expect((await as.siteAdmin.post(`${SITE}/${id}/reject`, { reason: "Off." })).status).toBe(
        200,
      );
    } finally {
      await setSwitch(true);
    }
  });

  it("Site decisions are also in the Workspace's log, ids only, as the system", async () => {
    const id = await confirmed();
    await as.siteAdmin.post(`${SITE}/${id}/request-changes`, { note: "Say which day." });
    await as.admin.post(`${WS}/${id}/confirm`, {});
    const done = (await as.siteAdmin.post(`${SITE}/${id}/approve`, LINT_OK)).json as {
      item: { id: string };
    };
    const rows = (
      await h.admin.query<{
        team_id: string;
        actor_kind: string;
        actor_id: string | null;
        target: Record<string, unknown>;
      }>(
        `SELECT team_id, actor_kind, actor_id, target FROM audit_log
          WHERE action = 'memory.site_proposal.decided' AND target ->> 'proposalId' = $1
          ORDER BY seq`,
        [id],
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({
        team_id: team,
        actor_kind: "system",
        actor_id: null,
        target: expect.objectContaining({ outcome: "changes_requested", round: 1 }),
      }),
      expect.objectContaining({
        team_id: team,
        target: expect.objectContaining({ outcome: "approved", itemId: done.item.id }),
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("Say which day.");
  });

  it("a request-changes note is a note, not a decision, and never survives approval", async () => {
    const id = await confirmed();
    await as.siteAdmin.post(`${SITE}/${id}/request-changes`, { note: "Name the day." });
    for (const view of [
      proposalOf(await as.member.get(`${WS}/${id}`)),
      proposalOf(await as.siteAdmin.get(`${SITE}/${id}`)),
    ])
      expect(view).toMatchObject({
        state: "awaiting_team",
        reason: null,
        decided_at: null,
        changes_note: "Name the day.",
      });
    expect(proposalOf(await as.siteAdmin.get(`${SITE}/${id}`))).toMatchObject({ decided_by: null });
    await as.admin.post(`${WS}/${id}/confirm`, {});
    const approved = proposalOf(await as.siteAdmin.post(`${SITE}/${id}/approve`, LINT_OK));
    expect(approved).toMatchObject({ state: "approved", reason: null, changes_note: null });
    expect((await row(id)).reason).toBeNull();
  });

  it("presents proposal-made Site memories as set by the Site to everyone but Site curators", async () => {
    const id = await confirmed();
    const item = (
      (await as.siteAdmin.post(`${SITE}/${id}/approve`, LINT_OK)).json as {
        item: { id: string };
      }
    ).item.id;
    const kinds = async (who: Who) =>
      (
        (await as[who].get(`/v1/memory/semantic/items/site/${item}`)).json as {
          versions: { actor_kind: string }[];
        }
      ).versions.map((v) => v.actor_kind);
    expect(await kinds("siteAdmin")).toEqual(["proposal"]);
    for (const who of ["member", "admin", "outsider"] as const)
      expect(await kinds(who), who).toEqual(["user"]);
  });
});
