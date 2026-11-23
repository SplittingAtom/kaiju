import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql, withTeam } from "@kobe/db";
import { SERVER_CALL_TOKEN_HEADER } from "@kobe/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import { EventStreamFixture, PUBLIC_URL, type Person } from "../testing/event-stream-fixture.js";
import { TestBrowser } from "../testing/browser.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { MEMORY_SITE_SETTINGS_KEY } from "./site-settings.js";
import { readVectorSupport } from "./embeddings/vector-support.js";
import { conceptVector } from "../testing/fake-embeddings.js";
import { buildRunSemantic, readRunCandidates } from "./items/run-memory.js";
import { startVectorLeg } from "./items/vector-leg.js";
import { MEMORY_VECTOR_BUILD_LOCK } from "./embeddings/backfill.js";
import { readMemory } from "./agent.js";
import type { Logger } from "pino";

/**
 * KOBE-409: the Site embedding model, embed on save, Build vectors and the Site console's state,
 * against a database with pgvector (the test server has it) and a fake gateway that embeds by
 * concept words. Billing: a save is paid by the saver in the Workspace they act in (no run); a
 * build by the Site admin in their active Workspace. A refusal never fails the save.
 */
const PAIR = generateSessionKeyPair();
const MODEL = "kobe-local/test-embed";
const fx = new EventStreamFixture();

interface Call {
  readonly claims: Record<string, unknown>;
  readonly inputs: string[];
}
const calls: Call[] = [];
let refuse: string | undefined;

