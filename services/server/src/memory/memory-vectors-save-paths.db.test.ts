import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SERVER_CALL_TOKEN_HEADER } from "@kaiju/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kaiju/session-token";
import {
  EventStreamFixture,
  must,
  PUBLIC_URL,
  type Person,
} from "../testing/event-stream-fixture.js";
import { TestBrowser } from "../testing/browser.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { conceptVector } from "../testing/fake-embeddings.js";
import { statementHash } from "./learn/validate.js";

/**
 * KOBE-779 (review pass 2, P2-5): every write path of the item store requests a vector after its
 * commit, not only the item routes: To review Save and Undo, and a curator's approval of a
 * proposal. A refused embedding never fails or rolls back the save (the build catches it later).
 */
const PAIR = generateSessionKeyPair();
const MODEL = "kobe-local/test-embed";
const fx = new EventStreamFixture();
let refuse: string | undefined;
let calls = 0;

const gateway = (async (_url: string | URL, init?: RequestInit) => {
  const headers = init?.headers as Record<string, string>;
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER],
    Math.floor(Date.now() / 1000),
  );
  expect(verified.ok).toBe(true);
  calls += 1;
  if (refuse) return new Response(JSON.stringify({ error: { code: refuse } }), { status: 429 });
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  const data = body.input.map((t, index) => ({ index, embedding: conceptVector(t) }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

let admin: Person;
let member: Person;
let team: string;

beforeAll(async () => {
  await fx.setup([{}], () => ({
    models: { providerKeySecrets: ["p".repeat(40)] },
    blobs: { objects: new MemoryObjects(), prefix: "kaiju/" },
    serverCalls: { gatewayUrl: "http://gateway.test", key: PAIR.signing, fetch: gateway },
    embeddings: { localModel: "kobe-local/nomic-embed-text", gatewaySyncWaitMs: 0 },
  }));
  const email = `vsp-adm-${randomUUID().slice(0, 6)}@events.test`;
  const { id } = await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "vsp", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const browser = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  expect(
    (await browser.post("/api/auth/sign-in/email", { email, password: "a long enough password" }))
      .status,
  ).toBe(200);
  admin = { id, email, browser };
  member = await fx.person("vsp-mem");
  team = await fx.team(`vsp-${randomUUID().slice(0, 6)}`, admin, [member]);
  await fx.activate(admin, team);
  await fx.activate(member, team);
  const set = await admin.browser.put("/v1/memory/settings?level=site", {
    settings: { embedding_model: MODEL },
  });
  expect(set.status, JSON.stringify(set.json)).toBe(200);
  await idle();
});
afterAll(() => fx.teardown());
afterEach(() => {
  refuse = undefined;
});

const idle = () => fx.replica(0).deps.background.idle();
const REVIEW = "/v1/memory/review";
const ITEMS = "/v1/memory/semantic/items";

async function vectorOf(itemId: string, version?: number) {
  const res = await fx.admin.query<{ embedding_model: string | null; version: number }>(
    `SELECT v.embedding_model, v.version FROM semantic_memory_item_versions v
       JOIN semantic_memory_items i ON i.id = v.item_id
      WHERE v.item_id = $1 AND v.version = coalesce($2, i.current_version)`,
    [itemId, version ?? null],
  );
  return res.rows[0]?.embedding_model ?? null;
}

const msg = (role: string, text: string) =>
  JSON.stringify({ message: { role, content: [{ type: "text", text }] } });

/** A thread of `owner` with one completed pass; returns the pass id. */
async function passOf(owner: string): Promise<{ threadId: string; passId: string }> {
  const threadId = randomUUID();
  await fx.admin.query(`INSERT INTO threads (team_id, id, owner_user_id) VALUES ($1, $2, $3)`, [
    team,
    threadId,
    owner,
  ]);
  await fx.admin.query(
    `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload)
     VALUES ($1, $2, 'u1', NULL, 'message', $3)`,
    [team, threadId, msg("user", "I drive an electric car to work.")],
  );
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO memory_learning_passes (team_id, thread_id, user_id, branch_leaf_entry_id,
       to_entry_id, model_alias, prompt_version, status, started_at, finished_at)
     VALUES ($1, $2, $3, 'u1', 'u1', 'learner', 'v1', 'completed', now(), now()) RETURNING id`,
    [team, threadId, owner],
  );
  return { threadId, passId: must(rows[0], "pass").id };
}

let ord = 0;
async function candidate(
  passId: string,
  seed: { statement: string; destination?: string; operation?: string; target_id?: string },
): Promise<string> {
  const destination = seed.destination ?? "user";
  ord += 1;
  const { rows } = await fx.admin.query<{ id: string }>(
    `INSERT INTO memory_candidates (team_id, pass_id, ord, payload) VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      team,
      passId,
      ord,
      JSON.stringify({
        statement: seed.statement,
        kind: "fact",
        destination,
        suggested_scope: destination === "team" ? "team" : "user",
        portable: false,
        project_specific: false,
        source: "stated",
        operation: seed.operation ?? "add",
        target_id: seed.target_id ?? null,
        confidence: 0.9,
        rationale: "Said so.",
        evidence: [{ entry_id: "u1", quote: "I drive an electric car to work." }],
        statement_hash: statementHash(seed.statement),
        warnings: [],
        policy_conflicts: [],
        near_duplicates: [],
        prompt_version: "v1",
      }),
    ],
  );
  return must(rows[0], "candidate").id;
}

