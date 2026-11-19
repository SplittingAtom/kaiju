import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SERVER_CALL_TOKEN_HEADER } from "@kobe/protocol";
import { generateSessionKeyPair, verifyServerCallToken } from "@kobe/session-token";
import { EventStreamFixture, PUBLIC_URL, type Person } from "./testing/event-stream-fixture.js";
import { TestBrowser } from "./testing/browser.js";
import { MemoryObjects } from "./testing/memory-objects.js";
import { MEMORY_SITE_SETTINGS_KEY } from "./memory/site-settings.js";
import { conceptVector } from "./testing/fake-embeddings.js";
import { MEMORY_VECTOR_BUILD_LOCK } from "./memory/embeddings/backfill.js";

/**
 * KOBE-669: the embedding model is a Site setting, so saving it (and Build vectors) builds vectors
 * for every Workspace and the Site/portable items even when the Site admin has no active
 * Workspace. Then each Workspace pays for its own items (the admin when a member, else its
 * earliest Team admin) and the Site/portable items are paid by the admin in their earliest
 * Workspace. A Workspace at 100 % is skipped, the others still build.
 */
const PAIR = generateSessionKeyPair();
const MODEL = "kobe-local/test-embed";
const fx = new EventStreamFixture();

interface Call {
  readonly claims: Record<string, unknown>;
  readonly inputs: string[];
}
const calls: Call[] = [];
let refuseTeam: string | undefined;

