import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestBrowser } from "../testing/browser.js";
import { openHarness, type Harness } from "../testing/harness.js";

/**
 * KOBE-651 (SM28): the personal export holds the person's own Learn from this chat records in the
 * exported Workspace (`memory-learning.json`): passes, candidates, dismissals, watermarks, and the
 * proposals and project suggestions they made. Nothing of other people or other Workspaces; quotes
 * only from the person's own messages in their own conversations; no curator ids.
 */
let h: Harness;
const teamA = randomUUID();
const teamB = randomUUID();
const project = randomUUID();
const ids = { member: "", other: "", curator: "" };
let member: TestBrowser;

type Section = Record<string, unknown>[];
interface Learning {
  passes: Section;
  candidates: Section;
  dismissals: Section;
  watermarks: Section;
  proposals: Section;
  suggestions: Section;
}

async function download(b: TestBrowser, team: string) {
  const res = await h.app.request(`http://kaiju.test/v1/threads/export?team=${team}`, {
    headers: {
      origin: "http://kaiju.test",
      "x-forwarded-for": b.ip,
      cookie: [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
    },
  });
  expect(res.status).toBe(200);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const raw = strFromU8(files["memory-learning.json"] ?? new Uint8Array());
  return { raw, learning: JSON.parse(raw) as Learning };
}

const msg = (role: string, text: string) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

async function thread(team: string, owner: string): Promise<string> {
  const id = randomUUID();
  await h.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    id,
    owner,
  ]);
  await h.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'u1', NULL, 'message', $3), ($1, $2, 'a1', 'u1', 'message', $4)`,
    [team, id, msg("user", "We deploy from main on Fridays."), msg("assistant", "ASSISTANT-TEXT")],
  );
  return id;
}

async function learningPass(team: string, owner: string, threadId: string): Promise<string> {
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at)
     VALUES ($1, $2, $3, 'a1', 'a1', 'learner', 'v1', 'completed', now(), now()) RETURNING id`,
    [team, threadId, owner],
  );
  return rows[0]?.id ?? "";
}

const EVIDENCE = [
  { entry_id: "u1", quote: "We deploy from main" },
  { entry_id: "a1", quote: "ASSISTANT-TEXT" },
  { entry_id: "u1", quote: "PARAPHRASED quote" },
];