describe("every save path gets a vector (KOBE-779 ac-1)", () => {
  it("To review Save (a new memory and an update) and Undo embed after commit", async () => {
    const { passId } = await passOf(member.id);
    const add = await candidate(passId, { statement: `My car is electric ${randomUUID()}` });
    const saved = await member.browser.post(`${REVIEW}/candidates/${add}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const created = (saved.json as { item: { id: string } }).item.id;
    await idle();
    expect(await vectorOf(created)).toBe(MODEL);

    const upd = await candidate(passId, {
      statement: `My electric car parks in the garage ${randomUUID()}`,
      operation: "update",
      target_id: created,
    });
    const updated = await member.browser.post(`${REVIEW}/candidates/${upd}/save`, {});
    expect(updated.status, JSON.stringify(updated.json)).toBe(200);
    await idle();
    expect(await vectorOf(created, 2)).toBe(MODEL);

    // Undo of the update writes version 3 (a copy of version 1): embedded too.
    const undo = await member.browser.post(`${REVIEW}/undo`, { candidate_ids: [upd] });
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    await idle();
    expect(await vectorOf(created, 3)).toBe(MODEL);
  });

  it("a curator's approval of a Workspace proposal embeds the new item", async () => {
    const { passId } = await passOf(member.id);
    const c = await candidate(passId, {
      statement: `We park cars in the garage ${randomUUID()}`,
      destination: "team",
    });
    const proposed = await member.browser.post(`${REVIEW}/candidates/${c}/propose`, {});
    expect(proposed.status, JSON.stringify(proposed.json)).toBe(201);
    const proposalId = (proposed.json as { proposal_id: string }).proposal_id;
    const approved = await admin.browser.post(`/v1/memory/proposals/${proposalId}/approve`, {});
    expect(approved.status, JSON.stringify(approved.json)).toBe(200);
    await idle();
    expect(await vectorOf((approved.json as { item: { id: string } }).item.id)).toBe(MODEL);
  });

  it("a refused embedding keeps the save; Build vectors embeds it later", async () => {
    const { passId } = await passOf(member.id);
    const c = await candidate(passId, { statement: `I commute by car ${randomUUID()}` });
    refuse = "upstream_error";
    const saved = await member.browser.post(`${REVIEW}/candidates/${c}/save`, {});
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const id = (saved.json as { item: { id: string } }).item.id;
    await idle();
    expect(await vectorOf(id)).toBeNull();
    const got = await member.browser.get(`${ITEMS}/user/${id}`);
    expect(got.status).toBe(200);
    refuse = undefined;
    calls = 0;
    expect((await admin.browser.post("/v1/memory/vectors/build", {})).status).toBe(202);
    await idle();
    expect(calls).toBeGreaterThan(0);
    expect(await vectorOf(id)).toBe(MODEL);
  });
});
