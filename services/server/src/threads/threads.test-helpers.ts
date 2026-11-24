// Shared setup for the threads.*.db.test.ts files (split from threads.db.test.ts, KOBE-725).
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect } from "vitest";
import { createTestDatabase, testServerUrl, type TestDatabase } from "@kaiju/db/testing";
import { createApp } from "../app.js";
import { createServerDeps, type ServerDeps } from "../deps.js";
import { TestBrowser } from "../testing/browser.js";
import { MemoryMailer } from "../testing/mailer.js";
import { fakeIsolation } from "../testing/isolation.js";

// KOBE-34 Thread API against a real Postgres: own throwaway database (it needs an Owner).
export const PUBLIC_URL = "http://kaiju.test";
export const PASSWORD = "a long enough password";

export const PEOPLE = ["owner", "siteAdmin", "alice", "bob", "carol", "dave", "erin"] as const;
export type Person = (typeof PEOPLE)[number];
export const ids = Object.fromEntries(PEOPLE.map((p) => [p, ""])) as Record<Person, string>;
export const email = (who: Person) => `${who.toLowerCase()}@threads.test`;

export let database: TestDatabase;
export let deps: ServerDeps;
export let app: ReturnType<typeof createApp>;
export let admin: pg.Client;
export let as: Record<Person, TestBrowser>;
// finance: alice team_admin, bob member, carol builder. marketing: dave team_admin, bob member.
export let finance = "";
export let marketing = "";

export async function signIn(who: Person): Promise<TestBrowser> {
  const b = new TestBrowser(app, PUBLIC_URL);
  const res = await b.post("/api/auth/sign-in/email", { email: email(who), password: PASSWORD });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  return b;
}

export async function activate(b: TestBrowser, teamId: string): Promise<void> {
  const res = await b.put("/v1/me/teams/active", { teamId });
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  b.team = teamId;
}

/** Adds an existing user through a team invitation they accept (KOBE-13). */
export async function addMember(by: TestBrowser, who: Person, role: string): Promise<void> {
  const res = await by.post("/v1/team/invites", { email: email(who), role });
  expect(res.status, JSON.stringify(res.json)).toBe(202);
  const accepted = await as[who].post(`/v1/me/invites/${by.team}/accept`);
  expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
}

export async function newThread(b: TestBrowser, body: object = {}): Promise<string> {
  const res = await b.post("/v1/threads", body);
  expect(res.status, JSON.stringify(res.json)).toBe(201);
  return res.json.thread_id as string;
}

/** Appends Pi entries as the database owner would (writers arrive with KOBE-30/23). */
export async function appendEntries(
  teamId: string,
  threadId: string,
  entries: readonly { id: string; parent: string | null; type?: string; blob?: boolean }[],
): Promise<void> {
  for (const e of entries) {
    await admin.query(
      `INSERT INTO thread_entries (team_id, thread_id, entry_id, parent_id, type, payload, blob_ref)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        teamId,
        threadId,
        e.id,
        e.parent,
        e.type ?? "message",
        JSON.stringify(e.blob ? {} : { message: { role: "user", content: `text ${e.id}` } }),
        e.blob ? `blobs/${e.id}` : null,
      ],
    );
  }
}

export async function addRun(teamId: string, threadId: string, status: string): Promise<string> {
  const id = randomUUID();
  const queued = status === "queued";
  await admin.query(
    `INSERT INTO runs (team_id, id, thread_id, trigger, status, started_at, queue_pos)
     VALUES ($1, $2, $3, 'user', $4, $5, $6)`,
    [teamId, id, threadId, status, queued ? null : new Date(), queued ? 1 : null],
  );
  return id;
}

export async function endRun(teamId: string, runId: string): Promise<void> {
  await admin.query(
    `UPDATE runs SET status = 'cancelled', ended_at = now(), queue_pos = NULL
     WHERE team_id = $1 AND id = $2`,
    [teamId, runId],
  );
}

/** Pool#end resolves before idle connections close; wait so DROP … WITH (FORCE) kills nothing. */
export async function waitForAppSessionsToClose(): Promise<void> {
  const server = new pg.Client({ connectionString: testServerUrl() });
  await server.connect();
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { rows } = await server.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1`,
        [database.appRole],
      );
      if (rows[0]?.n === 0) return;
      if (Date.now() > deadline) throw new Error("app-role sessions still open after 10 s");
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await server.end();
  }
}

/** Registers the shared hooks; call once at the top level of each threads.*.db.test.ts file. */
export function useThreadsApp(): void {
  beforeAll(async () => {
    database = await createTestDatabase(testServerUrl());
    admin = new pg.Client({ connectionString: database.adminUrl });
    await admin.connect();
    deps = createServerDeps({
      isolation: fakeIsolation().probe,
      databaseUrl: database.appUrl,
      publicUrl: PUBLIC_URL,
      authSecret: "t".repeat(48),
      setupToken: "setup-token-for-thread-tests-01",
      trustedProxies: ["127.0.0.1/32"],
      mailer: new MemoryMailer(),
    });
    app = createApp(deps);
    for (const who of PEOPLE) {
      const siteRole = who === "owner" ? "owner" : who === "siteAdmin" ? "admin" : undefined;
      const user = await deps.createUserWithPassword(
        { email: email(who), name: who, password: PASSWORD },
        siteRole ? { siteRole } : {},
      );
      ids[who] = user.id;
    }
    as = Object.fromEntries(
      await Promise.all(PEOPLE.map(async (w) => [w, await signIn(w)])),
    ) as Record<Person, TestBrowser>;

    const create = async (slug: string, adminUser: Person) => {
      const res = await as.owner.post("/v1/site/teams", {
        slug,
        name: slug,
        adminUserId: ids[adminUser],
      });
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      return res.json.team.id as string;
    };
    finance = await create("finance", "alice");
    marketing = await create("marketing", "dave");
    await activate(as.alice, finance);
    await addMember(as.alice, "bob", "member");
    await addMember(as.alice, "carol", "contributor");
    await activate(as.dave, marketing);
    await addMember(as.dave, "bob", "member");
    await activate(as.bob, finance);
    await activate(as.carol, finance);
  });

  afterAll(async () => {
    await deps?.close();
    await admin?.end();
    if (database) {
      await waitForAppSessionsToClose();
      await database.drop();
    }
  });
}