const gateway = (async (_url: string | URL, init?: RequestInit) => {
  const headers = init?.headers as Record<string, string>;
  const verified = verifyServerCallToken(
    PAIR.verify,
    headers[SERVER_CALL_TOKEN_HEADER],
    Math.floor(Date.now() / 1000),
  );
  const claims = verified.ok ? (verified.claims as unknown as Record<string, unknown>) : {};
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  calls.push({ claims, inputs: body.input });
  if (refuseTeam !== undefined && claims.team_id === refuseTeam) {
    return new Response(JSON.stringify({ error: { code: "budget_exhausted" } }), { status: 429 });
  }
  const data = body.input.map((t, index) => ({ index, embedding: conceptVector(t) }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

let siteAdmin: Person & { readonly id: string };
let alice: Person;
let bob: Person;
let teamA: string;
let teamB: string;
let item: Record<string, string> = {};

async function seed(o: {
  scope: "team" | "portable" | "site";
  statement: string;
  team?: string;
  owner: string;
}): Promise<string> {
  const id = randomUUID();
  await fx.admin.query("BEGIN");
  try {
    if (o.scope === "team") {
      await fx.admin.query(
        `INSERT INTO semantic_memory_items (team_id, id, scope, kind) VALUES ($1, $2, 'team', 'fact')`,
        [o.team, id],
      );
      await fx.admin.query(
        `INSERT INTO semantic_memory_item_versions (team_id, item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, $2, 1, $3, $4, 'user')`,
        [o.team, id, o.statement, o.owner],
      );
    } else if (o.scope === "portable") {
      await fx.admin.query(
        `INSERT INTO portable_memory_items (id, owner_user_id, kind) VALUES ($1, $2, 'preference')`,
        [id, o.owner],
      );
      await fx.admin.query(
        `INSERT INTO portable_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, o.owner],
      );
    } else {
      await fx.admin.query(`INSERT INTO site_memory_items (id, kind) VALUES ($1, 'fact')`, [id]);
      await fx.admin.query(
        `INSERT INTO site_memory_item_versions (item_id, version, statement, actor_user_id, actor_kind)
         VALUES ($1, 1, $2, $3, 'user')`,
        [id, o.statement, o.owner],
      );
    }
    await fx.admin.query("COMMIT");
  } catch (err) {
    await fx.admin.query("ROLLBACK");
    throw err;
  }
  return id;
}

/** Each seeded item's stored embedding model (null: no vector). */
async function models(): Promise<Record<string, string | null>> {
  const res = await fx.admin.query<{ item_id: string; embedding_model: string | null }>(
    `SELECT item_id, embedding_model FROM semantic_memory_item_versions
     UNION ALL SELECT item_id, embedding_model FROM portable_memory_item_versions
     UNION ALL SELECT item_id, embedding_model FROM site_memory_item_versions`,
  );
  const byId = new Map(res.rows.map((r) => [r.item_id, r.embedding_model]));
  return Object.fromEntries(Object.entries(item).map(([k, id]) => [k, byId.get(id) ?? null]));
}

/** Who paid for each seeded statement: `team_id:user_id`. */
function payers(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of calls) {
    for (const input of c.inputs)
      out[input] = `${String(c.claims.team_id)}:${String(c.claims.user_id)}`;
  }
  return out;
}

beforeAll(async () => {
  await fx.setup([{}], () => ({
    blobs: { objects: new MemoryObjects(), prefix: "kobe/" },
    serverCalls: { gatewayUrl: "http://gateway.test", key: PAIR.signing, fetch: gateway },
    embeddings: { localModel: "kobe-local/nomic-embed-text", gatewaySyncWaitMs: 0 },
  }));
  const email = `vec-site-${randomUUID().slice(0, 6)}@events.test`;
  const { id } = await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "vs", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const browser = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  expect(
    (await browser.post("/api/auth/sign-in/email", { email, password: "a long enough password" }))
      .status,
  ).toBe(200);
  siteAdmin = { id, email, browser };
  alice = await fx.person("vec-alice");
  bob = await fx.person("vec-bob");
  // The Site admin is a plain member of A (never activated) and not in B.
  teamA = await fx.team(`vsa-${randomUUID().slice(0, 6)}`, alice);
  teamB = await fx.team(`vsb-${randomUUID().slice(0, 6)}`, bob);
  await fx.addMember(teamA, siteAdmin);
});
afterAll(() => fx.teardown());
afterEach(async () => {
  refuseTeam = undefined;
  calls.length = 0;
  item = {};
  await fx.admin.query(`DELETE FROM site_settings WHERE key = $1`, [MEMORY_SITE_SETTINGS_KEY]);
  fx.replica(0).deps.memoryEmbeddings.invalidate();
});

async function seedAll(tag: string): Promise<void> {
  item.a = await seed({ scope: "team", team: teamA, owner: alice.id, statement: `${tag} A fact` });
  item.b = await seed({ scope: "team", team: teamB, owner: bob.id, statement: `${tag} B fact` });
  item.site = await seed({ scope: "site", owner: siteAdmin.id, statement: `${tag} Site fact` });
  item.portable = await seed({ scope: "portable", owner: alice.id, statement: `${tag} Mine` });
}

const setModel = (model: string | null) =>
  siteAdmin.browser.put("/v1/memory/settings?level=site", {
    settings: { embedding_model: model },
  });

describe("Site-wide vector build without an active Workspace (KOBE-669)", () => {
  it("saving the model builds every Workspace and the Site/portable items", async () => {
    await seedAll("one");
    expect(siteAdmin.browser.team).toBeUndefined();
    const res = await setModel(MODEL);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await fx.replica(0).deps.background.idle();
    expect(await models()).toEqual({ a: MODEL, b: MODEL, site: MODEL, portable: MODEL });
    expect(payers()).toEqual({
      "one A fact": `${teamA}:${siteAdmin.id}`,
      "one B fact": `${teamB}:${bob.id}`,
      "one Site fact": `${teamA}:${siteAdmin.id}`,
      "one Mine": `${teamA}:${siteAdmin.id}`,
    });
    const state = (await siteAdmin.browser.get("/v1/memory/vectors")).json as {
      coverage: { embedded: number; total: number };
      job: { state: string; embedded: number; teamId: string | null };
      running_elsewhere: boolean;
    };
    expect(state.job).toMatchObject({ state: "done", embedded: 4, teamId: null });
    expect(state.coverage).toEqual({ embedded: 4, total: 4 });
    expect(state.running_elsewhere).toBe(false);
  });

  it("a second save or Build vectors does not run it twice", async () => {
    await seedAll("two");
    const [first, second] = await Promise.all([setModel(MODEL), setModel(MODEL)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    await fx.replica(0).deps.background.idle();
    expect(await models()).toEqual({ a: MODEL, b: MODEL, site: MODEL, portable: MODEL });
    const inputs = calls.flatMap((c) => c.inputs).sort();
    expect(inputs).toEqual(["two A fact", "two B fact", "two Mine", "two Site fact"]);
    // Saving again, or the console's action, embeds nothing more.
    calls.length = 0;
    expect((await setModel(MODEL)).status).toBe(200);
    const again = await siteAdmin.browser.post("/v1/memory/vectors/build", {});
    expect(again.status, JSON.stringify(again.json)).toBe(202);
    await fx.replica(0).deps.background.idle();
    expect(calls).toEqual([]);
  });

  it("Build vectors without an active Workspace starts the Site-wide build", async () => {
    expect((await setModel(MODEL)).status).toBe(200);
    await fx.replica(0).deps.background.idle();
    await seedAll("three");
    const res = await siteAdmin.browser.post("/v1/memory/vectors/build", {});
    expect(res.status, JSON.stringify(res.json)).toBe(202);
    await fx.replica(0).deps.background.idle();
    expect(await models()).toEqual({ a: MODEL, b: MODEL, site: MODEL, portable: MODEL });
  });

  it("a Workspace at 100 % is skipped; the others still build", async () => {
    await seedAll("four");
    refuseTeam = teamB;
    expect((await setModel(MODEL)).status).toBe(200);
    await fx.replica(0).deps.background.idle();
    expect(await models()).toEqual({ a: MODEL, b: null, site: MODEL, portable: MODEL });
    const state = (await siteAdmin.browser.get("/v1/memory/vectors")).json as {
      job: { state: string; stopReason: string | null };
    };
    expect(state.job).toMatchObject({ state: "stopped", stopReason: "budget" });
  });

  it("the console shows a build another replica runs", async () => {
    expect((await setModel(MODEL)).status).toBe(200);
    await fx.replica(0).deps.background.idle();
    await fx.admin.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      MEMORY_VECTOR_BUILD_LOCK,
    ]);
    try {
      const state = (await siteAdmin.browser.get("/v1/memory/vectors")).json as {
        running_elsewhere: boolean;
      };
      expect(state.running_elsewhere).toBe(true);
    } finally {
      await fx.admin.query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [
        MEMORY_VECTOR_BUILD_LOCK,
      ]);
    }
  });
});