async function candidate(team: string, passId: string, statement: string): Promise<string> {
  const payload = {
    statement,
    kind: "fact",
    destination: "team",
    operation: "add",
    confidence: 0.9,
    rationale: "The person said so.",
    evidence: EVIDENCE,
    near_duplicates: [{ id: randomUUID(), version: 1 }],
  };
  const { rows } = await h.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload, expires_at)
     VALUES ($1, $2, 0, $3, now() - interval '1 day') RETURNING id`,
    [team, passId, JSON.stringify(payload)],
  );
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  h = await openHarness();
  for (const who of Object.keys(ids) as (keyof typeof ids)[])
    ids[who] = await h.createUser(`${who}@export-learning.test`);
  await h.admin.query(
    `INSERT INTO teams (id, slug, name) VALUES ($1, 'xl-a', 'A'), ($2, 'xl-b', 'B')`,
    [teamA, teamB],
  );
  await h.admin.query(
    `INSERT INTO team_members (team_id, user_id, role) VALUES
       ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'team_admin'), ($2, $3, 'member')`,
    [teamA, teamB, ids.member, ids.other, ids.curator],
  );
  await h.admin.query(
    `INSERT INTO projects (team_id, id, slug, name, created_by) VALUES ($1, $2, 'xl', 'P', $3)`,
    [teamA, project, ids.curator],
  );
  member = await h.signIn("member@export-learning.test");
  await member.put("/v1/me/teams/active", { teamId: teamA });
  member.team = teamA;
});

afterAll(async () => {
  await h?.close();
});

describe("Learn from this chat records in the personal export (KOBE-651)", () => {
  it("holds the person's own records, quotes only of their messages, and nothing of others", async () => {
    const own = await thread(teamA, ids.member);
    const theirs = await thread(teamA, ids.other);
    const pass = await learningPass(teamA, ids.member, own);
    const cand = await candidate(teamA, pass, "We deploy from main.");
    // A pass of the person on a conversation they no longer own: no thread, no quotes.
    const foreignPass = await learningPass(teamA, ids.member, theirs);
    const foreign = await candidate(teamA, foreignPass, "From a conversation not mine.");
    // Excluded: another person's records and the person's records in another Workspace.
    const otherPass = await learningPass(teamA, ids.other, theirs);
    await candidate(teamA, otherPass, "OTHER-PERSON candidate");
    const ownB = await thread(teamB, ids.member);
    await candidate(teamB, await learningPass(teamB, ids.member, ownB), "TEAM-B candidate");

    await h.admin.query(
      `INSERT INTO memory_dismissals (team_id, thread_id, user_id, statement_hash)
       VALUES ($1, $2, $3, repeat('d', 64)), ($1, $4, $5, repeat('e', 64))`,
      [teamA, own, ids.member, theirs, ids.other],
    );
    await h.admin.query(
      `INSERT INTO memory_learning_watermarks (team_id, thread_id, user_id, entry_id)
       VALUES ($1, $2, $3, 'a1')`,
      [teamA, own, ids.member],
    );
    const { rows: props } = await h.admin.query<{ id: string }>(
      `INSERT INTO memory_proposals (team_id, source, candidate_ref, statement, kind, rationale,
         proposer_id, state, decided_by, decided_at, reason, expires_at)
       VALUES ($1, 'candidate', $2, 'Proposed by me.', 'fact', 'My note.', $3, 'rejected', $4,
               now(), 'Already covered.', now() + interval '20 days'),
              ($1, 'candidate', NULL, 'Waiting too long.', 'fact', NULL, $3, 'pending', NULL,
               NULL, NULL, now() - interval '1 day'),
              ($1, 'candidate', NULL, 'OTHER-PERSON proposal', 'fact', NULL, $5, 'pending', NULL,
               NULL, NULL, now() + interval '20 days')
       RETURNING id`,
      [teamA, cand, ids.member, ids.curator, ids.other],
    );
    const { rows: suggs } = await h.admin.query<{ id: string }>(
      `INSERT INTO memory_project_suggestions (team_id, project_id, thread_id, statement, kind,
         evidence, suggested_by)
       VALUES ($1, $2, $3, 'Use pnpm here.', 'convention', $4, $5),
              ($1, $2, $6, 'OTHER-PERSON suggestion', 'convention', $4, $7)
       RETURNING id`,
      [teamA, project, own, JSON.stringify(EVIDENCE), ids.member, theirs, ids.other],
    );

    const { raw, learning } = await download(member, teamA);
    for (const text of [
      "OTHER-PERSON",
      "TEAM-B",
      "ASSISTANT-TEXT",
      "PARAPHRASED",
      ids.other,
      ids.curator,
      theirs,
    ])
      expect(raw).not.toContain(text);

    expect(learning.passes.map((p) => p.id).sort()).toEqual([pass, foreignPass].sort());
    expect(learning.passes.find((p) => p.id === pass)).toMatchObject({
      thread_id: own,
      status: "completed",
      model_alias: "learner",
    });
    expect(learning.passes.find((p) => p.id === foreignPass)?.thread_id).toBeNull();

    const byId = new Map(learning.candidates.map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual([cand, foreign].sort());
    expect(byId.get(cand)).toMatchObject({
      pass_id: pass,
      state: "expired",
      statement: "We deploy from main.",
      rationale: "The person said so.",
      evidence: [{ entry_id: "u1", quote: "We deploy from main" }],
    });
    expect(byId.get(cand)).not.toHaveProperty("near_duplicates");
    expect(byId.get(foreign)?.evidence).toEqual([]);

    expect(learning.dismissals).toEqual([
      { thread_id: own, statement_hash: "d".repeat(64), created_at: expect.any(String) },
    ]);
    expect(learning.watermarks).toEqual([
      { thread_id: own, entry_id: "a1", updated_at: expect.any(String) },
    ]);

    const proposals = new Map(learning.proposals.map((p) => [p.id, p]));
    expect(proposals.size).toBe(2);
    expect(proposals.get(props[0]?.id ?? "")).toMatchObject({
      statement: "Proposed by me.",
      rationale: "My note.",
      state: "rejected",
      reason: "Already covered.",
    });
    expect(proposals.get(props[0]?.id ?? "")).not.toHaveProperty("decided_by");
    expect(proposals.get(props[1]?.id ?? "")?.state).toBe("expired");

    expect(learning.suggestions).toEqual([
      expect.objectContaining({
        id: suggs[0]?.id,
        project_id: project,
        thread_id: own,
        statement: "Use pnpm here.",
        state: "pending",
        evidence: [{ entry_id: "u1", quote: "We deploy from main" }],
      }),
    ]);
  });
});