const gateway = (async (url: string | URL, init?: RequestInit) => {
  expect(String(url)).toBe("http://gateway.test/v1/embeddings");
  const headers = init?.headers as Record<string, string>;
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER],
    Math.floor(Date.now() / 1000),
  );
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  calls.push({
    claims: verified.ok ? (verified.claims as unknown as Record<string, unknown>) : {},
    inputs: body.input,
  });
  if (refuse) return new Response(JSON.stringify({ error: { code: refuse } }), { status: 429 });
  const data = body.input.map((t, index) => ({ index, embedding: conceptVector(t) }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

let admin: Person & { readonly id: string };
let member: Person;
let team: string;

/** Bifrost's model listing (KOBE-409 L3): `openai` lists its models; `kobe-local` none. */
const discovery = {
  listKeys: async () => [],
  listModelInfo: async (provider: string) =>
    provider === "openai"
      ? ["openai/gpt-fake", "openai/text-embedding-3-small"].map((name) => ({
          name,
          inputModalities: [],
        }))
      : [],
  refreshModels: async () => undefined,
};

beforeAll(async () => {
  await fx.setup([{}], () => ({
    models: { providerKeySecrets: ["p".repeat(40)], discovery },
    blobs: { objects: new MemoryObjects(), prefix: "kobe/" },
    serverCalls: { gatewayUrl: "http://gateway.test", key: PAIR.signing, fetch: gateway },
    embeddings: { localModel: "kobe-local/nomic-embed-text", gatewaySyncWaitMs: 0 },
  }));
  const email = `vec-adm-${randomUUID().slice(0, 6)}@events.test`;
  const { id } = await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "va", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const browser = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  expect(
    (await browser.post("/api/auth/sign-in/email", { email, password: "a long enough password" }))
      .status,
  ).toBe(200);
  admin = { id, email, browser };
  member = await fx.person("vec-mem");
  team = await fx.team(`vec-${randomUUID().slice(0, 6)}`, admin, [member]);
  await fx.activate(admin, team);
  await fx.activate(member, team);
});
afterAll(() => fx.teardown());
afterEach(async () => {
  refuse = undefined;
  calls.length = 0;
  await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [MEMORY_SITE_SETTINGS_KEY]);
  fx.replica(0).deps.memoryEmbeddings.invalidate();
});

const setModel = (model: string | null) =>
  admin.browser.put("/v1/memory/settings?level=site", { settings: { embedding_model: model } });

async function vectorOf(itemId: string) {
  const res = await fx.admin.query(
    `SELECT embedding_model, embedding_dims FROM semantic_memory_item_versions WHERE item_id = $1`,
    [itemId],
  );
  return res.rows[0] as { embedding_model: string | null; embedding_dims: number | null };
}

describe("memory vectors (KOBE-409)", () => {
  it("the test database has pgvector and the embedding columns", async () => {
    expect(await readVectorSupport(fx.replica(0).deps.database.db)).toEqual({
      extension: "enabled",
      columns: true,
    });
  });

  it("the embedding model names a gateway provider; an unknown one is refused", async () => {
    const bad = await setModel("nowhere/model");
    expect([bad.status, (bad.json as { code: string }).code]).toEqual([
      400,
      "unknown_embedding_provider",
    ]);
    const ok = await setModel(MODEL);
    expect(ok.status).toBe(200);
    expect((ok.json as { settings: { embedding_model: string } }).settings.embedding_model).toBe(
      MODEL,
    );
    const state = await admin.browser.get("/v1/memory/vectors");
    expect(state.json).toMatchObject({
      pgvector: "enabled",
      columns: true,
      model: MODEL,
      model_state: "ok",
      local_model: "kobe-local/nomic-embed-text",
      server_calls: true,
    });
    expect((state.json as { providers: string[] }).providers).toContain("kobe-local");
  });

  it("the embedding model is no chat catalog model and is one its provider lists (review L3)", async () => {
    await fx.admin.query(
      `INSERT INTO model_providers (id, kind, name, api_key_enc, created_by)
       VALUES ('openai', 'openai', 'openai', 'v2.test.sealed-provider-key', $1)
       ON CONFLICT (id) DO NOTHING`,
      [admin.id],
    );
    await fx.admin.query(
      `INSERT INTO model_catalog (alias, provider_id, model, created_by)
       VALUES ('vec-chat', 'openai', 'gpt-fake', $1) ON CONFLICT (alias) DO NOTHING`,
      [admin.id],
    );
    const code = async (model: string) => {
      const res = await setModel(model);
      return [res.status, (res.json as { code?: string }).code ?? null];
    };
    expect(await code("openai/gpt-fake")).toEqual([400, "embedding_is_chat_model"]);
    expect(await code("openai/not-a-model")).toEqual([400, "unknown_embedding_model"]);
    expect(await code("openai/text-embedding-3-small")).toEqual([200, null]);
    // A provider without a model list (keyless, no discovery): accepted as typed.
    expect(await code(MODEL)).toEqual([200, null]);
    await fx.replica(0).deps.background.idle();
  });

  it("embeds on save, paid by the saver in their Workspace; a budget refusal keeps the save", async () => {
    await setModel(MODEL);
    await fx.replica(0).deps.background.idle();
    calls.length = 0;
    const res = await member.browser.post("/v1/memory/semantic/items", {
      scope: "user",
      kind: "fact",
      statement: "I drive an electric car to work",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    const id = (res.json as { id: string }).id;
    await fx.replica(0).deps.background.idle();
    expect(await vectorOf(id)).toEqual({ embedding_model: MODEL, embedding_dims: 6 });
    expect(calls[0]?.claims).toMatchObject({
      purpose: "memory_embed",
      team_id: team,
      user_id: member.id,
      model: MODEL,
    });
    expect(calls[0]?.claims.run_id).toBeUndefined();

    refuse = "budget_exhausted";
    const refused = await member.browser.post("/v1/memory/semantic/items", {
      scope: "user",
      kind: "fact",
      statement: "My invoices are due monthly",
    });
    expect(refused.status).toBe(201);
    await fx.replica(0).deps.background.idle();
    expect(await vectorOf((refused.json as { id: string }).id)).toEqual({
      embedding_model: null,
      embedding_dims: null,
    });
  });

  it("Build vectors embeds what is missing, paid by the admin; coverage counts it", async () => {
    // Saved before any model was set: no vector yet.
    const res = await member.browser.post("/v1/memory/semantic/items", {
      scope: "user",
      kind: "fact",
      statement: "It rains a lot in spring",
    });
    expect(res.status).toBe(201);
    await fx.replica(0).deps.background.idle();
    expect(calls).toEqual([]);
    // Saving the model starts the build (the admin pays, in their active Workspace).
    expect((await setModel(MODEL)).status).toBe(200);
    await fx.replica(0).deps.background.idle();
    expect(await vectorOf((res.json as { id: string }).id)).toMatchObject({
      embedding_model: MODEL,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.claims).toMatchObject({ team_id: team, user_id: admin.id });
    const state = (await admin.browser.get("/v1/memory/vectors")).json as {
      coverage: { embedded: number; total: number };
      job: { state: string; embedded: number };
    };
    expect(state.coverage.embedded).toBe(state.coverage.total);
    expect(state.job.state).toBe("done");
    // Again: nothing is missing, so no call; the action answers 202 all the same.
    calls.length = 0;
    const again = await admin.browser.post("/v1/memory/vectors/build", {});
    expect(again.status).toBe(202);
    await fx.replica(0).deps.background.idle();
    expect(calls).toEqual([]);
  });

  it("Build vectors runs on one replica at a time (advisory lock, review L6)", async () => {
    expect((await setModel(MODEL)).status).toBe(200);
    await fx.replica(0).deps.background.idle();
    // Another replica's job holds the lock: this one says it is already running.
    await fx.admin.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      MEMORY_VECTOR_BUILD_LOCK,
    ]);
    try {
      const busy = await admin.browser.post("/v1/memory/vectors/build", {});
      expect([busy.status, (busy.json as { code: string }).code]).toEqual([409, "running"]);
    } finally {
      await fx.admin.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
        MEMORY_VECTOR_BUILD_LOCK,
      ]);
    }
    const free = await admin.browser.post("/v1/memory/vectors/build", {});
    expect(free.status).toBe(202);
    await fx.replica(0).deps.background.idle();
  });

  it("Build vectors is unavailable without a model", async () => {
    const res = await admin.browser.post("/v1/memory/vectors/build", {});
    expect([res.status, (res.json as { code: string }).code]).toEqual([400, "unavailable"]);
    const state = (await admin.browser.get("/v1/memory/vectors")).json as Record<string, unknown>;
    expect(state).toMatchObject({ model: null, model_state: "no_model" });
  });

  it("hybrid selection finds a similar item with no shared word; late vectors mean keywords only", async () => {
    await setModel(MODEL);
    const res = await member.browser.post("/v1/memory/semantic/items", {
      scope: "user",
      kind: "fact",
      statement: "My automobile is parked in garage B",
    });
    expect(res.status).toBe(201);
    const id = (res.json as { id: string }).id;
    await fx.replica(0).deps.background.idle();
    expect((await vectorOf(id)).embedding_model).toBe(MODEL);
    const runId = await fx.run(team, member);
    const [row] = (await fx.admin.query(`SELECT thread_id FROM runs WHERE id = $1`, [runId]))
      .rows as { thread_id: string }[];
    const db = fx.replica(0).deps.database.db;
    const message = "Where should I leave the car tomorrow?";
    const base = {
      teamId: team,
      userId: member.id,
      threadId: row?.thread_id ?? "",
      runId,
      message,
    };
    const keywordOnly = await withTeam(db, team, (tx) => buildRunSemantic(tx, base));
    expect(keywordOnly?.semantic.items.map((i) => i.id) ?? []).not.toContain(id);
    const who = { teamId: team, userId: member.id };
    const leg = (model: string) =>
      startVectorLeg(db, who, Promise.resolve({ model, vector: conceptVector(message) }), 5000);
    const hybrid = await withTeam(db, team, (tx) =>
      buildRunSemantic(tx, { ...base, vectorLeg: () => leg(MODEL) }),
    );
    expect(hybrid?.semantic.items.map((i) => i.id)).toContain(id);
    // No lane (Policy only, or memories off): the leg never starts, so no embedding is paid for.
    let started = false;
    await withTeam(db, team, (tx) =>
      buildRunSemantic(tx, {
        ...base,
        policyOnly: true,
        vectorLeg: () => {
          started = true;
          return leg(MODEL);
        },
      }),
    );
    expect(started).toBe(false);
    // A vector of another model (or dimension count) finds nothing extra.
    const mismatch = await withTeam(db, team, (tx) =>
      buildRunSemantic(tx, { ...base, vectorLeg: () => leg("kobe-local/other") }),
    );
    expect(mismatch?.semantic.items.map((i) => i.id) ?? []).not.toContain(id);
    // The service's query vector: paid by the run's member, naming the run.
    calls.length = 0;
    const qv = await fx.replica(0).deps.memoryEmbeddings.queryVector(base);
    expect(qv?.model).toBe(MODEL);
    expect(calls[0]?.claims).toMatchObject({ user_id: member.id, team_id: team, run_id: runId });
    const { candidates } = await withTeam(db, team, (tx) =>
      readRunCandidates(tx, {
        ...base,
        vectorLeg: () => startVectorLeg(db, who, Promise.resolve(qv), 5000),
      }),
    );
    expect(candidates.user?.find((c) => c.item.id === id)?.vector).toBeGreaterThan(0.9);
    // Review M1: started when the message is accepted (this run reads memory lanes), the
    // selection only takes the answer; one gateway call in all.
    calls.length = 0;
    const embeddings = fx.replica(0).deps.memoryEmbeddings;
    expect(await embeddings.runWantsVectors(base)).toBe(true);
    embeddings.prefetchQuery(base);
    for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 20));
    expect((await embeddings.queryVector(base))?.model).toBe(MODEL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.claims).toMatchObject({ user_id: member.id, run_id: runId });
  });

  it("recall({ query }) finds a paraphrase with no shared word; keywords alone otherwise (KOBE-664)", async () => {
    await setModel(MODEL);
    await fx.replica(0).deps.background.idle();
    const res = await member.browser.post("/v1/memory/semantic/items", {
      scope: "user",
      kind: "fact",
      statement: "My automobile sits in garage C overnight",
    });
    expect(res.status).toBe(201);
    const id = (res.json as { id: string }).id;
    await fx.replica(0).deps.background.idle();
    expect((await vectorOf(id)).embedding_model).toBe(MODEL);
    const runId = await fx.run(team, member);
    const [row] = (await fx.admin.query(`SELECT thread_id FROM runs WHERE id = $1`, [runId]))
      .rows as { thread_id: string }[];
    const quiet = { error: () => undefined } as unknown as Logger;
    const deps = {
      db: fx.replica(0).deps.database.db,
      blobs: undefined,
      log: quiet,
      embeddings: fx.replica(0).deps.memoryEmbeddings,
    };
    const ask = (query: string, d: Parameters<typeof readMemory>[0] = deps) =>
      readMemory(d, {
        teamId: team,
        userId: member.id,
        runId,
        threadId: row?.thread_id ?? "",
        input: { query },
        refused: () => undefined,
      });
    const idsOf = (r: Awaited<ReturnType<typeof readMemory>>) => {
      expect(r).toMatchObject({ ok: true, op: "read" });
      return ((r as { items?: { id: string }[] }).items ?? []).map((i) => i.id);
    };
    const paraphrase = "Where did I leave the vehicle?";
    calls.length = 0;
    expect(idsOf(await ask(paraphrase))).toContain(id);
    // ac-3: one memory_embed call, paid by the run's member in the run's Workspace.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.claims).toMatchObject({
      purpose: "memory_embed",
      team_id: team,
      user_id: member.id,
      run_id: runId,
      model: MODEL,
    });
    expect(calls[0]?.inputs).toEqual([paraphrase]);
    // ac-2: no embedder, a budget refusal or a failing gateway: keyword results, never an error.
    expect(
      idsOf(await ask(paraphrase, { db: deps.db, blobs: deps.blobs, log: deps.log })),
    ).not.toContain(id);
    for (const code of ["budget_exhausted", "upstream_error"]) {
      refuse = code;
      expect(idsOf(await ask(paraphrase))).not.toContain(id);
      expect(idsOf(await ask("automobile garage"))).toContain(id);
    }
    refuse = undefined;
    // No Site model: nothing is embedded, keywords alone.
    expect((await setModel(null)).status).toBe(200);
    fx.replica(0).deps.memoryEmbeddings.invalidate();
    calls.length = 0;
    expect(idsOf(await ask(paraphrase))).not.toContain(id);
    expect(idsOf(await ask("automobile garage"))).toContain(id);
    expect(calls).toEqual([]);
  });

  it("a member gets 403 on the Site vector routes", async () => {
    expect((await member.browser.get("/v1/memory/vectors")).status).toBe(403);
    expect((await member.browser.post("/v1/memory/vectors/build", {})).status).toBe(403);
  });

  it("vector writes stay inside the Workspace (RLS)", async () => {
    const other = await fx.team(`vec-o-${randomUUID().slice(0, 6)}`, member, []);
    const rows = await withTeam(fx.replica(0).deps.database.db, other, async (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM semantic_memory_item_versions WHERE team_id = ${team}`,
      ),
    );
    expect((rows.rows[0] as { n: number }).n).toBe(0);
  });
});
