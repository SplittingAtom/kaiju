import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSessionKeyPair } from "@kobe/session-token";
import { EventStreamFixture, PUBLIC_URL, type Person } from "../testing/event-stream-fixture.js";
import { TestBrowser } from "../testing/browser.js";
import { MemoryObjects } from "../testing/memory-objects.js";
import { conceptVector } from "../testing/fake-embeddings.js";
import { STATE_TTL_MS } from "./embeddings/service.js";

/**
 * KOBE-787 (review pass 2, P2-47): a new embedding model saved while a vector build runs is built
 * all the same (the running job carries on with the new model), and every replica drops its
 * cached model when the setting changes (Postgres NOTIFY on the shared listener, no Redis), not
 * only the replica that saved it.
 */
const PAIR = generateSessionKeyPair();
const MODEL_A = "kobe-local/test-embed-a";
const MODEL_B = "kobe-local/test-embed-b";
const fx = new EventStreamFixture();

let hold: Promise<void> | undefined;
const gateway = (async (_url: string | URL, init?: RequestInit) => {
  if (hold) await hold;
  const body = JSON.parse(String(init?.body)) as { input: string[] };
  const data = body.input.map((t, index) => ({ index, embedding: conceptVector(t) }));
  return new Response(JSON.stringify({ data }), { status: 200 });
}) as typeof fetch;

let admin: Person;
let team: string;

beforeAll(async () => {
  await fx.setup([{}, {}], () => ({
    models: { providerKeySecrets: ["p".repeat(40)] },
    blobs: { objects: new MemoryObjects(), prefix: "kobe/" },
    serverCalls: { gatewayUrl: "http://gateway.test", key: PAIR.signing, fetch: gateway },
    embeddings: { localModel: "kobe-local/nomic-embed-text", gatewaySyncWaitMs: 0 },
  }));
  const email = `vmc-adm-${randomUUID().slice(0, 6)}@events.test`;
  const { id } = await fx
    .replica(0)
    .deps.createUserWithPassword(
      { email, name: "vmc", password: "a long enough password" },
      { siteRole: "admin" },
    );
  const browser = new TestBrowser(fx.replica(0).app, PUBLIC_URL);
  expect(
    (await browser.post("/api/auth/sign-in/email", { email, password: "a long enough password" }))
      .status,
  ).toBe(200);
  admin = { id, email, browser };
  team = await fx.team(`vmc-${randomUUID().slice(0, 6)}`, admin);
  await fx.activate(admin, team);
});
afterAll(() => fx.teardown());

const setModel = (model: string | null) =>
  admin.browser.put("/v1/memory/settings?level=site", { settings: { embedding_model: model } });
const idle = async () => {
  await fx.replica(0).deps.background.idle();
  await fx.replica(1).deps.background.idle();
};

describe("embedding model changes (KOBE-787, P2-47)", () => {
  it("every replica drops its cached model when the setting changes", async () => {
    expect((await setModel(MODEL_A)).status).toBe(200);
    await idle();
    const other = fx.replica(1).deps.memoryEmbeddings;
    await vi.waitFor(async () => expect(await other.usableModel()).toBe(MODEL_A), {
      timeout: STATE_TTL_MS / 2,
    });
    expect((await setModel(MODEL_B)).status).toBe(200);
    // Well inside the cache's lifetime: only the change hint can make replica 1 read it again.
    await vi.waitFor(async () => expect(await other.usableModel()).toBe(MODEL_B), {
      timeout: STATE_TTL_MS / 3,
      interval: 50,
    });
    await idle();
    expect((await setModel(null)).status).toBe(200);
    await idle();
  });

  it("a model saved while a build runs is built: the running job carries on with it", async () => {
    const ids: string[] = [];
    for (const statement of ["I drive an electric car", "Invoices are due monthly"]) {
      const res = await admin.browser.post("/v1/memory/semantic/items", {
        scope: "user",
        kind: "fact",
        statement: `${statement} ${randomUUID()}`,
      });
      expect(res.status).toBe(201);
      ids.push((res.json as { id: string }).id);
    }
    await idle();
    let release!: () => void;
    hold = new Promise<void>((resolve) => (release = resolve));
    // Model A's build starts and waits in its first gateway call.
    expect((await setModel(MODEL_A)).status).toBe(200);
    // Model B while it runs: the start is refused (already running) on whichever replica.
    expect((await setModel(MODEL_B)).status).toBe(200);
    hold = undefined;
    release();
    await vi.waitFor(
      async () => {
        await idle();
        const res = await fx.admin.query<{ embedding_model: string | null }>(
          `SELECT v.embedding_model FROM semantic_memory_item_versions v
             JOIN semantic_memory_items i ON i.id = v.item_id AND v.version = i.current_version
            WHERE i.id = ANY($1::uuid[])`,
          [ids],
        );
        expect(res.rows.map((r) => r.embedding_model)).toEqual([MODEL_B, MODEL_B]);
      },
      { timeout: 15_000, interval: 200 },
    );
    const state = (await admin.browser.get("/v1/memory/vectors")).json as {
      job: { state: string; model: string };
    };
    expect(state.job).toMatchObject({ state: "done", model: MODEL_B });
  });
});
